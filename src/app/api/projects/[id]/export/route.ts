import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getProject, updateProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { startRender } from '@/server/workers/render-worker';
import { getPreset } from '@/config/export-presets';
import type { ExportRecord } from '@/types/project';

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
  const presetId = body.presetId;
  const includeSubtitles = body.includeSubtitles !== false; // default true
  const trimInMs: number | undefined = body.trimInMs;
  const trimOutMs: number | undefined = body.trimOutMs;

  const preset = getPreset(presetId);
  if (!preset) {
    return NextResponse.json({ error: 'Invalid preset' }, { status: 400 });
  }

  const targetType: 'youtube' | 'reel' = body.targetType ?? 'youtube';
  const reelId: string | undefined = body.reelId;

  const exportId = uuidv4();
  const job = jobManager.createJob(id, 'render');
  jobManager.startJob(job.id);

  // Create export record
  const exportRecord: ExportRecord = {
    id: exportId,
    presetId,
    status: 'rendering',
    jobId: job.id,
    startedAt: new Date().toISOString(),
    progress: 0,
    targetType,
    reelId,
  };

  await updateProject(id, {
    exports: [...project.exports, exportRecord],
  });

  // Start render in background
  startRender({
    projectId: id,
    jobId: job.id,
    exportId,
    preset,
    includeSubtitles,
    trimInMs,
    trimOutMs,
    targetType,
    reelId,
  });

  return NextResponse.json({ jobId: job.id, exportId });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Clean up orphaned "rendering" exports whose jobs no longer exist in memory
  let dirty = false;
  const exports = project.exports.map((e) => {
    if (e.status === 'rendering' && e.jobId) {
      const job = jobManager.getJob(e.jobId);
      if (!job) {
        dirty = true;
        return { ...e, status: 'error' as const, error: 'Job perdido (servidor reiniciado)' };
      }
      if (job.status === 'error') {
        dirty = true;
        return { ...e, status: 'error' as const, error: job.error || 'Render failed' };
      }
    }
    return e;
  });

  if (dirty) {
    await updateProject(id, { exports });
  }

  return NextResponse.json(exports);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const exportId = request.nextUrl.searchParams.get('exportId');

  if (exportId) {
    // Delete a specific export record
    const record = project.exports.find((e) => e.id === exportId);
    if (record?.jobId) {
      jobManager.cancelJob(record.jobId);
    }
    await updateProject(id, {
      exports: project.exports.filter((e) => e.id !== exportId),
    });
  } else {
    // Clear all non-active exports
    for (const record of project.exports) {
      if (record.jobId && record.status === 'rendering') {
        jobManager.cancelJob(record.jobId);
      }
    }
    await updateProject(id, { exports: [] });
  }

  return NextResponse.json({ ok: true });
}
