import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { withProjectWrite } from '@/server/workers/part-worker';
import type { ProjectPart, ProjectState } from '@/types/project';

/** true if the job id refers to a job the jobManager considers alive. */
function jobIsAlive(jobId?: string): boolean {
  if (!jobId) return false;
  const job = jobManager.getJob(jobId);
  return !!job && (job.status === 'running' || job.status === 'pending');
}

/**
 * GET /api/projects/[id]/parts
 * Returns { parts, concat } with parts sorted by `order`.
 *
 * Jobs are in-memory only, so a server restart mid-pipeline leaves parts
 * stuck in 'processing' (and partsConcat in 'running') forever. Before
 * responding, reconcile those orphans to 'error' in ONE serialized write.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // No upfront getProject() here: it would only serve the not-found check,
  // which the code below already derives from the reconcile below (or the
  // fallback read when nothing needed reconciling) — the 584 KB project.json
  // was being read+parsed up to 4x per single GET before this route trimmed
  // it to 1-2x (parts pages poll this constantly while a part is processing).
  const reconciled = await withProjectWrite<ProjectState>(id, (p) => {
    const patch: Partial<ProjectState> = {};
    let partsChanged = false;
    const parts = (p.parts ?? []).map((part) => {
      if (part.status === 'processing' && !jobIsAlive(part.jobId)) {
        partsChanged = true;
        return {
          ...part,
          status: 'error' as const,
          error: 'Job perdido (servidor reiniciado)',
          jobId: undefined,
          stage: undefined,
        };
      }
      return part;
    });
    if (partsChanged) patch.parts = parts;
    if (p.partsConcat?.status === 'running' && !jobIsAlive(p.partsConcat.jobId)) {
      patch.partsConcat = {
        ...p.partsConcat,
        status: 'error' as const,
        error: 'Job perdido (servidor reiniciado)',
        jobId: undefined,
      };
    }
    // Joined output vanished (e.g. deleted from the Sync page or disk cleanup)
    // → surface it instead of silently claiming 'done' while downstream falls
    // back to per-part audio.
    if (
      p.partsConcat?.status === 'done' &&
      p.partsConcat.outputPath &&
      !existsSync(p.partsConcat.outputPath)
    ) {
      patch.partsConcat = {
        ...p.partsConcat,
        status: 'error' as const,
        error: 'El vídeo unido ya no existe en disco — vuelve a unir las partes',
        jobId: undefined,
      };
    }
    return Object.keys(patch).length > 0 ? patch : null;
  });

  // withProjectWrite already returns the fully-merged post-write project when
  // a patch was applied — reuse it instead of reading the file a third time.
  // Only the (more common) no-op-reconcile case needs a fresh read here.
  const fresh = reconciled ?? (await getProject(id));
  if (!fresh) {
    return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  }
  const sorted = [...(fresh.parts ?? [])].sort((a, b) => a.order - b.order);
  return NextResponse.json({ parts: sorted, concat: fresh.partsConcat ?? null });
}

/**
 * POST /api/projects/[id]/parts
 * Body: { videoSourceId: string, boardSourceId?: string, name?: string }
 * Creates a new part (status 'idle') appended at the end of the order.
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

  let body: { videoSourceId?: unknown; boardSourceId?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { videoSourceId, boardSourceId, name } = body;

  if (typeof videoSourceId !== 'string' || !videoSourceId) {
    return NextResponse.json({ error: 'Falta videoSourceId' }, { status: 400 });
  }
  if (!project.sources.some((s) => s.id === videoSourceId && s.type === 'video')) {
    return NextResponse.json(
      { error: 'Fuente de vídeo no encontrada en el proyecto' },
      { status: 400 }
    );
  }
  if (boardSourceId !== undefined && boardSourceId !== null) {
    if (
      typeof boardSourceId !== 'string' ||
      !project.sources.some((s) => s.id === boardSourceId && s.type === 'audio')
    ) {
      return NextResponse.json(
        { error: 'Fuente de audio de mesa no encontrada en el proyecto' },
        { status: 400 }
      );
    }
  }

  const newPartId = uuidv4();
  const updated = await withProjectWrite<ProjectState>(id, (p) => {
    const parts = p.parts ?? [];
    const order = parts.length > 0 ? Math.max(...parts.map((x) => x.order)) + 1 : 0;
    const part: ProjectPart = {
      id: newPartId,
      name:
        typeof name === 'string' && name.trim()
          ? name.trim()
          : `Parte ${parts.length + 1}`,
      videoSourceId,
      ...(typeof boardSourceId === 'string' ? { boardSourceId } : {}),
      order,
      status: 'idle',
    };
    return { parts: [...parts, part] };
  });

  const part = updated?.parts?.find((x) => x.id === newPartId);
  if (!part) {
    return NextResponse.json({ error: 'No se pudo crear la parte' }, { status: 500 });
  }
  return NextResponse.json({ part }, { status: 201 });
}
