import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';

function getFFToolsDirs(): string[] {
  const dirs: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dirs.push(path.dirname(require('ffmpeg-static') as string));
  } catch {
    dirs.push(path.join(process.cwd(), 'node_modules', 'ffmpeg-static'));
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dirs.push(path.dirname(require('ffprobe-static').path as string));
  } catch {
    dirs.push(path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin'));
  }
  return Array.from(new Set(dirs));
}

async function resetDemucsStatus(projectId: string) {
  try {
    const project = await getProject(projectId);
    if (project && project.audio.demucsStatus === 'running') {
      await updateProject(projectId, {
        audio: {
          ...project.audio,
          demucsStatus: 'idle',
          demucsJobId: undefined,
          demucsSourceId: undefined,
        },
      });
    }
  } catch {
    // Best effort
  }
}

export interface DemucsOptions {
  projectId: string;
  inputPath: string;
  jobId: string;
  twoStems?: boolean;
  model?: string;
}

export function runDemucs(options: DemucsOptions): ChildProcess {
  const { projectId, inputPath, jobId, twoStems = true, model = 'htdemucs' } = options;
  const audioDir = getProjectDir(projectId, 'audio');
  const outputDir = path.join(audioDir, 'demucs_output');

  const args = [
    '-m', 'demucs',
    '--out', outputDir,
    '-n', model,
  ];

  if (twoStems) {
    args.push('--two-stems', 'vocals');
  }

  args.push(inputPath);

  // Add ffmpeg-static + ffprobe-static to PATH so Demucs can find them
  const ffDirs = getFFToolsDirs();
  const env = { ...process.env };
  if (ffDirs.length > 0) {
    env.PATH = `${ffDirs.join(':')}:${env.PATH || ''}`;
  }

  console.log(`[Demucs] fftools PATH: ${ffDirs.join(':')}`);
  console.log(`[Demucs] Starting: python3 ${args.join(' ')}`);

  const proc = spawn('python3', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
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

    // Parse Demucs progress from stderr
    // Demucs outputs lines like: "  3%|..." or progress bars
    const lines = stderrBuffer.split(/[\r\n]+/);
    stderrBuffer = lines.pop() || '';

    for (const line of lines) {
      const percentMatch = line.match(/(\d+)%\|/);
      if (percentMatch) {
        const percent = parseInt(percentMatch[1], 10);
        jobManager.updateProgress(jobId, percent, `Separando pistas... ${percent}%`);
      }
    }
  });

  proc.on('close', async (code) => {
    if (code === 0) {
      try {
        // Find output files
        const modelDir = path.join(outputDir, model);
        const inputBasename = path.basename(inputPath, path.extname(inputPath));
        const stemDir = path.join(modelDir, inputBasename);

        const vocalsPath = path.join(stemDir, 'vocals.wav');
        const otherPath = path.join(stemDir, 'no_vocals.wav');

        // Verify files exist
        await fs.access(vocalsPath);
        await fs.access(otherPath);

        // Update project
        const project = await getProject(projectId);
        if (project) {
          await updateProject(projectId, {
            audio: {
              ...project.audio,
              demucsStatus: 'done',
              stems: {
                vocals: vocalsPath,
                other: otherPath,
              },
            },
          });
        }

        jobManager.completeJob(jobId, {
          vocalsPath,
          otherPath,
        });
      } catch (err) {
        jobManager.failJob(jobId, `Demucs output files not found: ${(err as Error).message}`);
      }
    } else {
      const allOutput = (stdoutFull + '\n' + stderrFull).trim();
      const lastLines = allOutput.split('\n').slice(-20).join('\n');
      console.error(`[Demucs] Failed with code ${code}:\n${lastLines}`);
      await resetDemucsStatus(projectId);
      // Find the actual error line (skip warnings)
      const errorLine = allOutput.split('\n')
        .filter(l => !l.includes('UserWarning') && !l.includes('warnings.warn') && l.trim())
        .pop() || 'Error desconocido';
      jobManager.failJob(jobId, `Demucs falló (code ${code}): ${errorLine}`);
    }
  });

  proc.on('error', async (err) => {
    console.error(`[Demucs] Failed to start: ${err.message}`);
    await resetDemucsStatus(projectId);
    jobManager.failJob(jobId, `No se pudo iniciar Demucs: ${err.message}`);
  });

  return proc;
}
