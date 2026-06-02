import { NextRequest, NextResponse } from 'next/server';
import { spawn, execFileSync, execSync } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';

/** Return available bytes on the filesystem containing `dir`. 0 on failure. */
function getFreeBytes(dir: string): number {
  try {
    // -P forces POSIX output; -k gives 1024-byte blocks (Linux default; macOS
    // df also accepts -k and -P).
    const out = execSync(`df -Pk "${dir}"`, { encoding: 'utf-8', timeout: 5000 });
    const lines = out.trim().split('\n');
    if (lines.length < 2) return 0;
    const cols = lines[lines.length - 1].split(/\s+/);
    // Columns: Filesystem 1024-blocks Used Available Capacity Mounted-on
    const availKb = parseInt(cols[3], 10);
    return Number.isFinite(availKb) ? availKb * 1024 : 0;
  } catch {
    return 0;
  }
}

/** Best-effort file size in bytes. 0 on failure. */
async function fileSize(p: string): Promise<number> {
  try {
    const s = await fs.stat(p);
    return s.size;
  } catch {
    return 0;
  }
}

function getFFmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
}

function getFFprobePath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffprobe-static').path as string;
  } catch {
    return 'ffprobe';
  }
}

/**
 * Find the nearest video keyframe at OR AFTER `targetSec`.
 *
 * Why "at or after": when we have a negative alignment offset (camera
 * started before audio) we want to seek video forward to where audio
 * begins. Input `-ss` snaps to a keyframe, and a keyframe BEFORE the
 * target would leave video content that has no matching audio. Picking
 * the keyframe AT OR AFTER lets us atrim the small leading slice off the
 * audio to match (typically <5 s).
 *
 * Returns the keyframe pts time in seconds. Falls back to targetSec if
 * probing fails or no keyframe is found in the window.
 */
function findKeyframeAtOrAfter(videoPath: string, targetSec: number): number {
  try {
    const ffprobe = getFFprobePath();
    // Scan a 30 s window starting at the target; iPhone HEVC keyframes are
    // typically 1–3 s apart so 30 s is way more than enough.
    const out = execFileSync(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0',
      '-read_intervals', `${targetSec}%+30`,
      videoPath,
    ], { encoding: 'utf-8', timeout: 30_000 });

    for (const line of out.split('\n')) {
      const parts = line.split(',');
      if (parts.length < 2) continue;
      const pts = parseFloat(parts[0]);
      const flags = parts[1] || '';
      if (Number.isFinite(pts) && pts >= targetSec && flags.includes('K')) {
        return pts;
      }
    }
    return targetSec;
  } catch {
    return targetSec;
  }
}

/** Get audio file duration in seconds using ffprobe */
function probeAudioDuration(filePath: string): number {
  try {
    const ffprobe = getFFprobePath();
    const output = execFileSync(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ], { encoding: 'utf-8', timeout: 10000 });
    const dur = parseFloat(output.trim());
    return isNaN(dur) ? 0 : dur;
  } catch {
    return 0;
  }
}

