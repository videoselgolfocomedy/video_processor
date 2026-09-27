import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { runPartPipeline, updatePart } from '@/server/workers/part-worker';

/**
 * POST /api/projects/[id]/parts/[partId]/process
 * Optional body: { boardVolume?: number, ambientVolume?: number }
 * Launches the part pipeline (extract → align → mix → mux) as a
 * 'part-pipeline' job. Returns { jobId } — progress via SSE.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; partId: string }> }
) {
  const { id, partId } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  }
  const part = (project.parts ?? []).find((p) => p.id === partId);
  if (!part) {
    return NextResponse.json({ error: 'Parte no encontrada' }, { status: 404 });
  }

  if (part.status === 'processing' && part.jobId) {
    const existingJob = jobManager.getJob(part.jobId);
    if (existingJob && (existingJob.status === 'running' || existingJob.status === 'pending')) {
      return NextResponse.json(
        { error: 'La parte ya se está procesando' },
        { status: 409 }
      );
    }
  }

  let body: { boardVolume?: unknown; ambientVolume?: unknown; boardGainDb?: unknown; boardCompress?: unknown; mode?: unknown; forceMux?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const boardVolume = typeof body.boardVolume === 'number' ? body.boardVolume : undefined;
  const ambientVolume = typeof body.ambientVolume === 'number' ? body.ambientVolume : undefined;
  const boardGainDb = typeof body.boardGainDb === 'number' ? body.boardGainDb : undefined;
  const boardCompress = typeof body.boardCompress === 'boolean' ? body.boardCompress : undefined;
  const mode: 'align' | 'mix' | 'full' =
    body.mode === 'align' || body.mode === 'mix' ? body.mode : 'full';
  const forceMux = body.forceMux === true;

  if (mode === 'align' && !part.boardSourceId) {
    return NextResponse.json(
      { error: 'La parte no tiene audio de mesa — no hay nada que alinear' },
      { status: 400 }
    );
  }
  if (mode === 'mix' && part.boardSourceId && part.alignmentOffsetMs == null) {
    return NextResponse.json(
      { error: 'La parte no está alineada — pulsa "Alinear" primero' },
      { status: 400 }
    );
  }

  const job = jobManager.createJob(id, 'part-pipeline');
  jobManager.startJob(job.id);

  await updatePart(id, partId, {
    status: 'processing',
    stage: mode === 'mix' ? 'mix' : 'extract',
    jobId: job.id,
    progress: 0,
    error: undefined,
    ...(boardVolume !== undefined ? { boardVolume } : {}),
    ...(ambientVolume !== undefined ? { ambientVolume } : {}),
    ...(boardGainDb !== undefined ? { boardGainDb } : {}),
    ...(boardCompress !== undefined ? { boardCompress } : {}),
  });

  // Fire-and-forget: the pipeline updates the part record and the job itself.
  runPartPipeline({ projectId: id, partId, jobId: job.id, mode, forceMux }).catch((err: Error) => {
    console.error(`[parts/process] pipeline falló para la parte ${partId}:`, err);
    jobManager.failJob(job.id, err.message || 'Error procesando la parte');
  });

  return NextResponse.json({ jobId: job.id });
}
