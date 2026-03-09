import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';
import { detectPunchlines } from '@/server/punchline-detector';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  return NextResponse.json(project.punchlineHints ?? []);
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  if (project.audio.laughterSegments.length === 0) {
    return NextResponse.json(
      { error: 'No laughter segments found. Run laughter detection first.' },
      { status: 400 }
    );
  }

  if (project.transcription.segments.length === 0) {
    return NextResponse.json(
      { error: 'No transcription segments. Transcribe first.' },
      { status: 400 }
    );
  }

  const hints = detectPunchlines(
    project.audio.laughterSegments,
    project.transcription.segments
  );

  await updateProject(id, { punchlineHints: hints });

  return NextResponse.json(hints);
}
