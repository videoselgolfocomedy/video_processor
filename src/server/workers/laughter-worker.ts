import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import type { LaughterDetectionConfig, LaughterSegment, VolumeCurvePoint } from '@/types/project';

export interface LaughterOptions {
  projectId: string;
  inputPath: string; // ambient audio
  jobId: string;
  config: LaughterDetectionConfig;
}

async function resetLaughterStatus(projectId: string) {
  try {
    const project = await getProject(projectId);
    if (project && project.audio.laughterStatus === 'running') {
      await updateProject(projectId, {
        audio: {
          ...project.audio,
          laughterStatus: 'idle',
          laughterJobId: undefined,
        },
      });
    }
  } catch {
    // Best effort
  }
}

export function runLaughterDetection(options: LaughterOptions): ChildProcess {
  const { projectId, inputPath, jobId, config } = options;
  const audioDir = getProjectDir(projectId, 'audio');
  const outputPath = path.join(audioDir, 'laughter_segments.json');

  const scriptPath = path.join(process.cwd(), 'scripts', 'detect_laughter.py');

  const args = [
    scriptPath,
    '--input', inputPath,
    '--output', outputPath,
    '--threshold', String(config.threshold),
    '--min-duration', String(config.minDurationMs),
    '--merge-gap', String(config.mergeGapMs),
    '--window-ms', String(config.windowMs),
  ];

  console.log(`[Laughter] Starting: python3 ${args.join(' ')}`);

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

    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (typeof parsed.progress === 'number') {
          jobManager.updateProgress(jobId, parsed.progress, parsed.message || '');
        }
      } catch {
        // Not JSON, ignore
      }
    }
  });

  proc.on('close', async (code) => {
    if (code === 0) {
      try {
        const raw = await fs.readFile(outputPath, 'utf-8');
        const result = JSON.parse(raw);

        const segments: LaughterSegment[] = (result.segments || []).map((s: LaughterSegment) => ({
          id: s.id,
          startMs: s.startMs,
          endMs: s.endMs,
          durationMs: s.durationMs,
          peakEnergy: s.peakEnergy,
          avgEnergy: s.avgEnergy,
          label: s.label,
        }));

        const volumeCurve: VolumeCurvePoint[] = (result.volumeCurve || []).map((p: VolumeCurvePoint) => ({
          timeMs: p.timeMs,
          volume: p.volume,
        }));

        const project = await getProject(projectId);
        if (project) {
          await updateProject(projectId, {
            audio: {
              ...project.audio,
              laughterStatus: 'done',
              laughterSegments: segments,
              laughterConfig: config,
              volumeCurve,
            },
          });
        }

        jobManager.completeJob(jobId, {
          totalSegments: segments.length,
          stats: result.stats,
        });
      } catch (err) {
        jobManager.failJob(jobId, `Error parsing results: ${(err as Error).message}`);
      }
    } else {
      const allOutput = (stdoutFull + '\n' + stderrFull).trim();
      const lastLines = allOutput.split('\n').slice(-10).join('\n');
      console.error(`[Laughter] Failed with code ${code}:\n${lastLines}`);
      await resetLaughterStatus(projectId);
      jobManager.failJob(jobId, `Detección falló (code ${code}): ${lastLines.split('\n').pop() || 'Error desconocido'}`);
    }
  });

  proc.on('error', async (err) => {
    console.error(`[Laughter] Failed to start: ${err.message}`);
    await resetLaughterStatus(projectId);
    jobManager.failJob(jobId, `No se pudo iniciar la detección: ${err.message}`);
  });

  return proc;
}
