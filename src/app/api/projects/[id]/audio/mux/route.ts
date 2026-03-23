import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
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
  const alignmentOffsetMs = project.audio.alignmentOffsetMs ?? 0;
  const offsetSec = Math.max(0, alignmentOffsetMs / 1000);

  // Detect if the audio file is already aligned with camera time 0
  // Mix files (mixed.wav, mix_*) have the offset already baked in
  const isAlreadyAligned = safeName === 'mixed.wav' || safeName.startsWith('mix_');

  // Create job
  const job = jobManager.createJob(id, 'mux');
  jobManager.startJob(job.id);
  jobManager.updateProgress(job.id, 5, 'Iniciando muxado de audio en video...');

  // Build FFmpeg args:
  // - `-ss` before `-i` on video for fast seek (input-level seek, no re-encode)
  // - For mix files: audio starts at camera time 0, so video must also start at 0
  //   BUT `-shortest` trims the output to the audio duration
  // - For raw board audio: trim audio by offset, video starts at 0
  // - `-t` limits output to audio duration for reliable trimming
  const ffmpeg = getFFmpegPath();

  let args: string[];

  if (!isAlreadyAligned && offsetSec > 0) {
    // Raw board/amplified audio: trim audio by offset to align with camera
    args = [
      '-i', videoPath,
      '-i', audioPath,
      '-filter_complex', `[1:a]atrim=start=${offsetSec},asetpts=PTS-STARTPTS[aligned]`,
      '-map', '0:v:0',
      '-map', '[aligned]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-y',
      '-progress', 'pipe:1',
      outputPath,
    ];
  } else {
    // Mix file: audio is already aligned with camera time 0.
    // Use -shortest to trim output to audio length (mix is shorter than camera video).
    args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',
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
