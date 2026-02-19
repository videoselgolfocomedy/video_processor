import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { runSubtraction } from '@/server/workers/subtract-worker';
import type { VoiceSubtractionConfig } from '@/types/project';

const defaultConfig: VoiceSubtractionConfig = {
  method: 'spectral',
  alpha: 1.5,
  floor: 0.02,
  filterLength: 2048,
  mu: 0.5,
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Need synced audio: board (mic) and camera tracks
  const boardSource = project.sources.find((s) => s.role === 'board');
  const cameraSource = project.sources.find(
    (s) => s.role === 'camera' && s.type === 'video'
  );

  if (!boardSource) {
    return NextResponse.json(
      { error: 'No se encontró audio de mesa. Sube un audio y márcalo como Mesa.' },
      { status: 400 }
    );
  }

  if (!cameraSource) {
    return NextResponse.json(
      { error: 'No se encontró video de cámara. Sube un video y márcalo como Cámara.' },
      { status: 400 }
    );
  }

  // Find the extracted audio tracks
  const boardTrack = project.audio.extractedTracks.find(
    (t) => t.sourceFileId === boardSource.id
  );
  const cameraTrack = project.audio.extractedTracks.find(
    (t) => t.sourceFileId === cameraSource.id
  );

  // Board audio can be either an extracted track or a direct audio source
  const micPath = boardTrack?.path || (boardSource.type === 'audio'
    ? path.join(getProjectDir(id, 'source'), boardSource.storedName)
    : null);

  if (!micPath) {
    return NextResponse.json(
      { error: 'Audio de mesa no disponible. Importa el audio de mesa primero.' },
      { status: 400 }
    );
  }

  if (!cameraTrack) {
    return NextResponse.json(
      { error: 'Audio de cámara no extraído. Extrae el audio del video de cámara primero.' },
      { status: 400 }
    );
  }

  // Parse config from body, merge with defaults
  let config = defaultConfig;
  try {
    const body = await request.json();
    config = { ...defaultConfig, ...body };
  } catch {
    // Use defaults
  }

  const job = jobManager.createJob(id, 'voice-subtract');
  jobManager.startJob(job.id);

  await updateProject(id, {
    audio: {
      ...project.audio,
      subtractionStatus: 'running',
      subtractionJobId: job.id,
      subtractionConfig: config,
    },
  });

  runSubtraction({
    projectId: id,
    micPath,
    cameraPath: cameraTrack.path,
    jobId: job.id,
    config,
  });

  return NextResponse.json({ jobId: job.id });
}
