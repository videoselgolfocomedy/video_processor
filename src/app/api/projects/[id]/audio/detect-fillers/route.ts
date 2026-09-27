import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { getProject, getProjectDir } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { detectBoardFillers } from '@/server/workers/part-worker';

/**
 * POST /api/projects/[id]/audio/detect-fillers
 * Single-pair (audio-prep) board filler detection. Runs on the board (mesa)
 * source, writing audio/board_fillers.json (envelope + proposed je-je/eehh
 * regions). Returns { jobId }; progress via SSE. The chosen regions are saved
 * separately to project.audio.boardDuckRegions and applied by the mix-preview.
 *
 * Optional body { examples: { positives:[{start_ms,end_ms,type}], negatives:[{start_ms,end_ms}] } }
 * switches to the example-based ("teach the detector") search: it keeps
 * candidates similar to the positives and unlike the negatives.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  }
  const boardSource = project.sources.find((s) => s.role === 'board');
  if (!boardSource) {
    return NextResponse.json({ error: 'No hay audio de mesa' }, { status: 400 });
  }

  const audioDir = getProjectDir(id, 'audio');
  const sourceDir = getProjectDir(id, 'source');

  // Optional taught examples → write to a JSON the Python script reads.
  let examplesPath: string | undefined;
  try {
    const body = await request.json().catch(() => null);
    const ex = body?.examples;
    if (ex && Array.isArray(ex.positives) && ex.positives.length > 0) {
      examplesPath = path.join(audioDir, 'board_fillers_examples.json');
      await fs.writeFile(examplesPath, JSON.stringify({
        positives: ex.positives,
        negatives: Array.isArray(ex.negatives) ? ex.negatives : [],
      }));
    }
  } catch { /* no body → heuristic detection */ }

  const job = jobManager.createJob(id, 'detect-fillers');
  jobManager.startJob(job.id);

  // Detect on a normalized copy of the board (48 kHz mono). Its timeline matches
  // the raw/amplified board the mix uses (amplify preserves timing), so region
  // times line up regardless of which board the mix-preview picks.
  detectBoardFillers({
    jobId: job.id,
    boardWavPath: path.join(audioDir, 'board_ducking.wav'),
    regenerateFromSrc: path.join(sourceDir, boardSource.storedName),
    fillersOutPath: path.join(audioDir, 'board_fillers.json'),
    logTag: examplesPath ? 'fillers-learn' : 'fillers',
    examplesPath,
  }).catch((err: Error) => {
    console.error('[audio/detect-fillers] falló:', err);
    jobManager.failJob(job.id, err.message || 'Error detectando rellenos');
  });

  return NextResponse.json({ jobId: job.id });
}
