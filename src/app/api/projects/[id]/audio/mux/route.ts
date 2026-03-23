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

  // Create job
  const job = jobManager.createJob(id, 'mux');
  jobManager.startJob(job.id);
  jobManager.updateProgress(job.id, 5, 'Iniciando muxado de audio en video...');

  // Run FFmpeg with spawn (not execFile) to avoid maxBuffer overflow on long videos
  const ffmpeg = getFFmpegPath();
  const args = [
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

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  jobManager.setProcess(job.id, proc);

  let duration = 0;
  let stderrLog = '';

  proc.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    stderrLog += text;
    // Keep only last 4KB of stderr for error reporting
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
      // Update project with muxed video path
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
      // Include last stderr lines for debugging
      const lastLines = stderrLog.trim().split('\n').slice(-5).join('\n');
      jobManager.failJob(job.id, `FFmpeg mux falló (code ${code}):\n${lastLines}`);
    }
  });

  proc.on('error', (err) => {
    jobManager.failJob(job.id, `No se pudo iniciar FFmpeg: ${err.message}`);
  });

  return NextResponse.json({ jobId: job.id });
}
