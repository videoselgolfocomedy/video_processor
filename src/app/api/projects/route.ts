import { NextRequest, NextResponse } from 'next/server';
import { listProjects, createProject } from '@/server/project-manager';
import { createProjectSchema } from '@/lib/schemas';

export async function GET() {
  try {
    const projects = await listProjects();
    return NextResponse.json(projects);
  } catch {
    return NextResponse.json(
      { error: 'Failed to list projects' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const project = await createProject(parsed.data.name);
    return NextResponse.json(project, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: 'Failed to create project' },
      { status: 500 }
    );
  }
}
