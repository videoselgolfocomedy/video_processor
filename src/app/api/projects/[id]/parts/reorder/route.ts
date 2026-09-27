import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/server/project-manager';
import { withProjectWrite } from '@/server/workers/part-worker';
import type { ProjectState } from '@/types/project';

/**
 * POST /api/projects/[id]/parts/reorder
 * Body: { order: string[] } — part ids in the desired final-concat order.
 * Must be a permutation of the existing part ids.
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

  let body: { order?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const orderRaw = body.order;
  if (!Array.isArray(orderRaw) || orderRaw.some((x) => typeof x !== 'string')) {
    return NextResponse.json(
      { error: 'Falta order (array de ids de partes)' },
      { status: 400 }
    );
  }
  const order = orderRaw as string[];

  let invalid = false;
  const updated = await withProjectWrite<ProjectState>(id, (p) => {
    const parts = p.parts ?? [];
    const currentIds = new Set(parts.map((x) => x.id));
    if (
      order.length !== parts.length ||
      new Set(order).size !== order.length ||
      !order.every((oid) => currentIds.has(oid))
    ) {
      invalid = true;
      return null;
    }
    const position = new Map(order.map((oid, i) => [oid, i]));
    return { parts: parts.map((x) => ({ ...x, order: position.get(x.id)! })) };
  });

  if (invalid || !updated) {
    return NextResponse.json(
      { error: 'order debe ser una permutación de los ids de las partes existentes' },
      { status: 400 }
    );
  }
  const parts = [...(updated.parts ?? [])].sort((a, b) => a.order - b.order);
  return NextResponse.json({ parts });
}
