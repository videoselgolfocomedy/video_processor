import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getProject, getProjectDir } from '@/server/project-manager';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const fileName = request.nextUrl.searchParams.get('file');
  if (!fileName) {
    return NextResponse.json({ error: 'No file specified' }, { status: 400 });
  }

  // Prevent path traversal
  const safeName = path.basename(fileName);
  const filePath = path.join(getProjectDir(id, 'export'), safeName);

  try {
    const stat = await fs.stat(filePath);
    const fileBuffer = await fs.readFile(filePath);

    return new Response(fileBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(stat.size),
        'Content-Disposition': `attachment; filename="${safeName}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
