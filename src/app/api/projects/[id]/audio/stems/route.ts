import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { getProject, getProjectDir } from '@/server/project-manager';
import { computeStemLayout, mainAudioFileName } from '@/lib/audio-stems';

/**
 * GET /api/projects/[id]/audio/stems
 *
 * The per-part stem layout for "mesa y ambiente como pistas separadas":
 * where each part sits in the concat timeline, the trim between muxed t=0
 * and the stem files, and whether the two processed stems are on disk (they
 * are written by every mix run; parts mixed before the stems existed need
 * one re-mix).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });

  const audioDir = getProjectDir(id, 'audio');
  const exists = async (name: string | null) => {
    if (!name) return false;
    try { await fs.access(path.join(audioDir, name)); return true; } catch { return false; }
  };
  const layout = computeStemLayout(project);
  for (const seg of layout) {
    seg.boardExists = await exists(seg.boardFile);
    seg.ambientExists = await exists(seg.ambientFile);
  }
  return NextResponse.json({
    layout,
    mainAudioFileName: mainAudioFileName(project),
    mainAudioOffsetMs: project.sync.muxedAudioOffsetMs ?? 0,
    concatDone: project.partsConcat?.status === 'done' && !!project.sync.muxedVideoPath,
  });
}
