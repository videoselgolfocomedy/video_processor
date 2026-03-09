import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; reelId: string }> }
) {
  const { id, reelId } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const updates = await request.json();
  const reels = project.reels.map((r) =>
    r.id === reelId ? { ...r, ...updates, id: reelId } : r
  );

  await updateProject(id, { reels });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; reelId: string }> }
) {
  const { id, reelId } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  await updateProject(id, {
    reels: project.reels.filter((r) => r.id !== reelId),
  });

  return NextResponse.json({ ok: true });
}
