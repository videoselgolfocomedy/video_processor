import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { getProject, getProjectDir, listProjects, updateProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { probeExportSignature, resolveExportFile, startConcatExport } from '@/server/workers/concat-export-worker';
import type { ConcatExportItem, ExportRecord } from '@/types/project';
import type { ConcatCandidate } from '@/lib/concat-exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — every finished 16:9 export on this machine, grouped by project (the
 * current project first), for picking the pieces of a join.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const projects = await listProjects();
  if (!projects.some((p) => p.id === id)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const groups: { projectId: string; projectName: string; exports: ConcatCandidate[] }[] = [];
  const ordered = [...projects].sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : 0));
  for (const project of ordered) {
    const exports: ConcatCandidate[] = [];
    for (const rec of project.exports) {
      if (rec.status !== 'done' || !rec.outputPath || rec.targetType !== 'youtube') continue;
      const fileName = path.basename(rec.outputPath);
      const filePath = path.join(getProjectDir(project.id, 'export'), fileName);
      let sizeBytes: number;
      try {
        sizeBytes = (await fs.stat(filePath)).size;
      } catch {
        continue; // file deleted from disk — not offered
      }
      try {
        const sig = await probeExportSignature(filePath);
        exports.push({
          projectId: project.id,
          projectName: project.name,
          exportId: rec.id,
          fileName,
          presetId: rec.presetId,
          label: rec.label,
          completedAt: rec.completedAt,
          sizeBytes,
          durationMs: sig.durationMs,
          width: sig.width,
          height: sig.height,
          formatKey: sig.key,
          formatText: `${sig.vcodec} ${sig.width}x${sig.height} ${sig.pixFmt} ${sig.fps} fps · ${sig.acodec} ${sig.sampleRate} Hz ${sig.channels}ch`,
        });
      } catch (err) {
        console.warn(`[export/concat] cannot probe ${filePath}:`, (err as Error).message);
      }
    }
    if (exports.length > 0) {
      exports.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
      groups.push({ projectId: project.id, projectName: project.name, exports });
    }
  }
  return NextResponse.json({ groups });
}

/**
 * POST { items: [{ projectId, exportId }], label? } — join the pieces in that
 * order into a new export of THIS project (shows up in its render queue).
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

  const body = await request.json().catch(() => ({}));
  const rawItems: { projectId?: string; exportId?: string }[] = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length < 2) {
    return NextResponse.json({ error: 'Selecciona al menos dos vídeos' }, { status: 400 });
  }

  const items: ConcatExportItem[] = [];
  for (const raw of rawItems) {
    if (!raw.projectId || !raw.exportId) {
      return NextResponse.json({ error: 'Elemento inválido' }, { status: 400 });
    }
    const resolved = await resolveExportFile(raw.projectId, raw.exportId);
    if (!resolved) {
      return NextResponse.json({ error: `Export no disponible: ${raw.exportId}` }, { status: 400 });
    }
    items.push({
      projectId: raw.projectId,
      projectName: resolved.projectName,
      exportId: raw.exportId,
      fileName: path.basename(resolved.filePath),
    });
  }

  const label = typeof body.label === 'string' && body.label.trim()
    ? body.label.trim()
    : `Unión de ${items.length} vídeos`;

  const exportId = uuidv4();
  const job = jobManager.createJob(id, 'render');
  jobManager.startJob(job.id);
  const outputPath = path.join(getProjectDir(id, 'export'), `union_${Date.now()}.mp4`);

  const record: ExportRecord = {
    id: exportId,
    presetId: 'concat',
    status: 'rendering',
    jobId: job.id,
    startedAt: new Date().toISOString(),
    progress: 0,
    targetType: 'youtube',
    label,
    concatOf: items,
  };
  await updateProject(id, { exports: [...project.exports, record] });

  startConcatExport({ projectId: id, jobId: job.id, exportId, items, outputPath }).catch((err) => {
    console.error('[export/concat] worker threw:', err);
    jobManager.failJob(job.id, `Join init failed: ${(err as Error)?.message ?? String(err)}`);
  });

  return NextResponse.json({ jobId: job.id, exportId });
}
