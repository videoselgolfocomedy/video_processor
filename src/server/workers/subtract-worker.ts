import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import type { VoiceSubtractionConfig } from '@/types/project';

const execFileAsync = promisify(execFile);

function getFFmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
}

export interface SubtractOptions {
  projectId: string;
  micPath: string;      // desk mic audio (may be mp3, wav, etc.)
  cameraPath: string;   // camera audio (wav from extraction)
  jobId: string;
  config: VoiceSubtractionConfig;
}

async function resetSubtractionStatus(projectId: string) {
  try {
    const project = await getProject(projectId);
    if (project && project.audio.subtractionStatus === 'running') {
      await updateProject(projectId, {
        audio: {
          ...project.audio,
          subtractionStatus: 'idle',
          subtractionJobId: undefined,
        },
      });
    }
  } catch {
    // Best effort
  }
}

/**
 * Convert any audio file to mono 48kHz WAV using ffmpeg.
 * Returns the output path. If already WAV, copies as-is to normalize format.
 */
async function ensureWav(inputPath: string, outputDir: string, label: string): Promise<string> {
  const outputPath = path.join(outputDir, `${label}_converted.wav`);
  const ffmpeg = getFFmpegPath();

  await execFileAsync(ffmpeg, [
    '-y',
    '-i', inputPath,
    '-ar', '48000',
    '-ac', '1',
    '-sample_fmt', 's16',
    outputPath,
  ]);

  return outputPath;
}

export async function runSubtraction(options: SubtractOptions): Promise<ChildProcess> {
  const { projectId, micPath, cameraPath, jobId, config } = options;
  const audioDir = getProjectDir(projectId, 'audio');

  // Name output file based on method + parameters for easy comparison
  const paramSuffix = config.method === 'spectral'
    ? `spectral_a${config.alpha}_f${config.floor}`
    : `nlms_l${config.filterLength}_m${config.mu}`;
  const outputPath = path.join(audioDir, `ambient_${paramSuffix}.wav`);
  const scriptPath = path.join(process.cwd(), 'scripts', 'subtract_voice.py');

  // Convert inputs to WAV (the Python script only reads WAV via the wave module)
  jobManager.updateProgress(jobId, 2, 'Convirtiendo audio de mesa a WAV...');
  let micWav: string;
  try {
    micWav = await ensureWav(micPath, audioDir, 'mic');
  } catch (err) {
    await resetSubtractionStatus(projectId);
    jobManager.failJob(jobId, `Error convirtiendo audio de mesa: ${(err as Error).message}`);
    // Return a dummy process — job is already failed
    const dummy = spawn('echo', ['failed']);
    return dummy;
  }

  jobManager.updateProgress(jobId, 5, 'Convirtiendo audio de cámara a WAV...');
  let cameraWav: string;
  try {
    cameraWav = await ensureWav(cameraPath, audioDir, 'camera');
  } catch (err) {
    await resetSubtractionStatus(projectId);
    jobManager.failJob(jobId, `Error convirtiendo audio de cámara: ${(err as Error).message}`);
    const dummy = spawn('echo', ['failed']);
    return dummy;
  }

  const alignmentDataPath = path.join(audioDir, 'alignment_data.json');

  const args = [
    scriptPath,
    '--mic', micWav,
    '--camera', cameraWav,
    '--output', outputPath,
    '--method', config.method,
    '--alignment-out', alignmentDataPath,
  ];

  if (config.method === 'spectral') {
    args.push('--alpha', String(config.alpha));
    args.push('--floor', String(config.floor));
  } else {
    args.push('--filter-length', String(config.filterLength));
    args.push('--mu', String(config.mu));
  }

  console.log(`[Subtract] Starting: python3 ${args.join(' ')}`);

  const proc = spawn('python3', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  jobManager.setProcess(jobId, proc);

  let stderrBuffer = '';
  let stdoutFull = '';
  let stderrFull = '';

  proc.stdout?.on('data', (data: Buffer) => {
    stdoutFull += data.toString();
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stderrBuffer += chunk;
    stderrFull += chunk;

    // Parse progress JSON from stderr
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (typeof parsed.progress === 'number') {
          // Remap 0-100 from script to 5-100 (first 5% was conversion)
          const remapped = 5 + Math.round(parsed.progress * 0.95);
          jobManager.updateProgress(jobId, remapped, parsed.message || '');
        }
      } catch {
        // Not JSON, ignore
      }
    }
  });

  proc.on('close', async (code) => {
    // Cleanup temp converted files
    try { await fs.unlink(micWav); } catch { /* ignore */ }
    try { await fs.unlink(cameraWav); } catch { /* ignore */ }

    if (code === 0) {
      try {
        await fs.access(outputPath);

        // Parse offset from Python script stdout JSON
        let alignmentOffsetMs: number | undefined;
        try {
          const result = JSON.parse(stdoutFull.trim());
          if (typeof result.offset_ms === 'number') {
            alignmentOffsetMs = result.offset_ms;
          }
        } catch { /* ignore parse error */ }

        const project = await getProject(projectId);
        if (project) {
          await updateProject(projectId, {
            audio: {
              ...project.audio,
              subtractionStatus: 'done',
              subtractionConfig: config,
              ambientPath: outputPath,
              alignmentOffsetMs,
            },
          });
        }

        jobManager.completeJob(jobId, { ambientPath: outputPath, alignmentOffsetMs });
      } catch (err) {
        jobManager.failJob(jobId, `Output file not found: ${(err as Error).message}`);
      }
    } else {
      const allOutput = (stdoutFull + '\n' + stderrFull).trim();
      const lastLines = allOutput.split('\n').slice(-10).join('\n');
      console.error(`[Subtract] Failed with code ${code}:\n${lastLines}`);
      await resetSubtractionStatus(projectId);
      jobManager.failJob(jobId, `Sustracción falló (code ${code}): ${lastLines.split('\n').pop() || 'Error desconocido'}`);
    }
  });

  proc.on('error', async (err) => {
    console.error(`[Subtract] Failed to start: ${err.message}`);
    await resetSubtractionStatus(projectId);
    jobManager.failJob(jobId, `No se pudo iniciar la sustracción: ${err.message}`);
  });

  return proc;
}
