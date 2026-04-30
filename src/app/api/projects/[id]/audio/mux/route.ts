import { NextRequest, NextResponse } from 'next/server';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';

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
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();
  const { audioFileName } = body;
  if (!audioFileName) {
    return NextResponse.json({ error: 'Missing audioFileName' }, { status: 400 });
  }

  // Find camera video source
  const cameraSource = project.sources.find(
    (s) => s.role === 'camera' && s.type === 'video'
  );
  if (!cameraSource) {
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
    return NextResponse.json({ error: `Audio file not found: ${safeName}` }, { status: 404 });
  }

  // Verify video file exists
  try {
    await fs.access(videoPath);
  } catch {
    return NextResponse.json({ error: `Video file not found: ${cameraSource.storedName}` }, { status: 404 });
  }

  // Ensure export dir exists
  await fs.mkdir(exportDir, { recursive: true });

  // Clean up old muxed files to save disk space
  if (project.sync.muxedVideoPath) {
    const oldName = path.basename(project.sync.muxedVideoPath);
    const oldPath = path.join(exportDir, oldName);
    try { await fs.unlink(oldPath); } catch { /* ignore */ }
  }

  // Determine alignment offset
  // Negative = camera starts before board by |offset| ms
  // Positive = board starts before camera by offset ms
  const alignmentOffsetMs = project.audio.alignmentOffsetMs ?? 0;
  const offsetSec = Math.max(0, alignmentOffsetMs / 1000);

  // Detect if the audio file is already aligned (mix files had offset baked in during mixing)
  const isAlreadyAligned = safeName === 'mixed.wav' || safeName.startsWith('mix_');

  // For mix files with negative alignment (camera started first):
  // The mix covers the overlap region starting at camera time |offset|,
  // so we must seek the video forward to match.
  const videoSeekSec = isAlreadyAligned && alignmentOffsetMs < 0
    ? Math.abs(alignmentOffsetMs / 1000)
    : 0;

  // Probe audio duration to use -t for reliable trimming
  // (-shortest is unreliable with -c:v copy)
  let audioDurationSec = probeAudioDuration(audioPath);
  if (!isAlreadyAligned && offsetSec > 0) {
    // Raw audio: we'll trim by offset, so effective duration is shorter
    audioDurationSec = Math.max(0, audioDurationSec - offsetSec);
  }

  // Create job
  const job = jobManager.createJob(id, 'mux');
  jobManager.startJob(job.id);
  jobManager.updateProgress(job.id, 5,
    `Muxando: video + audio (${Math.round(audioDurationSec)}s)${videoSeekSec > 0 ? ` seek=${videoSeekSec.toFixed(1)}s` : ''}...`
  );

  const ffmpeg = getFFmpegPath();

  // Always copy video stream — preserves original color metadata (incl. HLG tags
  // for iPhone HDR footage) so QuickTime / iOS / modern players tone-map on
  // playback the same way they would for the camera-original file. Re-encoding
  // here with our own tone-map produced a different look than the iOS-built-in
  // tone mapping that the user reviews against — and tagging the output as
  // BT.709 SDR explicitly suppressed QuickTime's HLG handling, making things
  // worse.
  let args: string[];

  if (!isAlreadyAligned && offsetSec > 0) {
    // Raw board/amplified audio: trim audio by offset, limit output to trimmed audio duration
    args = [
      '-i', videoPath,
      '-i', audioPath,
      '-filter_complex', `[1:a]atrim=start=${offsetSec},asetpts=PTS-STARTPTS[aligned]`,
      '-map', '0:v:0',
      '-map', '[aligned]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      ...(audioDurationSec > 0 ? ['-t', String(audioDurationSec)] : ['-shortest']),
      '-y',
      '-progress', 'pipe:1',
      outputPath,
    ];
  } else {
    // Mix/aligned file: seek video to the overlap start point, then mux with audio.
    // -ss goes AFTER -i (output seeking) to avoid keyframe-misalignment that
    // occurs with input seeking + -c:v copy. Input seeking snaps to the nearest
    // keyframe BEFORE the target, causing video to lead audio by up to 30+ seconds.
    args = [
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      ...(videoSeekSec > 0 ? ['-ss', String(videoSeekSec)] : []),
      ...(audioDurationSec > 0 ? ['-t', String(audioDurationSec)] : ['-shortest']),
      '-y',
      '-progress', 'pipe:1',
      outputPath,
    ];
  }

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
      const currentProject = await getProject(id);
      if (currentProject) {
        await updateProject(id, {
          sync: {
            ...currentProject.sync,
            muxedVideoPath: outputPath,
            selectedAudioPath: audioPath,
          },
        });
      }
      jobManager.completeJob(job.id, { outputPath });
    } else {
      const lastLines = stderrLog.trim().split('\n').slice(-5).join('\n');
      jobManager.failJob(job.id, `FFmpeg mux falló (code ${code}):\n${lastLines}`);
    }
  });

  proc.on('error', (err) => {
    jobManager.failJob(job.id, `No se pudo iniciar FFmpeg: ${err.message}`);
  });

  return NextResponse.json({ jobId: job.id });
}