/**
 * POST /api/projects/[id]/audio/mux
 * Mux a selected audio file into the camera video (copy video, encode audio as AAC).
 *
 * Audio alignment:
 * - Mix files (mixed.wav, mix_*) are already aligned with camera time 0
 *   → only need to trim video if user wants to skip dead time
 * - Raw board/amplified files need alignmentOffsetMs applied to the audio
 *   to sync with camera
 *
 * Body: { audioFileName: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    console.error(`[mux] 404: project not found id=${id}`);
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();
  const { audioFileName } = body;
  if (!audioFileName) {
    console.error(`[mux] 400: missing audioFileName for project ${id}`);
    return NextResponse.json({ error: 'Missing audioFileName' }, { status: 400 });
  }

  // Find camera video source
  const cameraSource = project.sources.find(
    (s) => s.role === 'camera' && s.type === 'video'
  );
  if (!cameraSource) {
    console.error(`[mux] 400: no camera source in project ${id}. sources=${project.sources.map(s => `${s.role}/${s.type}`).join(',')}`);
    return NextResponse.json({ error: 'No hay video de cámara en el proyecto' }, { status: 400 });
  }

  // Resolve paths
  const audioDir = getProjectDir(id, 'audio');
  const sourceDir = getProjectDir(id, 'source');
  const exportDir = getProjectDir(id, 'export');
  const safeName = path.basename(audioFileName);
  const audioPath = path.join(audioDir, safeName);
  const videoPath = path.join(sourceDir, cameraSource.storedName);
  const outputPath = path.join(exportDir, `muxed_${Date.now()}.mp4`);

  // Verify audio file exists
  try {
    await fs.access(audioPath);
  } catch {
    console.error(`[mux] 404: audio file missing at ${audioPath}`);
    return NextResponse.json({
      error: `Audio no encontrado en disco: ${safeName}. Se esperaba en ${audioPath}.`,
    }, { status: 404 });
  }

  // Verify video file exists
  try {
    await fs.access(videoPath);
  } catch {
    console.error(`[mux] 404: video file missing at ${videoPath}`);
    return NextResponse.json({
      error: `Video de cámara no encontrado en disco: ${cameraSource.storedName}. ` +
        `Se esperaba en ${videoPath}. ` +
        `Si restauraste el proyecto, importa el zip de media o copia el archivo a esa ruta.`,
    }, { status: 404 });
  }

  // Ensure export dir exists
  await fs.mkdir(exportDir, { recursive: true });

  // Clean up ALL muxed files in export/, not just the one tracked in
  // project.sync.muxedVideoPath. Previous mux failures (e.g. disk full mid-
  // write) leave orphaned partial files that aren't referenced anywhere —
  // they pile up at multi-GB each and silently fill the disk. Since only one
  // muxed file should ever exist per project, blast them all.
  try {
    const entries = await fs.readdir(exportDir);
    for (const entry of entries) {
      if (entry.startsWith('muxed_') && entry.endsWith('.mp4')) {
        await fs.unlink(path.join(exportDir, entry)).catch(() => { /* ignore */ });
      }
    }
  } catch { /* export dir might not have anything to clean */ }

  // Pre-flight disk space check. With -c:v copy the output is roughly
  // (video bytes) + (encoded audio bytes ≈ audio duration × 24 KB/s for AAC
  // at 192 kbps). We require 1.2× that to leave a safety margin for FFmpeg's
  // intermediate moov atom and OS file caches.
  const videoBytes = await fileSize(videoPath);
  const audioBytes = await fileSize(audioPath);
  const estimatedOutputBytes = Math.round((videoBytes + audioBytes) * 1.2);
  const freeBytes = getFreeBytes(exportDir);
  if (freeBytes > 0 && estimatedOutputBytes > 0 && freeBytes < estimatedOutputBytes) {
    const gb = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1);
    console.error(`[mux] 507: insufficient disk space. free=${gb(freeBytes)}GB, ` +
      `estimated=${gb(estimatedOutputBytes)}GB at ${exportDir}`);
    return NextResponse.json({
      error: `Espacio insuficiente en disco. Libres: ${gb(freeBytes)} GB, ` +
        `se estiman ${gb(estimatedOutputBytes)} GB para el muxed. ` +
        `Borra videos/renders antiguos antes de continuar.`,
    }, { status: 507 });
  }

  // Alignment offset convention:
  //   Positive = board started before camera by offset ms (audio is "ahead",
  //              the first offset ms of audio happened before the camera
  //              started recording)
  //   Negative = camera started before board by |offset| ms (camera is ahead,
  //              the first |offset| ms of video has no matching audio)
  const alignmentOffsetMs = project.audio.alignmentOffsetMs ?? 0;
  const isAlreadyAligned = safeName === 'mixed.wav' || safeName.startsWith('mix_');

  // Three cases we need to handle precisely:
  //
  // A) alignmentOffsetMs > 0  (board first)
  //    Raw audio: atrim the leading offsetSec of audio so it lines up with
  //               video t=0. Existing behaviour — works.
  //    Mix audio: the offset was already baked into the mix at mix-preview
  //               time, so no atrim needed. Existing behaviour — works.
  //
  // B) alignmentOffsetMs < 0  (camera first by |offset|)
  //    For BOTH raw and mix the audio's t=0 corresponds to camera time
  //    |offset|, so the video stream needs to start playing from t=|offset|.
  //    The previous implementation used `-ss <|offset|>` AFTER the inputs
  //    (an output seek) which sliced BOTH the video AND the audio by the
  //    same amount — exactly the desync the user is reporting: audio plays
  //    from its own t=|offset| (i.e. ~53 s in) instead of its t=0.
  //
  //    Fix: input-seek the video to the nearest keyframe AT-OR-AFTER
  //    |offset|, then atrim the small leading delta off the audio. Input
  //    -ss is fast and exact within the keyframe grid; using a keyframe
  //    AT-OR-AFTER (rather than at-or-before) means the residual delta is
  //    a positive number we can atrim cleanly — the alternative would have
  //    needed `adelay` and would have left an audible mute at the start.
  //
  // C) alignmentOffsetMs === 0
  //    Straight mux. No filter, no seek.
  const offsetSecPositive = Math.max(0, alignmentOffsetMs / 1000);
  const negTargetSec = alignmentOffsetMs < 0 ? Math.abs(alignmentOffsetMs / 1000) : 0;
  const videoInputSeekSec = negTargetSec > 0
    ? findKeyframeAtOrAfter(videoPath, negTargetSec)
    : 0;
  const audioTrimSec = (!isAlreadyAligned && offsetSecPositive > 0 ? offsetSecPositive : 0)
                     + (negTargetSec > 0 ? videoInputSeekSec - negTargetSec : 0);

  // Probe audio duration to use -t for reliable trimming
  // (-shortest is unreliable with -c:v copy)
  let audioDurationSec = probeAudioDuration(audioPath);
  if (audioTrimSec > 0) {
    audioDurationSec = Math.max(0, audioDurationSec - audioTrimSec);
  }

  // Create job
  const job = jobManager.createJob(id, 'mux');
  jobManager.startJob(job.id);
  jobManager.updateProgress(job.id, 5,
    `Muxando: video + audio (${Math.round(audioDurationSec)}s)` +
    `${videoInputSeekSec > 0 ? ` videoSeek=${videoInputSeekSec.toFixed(2)}s` : ''}` +
    `${audioTrimSec > 0 ? ` audioTrim=${audioTrimSec.toFixed(2)}s` : ''}...`
  );
  console.log(`[mux] alignmentOffsetMs=${alignmentOffsetMs} isAlreadyAligned=${isAlreadyAligned} ` +
    `videoInputSeek=${videoInputSeekSec.toFixed(3)}s audioTrim=${audioTrimSec.toFixed(3)}s ` +
    `audioDur=${audioDurationSec.toFixed(2)}s`);

  const ffmpeg = getFFmpegPath();

  // Always copy video stream — preserves original color metadata (incl. HLG tags
  // for iPhone HDR footage) so QuickTime / iOS / modern players tone-map on
  // playback the same way they would for the camera-original file. Re-encoding
  // here with our own tone-map produced a different look than the iOS-built-in
  // tone mapping that the user reviews against — and tagging the output as
  // BT.709 SDR explicitly suppressed QuickTime's HLG handling, making things
  // worse.
  const args: string[] = [];

  // Video input — input-seek if we need to skip the silent leader.
  if (videoInputSeekSec > 0) {
    args.push('-ss', String(videoInputSeekSec));
  }
  args.push('-i', videoPath);
  args.push('-i', audioPath);

  if (audioTrimSec > 0) {
    args.push(
      '-filter_complex', `[1:a]atrim=start=${audioTrimSec.toFixed(6)},asetpts=PTS-STARTPTS[aligned]`,
      '-map', '0:v:0',
      '-map', '[aligned]',
    );
  } else {
    args.push('-map', '0:v:0', '-map', '1:a:0');
  }

  args.push(
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    ...(audioDurationSec > 0 ? ['-t', String(audioDurationSec)] : ['-shortest']),
    '-y',
    '-progress', 'pipe:1',
    outputPath,
  );

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  jobManager.setProcess(job.id, proc);

  let duration = 0;
  let stderrLog = '';

  proc.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    stderrLog += text;
    if (stderrLog.length > 4096) stderrLog = stderrLog.slice(-4096);
    const match = text.match(/Duration:\s*(\d+):(\d+):(\d+)/);
    if (match) {
      duration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
    }
  });

  proc.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.startsWith('out_time_us=')) {
        const us = parseInt(line.split('=')[1], 10);
        if (duration > 0) {
          const percent = Math.min(95, (us / 1_000_000 / duration) * 100);
          jobManager.updateProgress(job.id, Math.round(percent), 'Muxando audio en video...');
        }
      }
    }
  });

  proc.on('close', async (code) => {
    if (code === 0) {
      // Probe the actual muxed output duration. Used by the transcription
      // page to size the timeline; without this the page falls back to the
      // board audio's duration (98 min) and shows a frozen-frame tail past
      // where the video stream actually ends.
      const muxedDurationSec = probeAudioDuration(outputPath);
      const currentProject = await getProject(id);
      if (currentProject) {
        // audioTrimSec is how much we sliced off the start of the standalone
        // audio file to align with the keyframe-snapped video seek. The same
        // amount must be applied to Compose's a1 sourceInMs so the player
        // doesn't drift by this fraction-of-a-second.
        await updateProject(id, {
          sync: {
            ...currentProject.sync,
            muxedVideoPath: outputPath,
            muxedDurationMs: muxedDurationSec > 0
              ? Math.round(muxedDurationSec * 1000)
              : undefined,
            muxedAudioOffsetMs: audioTrimSec > 0
              ? Math.round(audioTrimSec * 1000)
              : 0,
            selectedAudioPath: audioPath,
          },
        });
      }
      jobManager.completeJob(job.id, { outputPath, durationMs: muxedDurationSec * 1000 });
    } else {
      // Delete the partial output. FFmpeg writes the bulk of the file before
      // writing the moov atom in the trailer — on disk-full or any other
      // mid-write failure, what's left is a multi-GB unplayable file. If we
      // don't remove it, repeated retries fill the disk further (this is
      // exactly what produced the 3×muxed_*.mp4 garbage we just cleaned up).
      await fs.unlink(outputPath).catch(() => { /* ignore */ });

      const lastLines = stderrLog.trim().split('\n').slice(-5).join('\n');
      console.error(`[mux] ffmpeg failed code=${code}, removed partial output. tail:\n${lastLines}`);
      jobManager.failJob(job.id, `FFmpeg mux falló (code ${code}):\n${lastLines}`);
    }
  });

  proc.on('error', async (err) => {
    await fs.unlink(outputPath).catch(() => { /* ignore */ });
    jobManager.failJob(job.id, `No se pudo iniciar FFmpeg: ${err.message}`);
  });

  return NextResponse.json({ jobId: job.id });
}
