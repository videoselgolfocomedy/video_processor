import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { runLaughterDetection } from '@/server/workers/laughter-worker';
import type { LaughterDetectionConfig } from '@/types/project';

const defaultConfig: LaughterDetectionConfig = {
  threshold: 2.0,
  minDurationMs: 300,
  mergeGapMs: 500,
  windowMs: 50,
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

  // Need ambient audio from subtraction
  const ambientPath = project.audio.ambientPath;
  if (!ambientPath) {
    return NextResponse.json(
      { error: 'No hay audio de ambiente. Ejecuta la sustracción de voz primero.' },
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

  const job = jobManager.createJob(id, 'laughter-detect');
  jobManager.startJob(job.id);

  await updateProject(id, {
    audio: {
      ...project.audio,
      laughterStatus: 'running',
      laughterJobId: job.id,
      laughterConfig: config,
    },
  });

  runLaughterDetection({
    projectId: id,
    inputPath: ambientPath,
    jobId: job.id,
    config,
  });

  return NextResponse.json({ jobId: job.id });
}
