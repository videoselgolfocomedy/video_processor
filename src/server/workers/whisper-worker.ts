import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { convertForWhisper } from '@/server/ffmpeg-wrapper';
import type { SubtitleSegment } from '@/types/project';

const execFileAsync = promisify(execFile);

export interface WhisperOptions {
  projectId: string;
  jobId: string;
  language: string;
  model: string;
}

/** Resolve which audio file whisper will transcribe, in priority order.
 *  1. Audio selected in Sync (the one in the final video)
 *  2. Generated mix (mixed.wav)
 *  3. Extracted tracks
 *  4. Direct audio source
 *
 *  selectedAudioPath can be a filename (from UI) or a full path (from mux API).
 */
export function resolveTranscriptionAudio(project: {
  sync: { selectedAudioPath?: string | null; mixedAudioPath?: string | null };
  audio: {
    stems?: { vocals?: string };
    extractedTracks: { path: string }[];
    boardAudioPath?: string;
  };
  sources: { type: string; role: string; storedName: string }[];
}, sourceDir: string, audioDir?: string): { path: string; label: string } | null {
  // Priority 1: audio selected in Sync
  if (project.sync.selectedAudioPath) {
    const sel = project.sync.selectedAudioPath;
    // If it's just a filename (no path separator), resolve against audio dir
    const isFullPath = sel.includes('/') || sel.includes('\\');
    const resolvedPath = isFullPath ? sel : (audioDir ? path.join(audioDir, sel) : sel);
    const name = sel.split('/').pop() || sel;
    return { path: resolvedPath, label: `Audio de Sync: ${name}` };
  }
  // Priority 2: generated mix
  if (project.sync.mixedAudioPath) {
    const name = project.sync.mixedAudioPath.split('/').pop() || 'mixed.wav';
    return { path: project.sync.mixedAudioPath, label: `Audio mezclado: ${name}` };
  }
  // Priority 3: extracted tracks
  if (project.audio.extractedTracks.length > 0) {
    const track = project.audio.extractedTracks[0];
    const name = track.path.split('/').pop() || 'audio';
    return { path: track.path, label: `Pista extraída: ${name}` };
  }
  // Priority 4: direct audio source file
  const audioSource = project.sources.find((s) => s.type === 'audio');
  if (audioSource) {
    return {
      path: path.join(sourceDir, audioSource.storedName),
      label: `Fuente de audio: ${audioSource.storedName}`,
    };
  }
  return null;
}

