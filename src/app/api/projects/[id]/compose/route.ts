import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';
import type { CompositionState } from '@/types/project';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  return NextResponse.json(project.composition);
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

  try {
    const body = await request.json();
    const { subtitleStyle, subtitleStylePreset, subtitleConstraints, versions, ...compositionFields } = body;
    const composition: CompositionState & { versions?: unknown[] } = {
      ...compositionFields,
      ...(versions ? { versions } : {}),
    };

    // Also save subtitle style to youtubeSubtitles if provided
    const updates: Record<string, unknown> = { composition };
    if (subtitleStyle) {
      updates.youtubeSubtitles = {
        ...project.youtubeSubtitles,
        style: subtitleStyle,
        ...(subtitleStylePreset ? { stylePreset: subtitleStylePreset } : {}),
      };
    }
    if (subtitleConstraints) {
      updates.transcription = {
        ...project.transcription,
        constraints: subtitleConstraints,
      };
    }

    const updated = await updateProject(id, updates);
    if (!updated) {
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }
    return NextResponse.json(updated.composition);
  } catch {
    return NextResponse.json(
      { error: 'Failed to save composition' },
      { status: 500 }
    );
  }
}
