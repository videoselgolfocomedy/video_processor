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
    style: project.youtubeSubtitles.style,
    stylePreset: project.youtubeSubtitles.stylePreset,
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

  const updates: Record<string, unknown> = {};

  // Update transcription (segments + constraints only)
  if (body.segments || body.constraints) {
    updates.transcription = {
      ...project.transcription,
      segments: body.segments ?? project.transcription.segments,
      constraints: body.constraints ?? project.transcription.constraints,
    };
  }

  // Update youtube subtitle style (separate from transcription)
  if (body.style || body.stylePreset) {
    updates.youtubeSubtitles = {
      ...project.youtubeSubtitles,
      style: body.style ?? project.youtubeSubtitles.style,
      stylePreset: body.stylePreset ?? project.youtubeSubtitles.stylePreset,
    };
  }

  await updateProject(id, updates);

  return NextResponse.json({ ok: true });
}