export async function runWhisperTranscription(options: WhisperOptions): Promise<ChildProcess | null> {
  const { projectId, jobId, language, model } = options;

  const project = await getProject(projectId);
  if (!project) {
    jobManager.failJob(jobId, 'Project not found');
    return null;
  }

  // Find the audio to transcribe
  const sourceDir = getProjectDir(projectId, 'source');
  const audioDir = getProjectDir(projectId, 'audio');
  const resolved = resolveTranscriptionAudio(project, sourceDir, audioDir);

  if (!resolved) {
    jobManager.failJob(jobId, 'No hay audio disponible para transcribir. Genera una mezcla en Sync primero.');
    return null;
  }

  const audioPath = resolved.path;

  const transcriptionDir = getProjectDir(projectId, 'transcription');

  // Convert to 16kHz WAV for whisper
  const whisperInput = path.join(transcriptionDir, 'whisper_input.wav');
  jobManager.updateProgress(jobId, 5, 'Converting audio for Whisper...');

  try {
    await convertForWhisper(audioPath, whisperInput);
  } catch (err) {
    jobManager.failJob(jobId, `Audio conversion failed: ${(err as Error).message}`);
    return null;
  }

  // Get audio duration for progress estimation
  let audioDurationSec = 0;
  try {
    const ffmpegBinForProbe = (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('ffmpeg-static') as string;
      } catch { return 'ffprobe'; }
    })();
    const ffprobeCmd = ffmpegBinForProbe.replace(/ffmpeg$/, 'ffprobe');
    const probeResult = await execFileAsync(ffprobeCmd, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', whisperInput,
    ], { timeout: 10000 }).catch(() => ({ stdout: '0' }));
    audioDurationSec = parseFloat(probeResult.stdout) || 0;
  } catch { /* ignore */ }

  // Build whisper CLI arguments
  const whisperArgs = [
    whisperInput,
    '--model', model,
    '--output_format', 'json',
    '--word_timestamps', 'True',
    '--verbose', 'True',
    '--output_dir', transcriptionDir,
  ];

  if (language !== 'auto') {
    whisperArgs.push('--language', language);
  }

  jobManager.updateProgress(jobId, 10, 'Buscando whisper...');

  // Build extended PATH:
  // 1. ffmpeg-static dir (whisper internally calls ffmpeg to load audio)
  // 2. pip user-install locations (where whisper binary lives)
  let ffmpegDir = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegBin = require('ffmpeg-static') as string;
    ffmpegDir = path.dirname(ffmpegBin);
  } catch { /* ignore */ }

  const home = process.env.HOME || '';
  const extraPaths = [
    ffmpegDir,
    path.join(home, 'Library', 'Python', '3.9', 'bin'),
    path.join(home, 'Library', 'Python', '3.10', 'bin'),
    path.join(home, 'Library', 'Python', '3.11', 'bin'),
    path.join(home, 'Library', 'Python', '3.12', 'bin'),
    path.join(home, 'Library', 'Python', '3.13', 'bin'),
    path.join(home, '.local', 'bin'),
  ].filter(Boolean);
  const extendedPath = [...extraPaths, process.env.PATH || ''].join(':');
  const envWithPath = { ...process.env, PATH: extendedPath };

  // Try to find whisper binary: direct CLI (with extended PATH), then python3 -m whisper
  let spawnCmd: string;
  let spawnArgs: string[];

  try {
    await execFileAsync('whisper', ['--help'], { timeout: 5000, env: envWithPath });
    spawnCmd = 'whisper';
    spawnArgs = whisperArgs;
  } catch {
    // Try python3 -m whisper
    try {
      await execFileAsync('python3', ['-m', 'whisper', '--help'], { timeout: 5000 });
      spawnCmd = 'python3';
      spawnArgs = ['-m', 'whisper', ...whisperArgs];
    } catch {
      jobManager.failJob(jobId,
        'Whisper no encontrado. Instalar con: pip3 install openai-whisper'
      );
      return null;
    }
  }

  const modelLabel = model.charAt(0).toUpperCase() + model.slice(1);
  jobManager.updateProgress(jobId, 10, `Iniciando whisper (modelo ${modelLabel})...`);

  const proc = spawn(spawnCmd, spawnArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: envWithPath,
  });

  jobManager.setProcess(jobId, proc);

  let stderrBuffer = '';
  let stderrFull = '';
  const startTime = Date.now();
  let lastProgressUpdate = Date.now();
  let lastPercent = 10;

  // Heartbeat: update message every 15s so user knows it's alive
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    // Only update if no real progress came recently
    if (Date.now() - lastProgressUpdate > 10000) {
      jobManager.updateProgress(jobId, lastPercent,
        `Transcribiendo con ${modelLabel}... (${timeStr} transcurridos)`
      );
    }
  }, 15000);

  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    stderrFull += text;
    stderrBuffer += text;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';

    for (const line of lines) {
      // Parse tqdm progress: "42%|████"
      const percentMatch = line.match(/(\d+)%\|/);
      if (percentMatch) {
        const percent = 10 + parseInt(percentMatch[1], 10) * 0.85;
        lastPercent = percent;
        lastProgressUpdate = Date.now();
        jobManager.updateProgress(jobId, percent, `Transcribiendo... ${Math.round(percent)}%`);
        continue;
      }

      // Parse verbose output: "[00:12.340 --> 00:15.680]  Some text here"
      const timestampMatch = line.match(/\[(\d+):(\d+\.\d+)\s*-->\s*(\d+):(\d+\.\d+)\]/);
      if (timestampMatch && audioDurationSec > 0) {
        const endMin = parseInt(timestampMatch[3], 10);
        const endSec = parseFloat(timestampMatch[4]);
        const currentSec = endMin * 60 + endSec;
        const percent = 10 + (currentSec / audioDurationSec) * 85;
        const clampedPercent = Math.min(95, Math.max(lastPercent, percent));
        lastPercent = clampedPercent;
        lastProgressUpdate = Date.now();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        jobManager.updateProgress(jobId, clampedPercent,
          `Transcribiendo... ${Math.round(clampedPercent)}% (${timeStr})`
        );
        continue;
      }

      // Detect model loading messages
      if (line.includes('Detecting language') || line.includes('language:')) {
        lastProgressUpdate = Date.now();
        jobManager.updateProgress(jobId, 12, `Detectando idioma...`);
      } else if (line.includes('Loading model') || line.includes('loaded')) {
        lastProgressUpdate = Date.now();
        jobManager.updateProgress(jobId, 11, `Cargando modelo ${modelLabel}...`);
      }
    }
  });

  proc.on('close', async (code) => {
    clearInterval(heartbeat);

    if (code !== 0) {
      const lastStderr = stderrFull.trim().split('\n').slice(-3).join(' | ');
      jobManager.failJob(jobId, `Whisper exited with code ${code}: ${lastStderr}`);
      return;
    }

    try {
      // Find the JSON output (whisper names it after the input file stem)
      const jsonPath = path.join(transcriptionDir, 'whisper_input.json');

      // Check if file exists before reading
      try {
        await fs.access(jsonPath);
      } catch {
        // List what whisper actually produced for diagnostics
        const files = await fs.readdir(transcriptionDir).catch(() => []);
        const lastStderr = stderrFull.trim().split('\n').slice(-5).join(' | ');
        jobManager.failJob(jobId,
          `Whisper terminó pero no generó whisper_input.json. ` +
          `Archivos en transcription/: [${files.join(', ')}]. ` +
          `Stderr: ${lastStderr}`
        );
        return;
      }

      const jsonData = await fs.readFile(jsonPath, 'utf-8');
      const whisperResult = JSON.parse(jsonData);

      // Convert to our SubtitleSegment format
      const segments: SubtitleSegment[] = (whisperResult.segments || []).map(
        (seg: {
          start: number;
          end: number;
          text: string;
          words?: Array<{ word: string; start: number; end: number }>;
        }) => ({
          id: uuidv4(),
          startMs: Math.round(seg.start * 1000),
          endMs: Math.round(seg.end * 1000),
          text: seg.text.trim(),
          words: seg.words?.map(
            (w: { word: string; start: number; end: number }) => ({
              text: w.word.trim(),
              startMs: Math.round(w.start * 1000),
              endMs: Math.round(w.end * 1000),
            })
          ),
        })
      );

      // Update project
      const currentProject = await getProject(projectId);
      if (currentProject) {
        await updateProject(projectId, {
          transcription: {
            ...currentProject.transcription,
            status: 'done',
            language: whisperResult.language || language,
            model,
            segments,
          },
        });
      }

      jobManager.completeJob(jobId, {
        segmentCount: segments.length,
        language: whisperResult.language || language,
      });
    } catch (err) {
      jobManager.failJob(
        jobId,
        `Error al procesar transcripción: ${(err as Error).message}`
      );
    }
  });

  proc.on('error', (err) => {
    clearInterval(heartbeat);
    jobManager.failJob(jobId, `Failed to start Whisper: ${err.message}`);
  });

  return proc;
}
