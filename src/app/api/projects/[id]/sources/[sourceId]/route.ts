import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sourceId: string }> }
) {
  const { id, sourceId } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();
  const { role } = body;

  if (role && !['camera', 'board', 'other'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }

  const sources = project.sources.map((s) =>
    s.id === sourceId ? { ...s, ...(role && { role }) } : s
  );

  const found = project.sources.find((s) => s.id === sourceId);
  if (!found) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  await updateProject(id, { sources });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sourceId: string }> }
) {
  const { id, sourceId } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const sources = project.sources.filter((s) => s.id !== sourceId);
  await updateProject(id, { sources });
  return NextResponse.json({ ok: true });
}
