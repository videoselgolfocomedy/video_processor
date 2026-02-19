import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  return NextResponse.json({
    segments: project.transcription.segments,
    style: project.transcription.style,
    stylePreset: project.transcription.stylePreset,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();

  await updateProject(id, {
    transcription: {
      ...project.transcription,
      segments: body.segments ?? project.transcription.segments,
      style: body.style ?? project.transcription.style,
      stylePreset: body.stylePreset ?? project.transcription.stylePreset,
    },
  });

  return NextResponse.json({ ok: true });
}
