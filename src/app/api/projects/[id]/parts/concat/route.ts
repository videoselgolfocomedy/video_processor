import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { runPartsConcat, withProjectWrite } from '@/server/workers/part-worker';

/**
 * POST /api/projects/[id]/parts/concat
 * Joins the ordered part muxed files into the final muxed video
 * (sync.muxedVideoPath) as a 'parts-concat' job. Returns { jobId }.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  }

  const parts = [...(project.parts ?? [])].sort((a, b) => a.order - b.order);
  if (parts.length === 0) {
    return NextResponse.json({ error: 'No hay partes definidas' }, { status: 400 });
  }

  const processing = parts.filter((p) => p.status === 'processing');
  if (processing.length > 0) {
    return NextResponse.json(
      {
        error:
          `Hay partes procesándose: ${processing.map((p) => p.name).join(', ')}. ` +
          'Espera a que terminen antes de unir.',
      },
      { status: 409 }
    );
  }

  if (project.partsConcat?.status === 'running' && project.partsConcat.jobId) {
    const existingJob = jobManager.getJob(project.partsConcat.jobId);
    if (existingJob && (existingJob.status === 'running' || existingJob.status === 'pending')) {
      return NextResponse.json(
        { error: 'Ya hay una unión de partes en curso' },
        { status: 409 }
      );
    }
  }

  const notDone = parts.filter((p) => p.status !== 'done' || !p.muxedVideoPath);
  if (notDone.length > 0) {
    return NextResponse.json(
      {
        error:
          `Partes sin procesar: ${notDone.map((p) => p.name).join(', ')}. ` +
          'Procesa todas las partes antes de unir.',
      },
      { status: 400 }
    );
  }

  const job = jobManager.createJob(id, 'parts-concat');
  jobManager.startJob(job.id);

  await withProjectWrite(id, (p) => ({
    partsConcat: {
      ...(p.partsConcat ?? { status: 'idle' as const }),
      status: 'running' as const,
      jobId: job.id,
      error: undefined,
    },
  }));

  // Fire-and-forget: the worker seeds sync.* and partsConcat itself.
  runPartsConcat({ projectId: id, jobId: job.id }).catch((err: Error) => {
    console.error('[parts/concat] unión de partes falló:', err);
    jobManager.failJob(job.id, err.message || 'Error uniendo las partes');
  });

  return NextResponse.json({ jobId: job.id });
}
