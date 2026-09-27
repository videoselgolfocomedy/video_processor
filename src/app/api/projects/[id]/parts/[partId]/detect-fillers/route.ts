import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { getProject, getProjectDir } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { runFillerDetection } from '@/server/workers/part-worker';

/**
 * POST /api/projects/[id]/parts/[partId]/detect-fillers
 * Detects board (mesa) filler sounds — "je-je" chuckles and "eehh" fillers —
 * on the part's board audio and writes audio/part_<id8>_fillers.json (envelope +
 * proposed regions). Returns { jobId }; progress via SSE. The proposals are not
 * saved to project.json until the user applies them via the part PATCH.
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
  if (!part.boardSourceId) {
    return NextResponse.json(
      { error: 'La parte no tiene audio de mesa — no hay rellenos que detectar' },
      { status: 400 }
    );
  }

  // Optional taught examples → example-based ("teach the detector") search.
  let examplesPath: string | undefined;
  try {
    const body = await request.json().catch(() => null);
    const ex = body?.examples;
    if (ex && Array.isArray(ex.positives) && ex.positives.length > 0) {
      examplesPath = path.join(getProjectDir(id, 'audio'), `part_${partId.slice(0, 8)}_fillers_examples.json`);
      await fs.writeFile(examplesPath, JSON.stringify({
        positives: ex.positives,
        negatives: Array.isArray(ex.negatives) ? ex.negatives : [],
      }));
    }
  } catch { /* no body → heuristic detection */ }

  const job = jobManager.createJob(id, 'detect-fillers');
  jobManager.startJob(job.id);

  // Fire-and-forget; the worker drives the job to completion/failure.
  runFillerDetection({ projectId: id, partId, jobId: job.id, examplesPath }).catch((err: Error) => {
    console.error(`[detect-fillers] falló para la parte ${partId}:`, err);
    jobManager.failJob(job.id, err.message || 'Error detectando rellenos');
  });

  return NextResponse.json({ jobId: job.id });
}
