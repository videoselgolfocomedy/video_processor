import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/server/project-manager';
import { getProjectDir } from '@/server/project-manager';
import path from 'path';
import fs from 'fs/promises';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  // Determine type from MIME
  const mime = file.type;
  let type: 'video' | 'audio' | 'image' | 'gif' = 'image';
  if (mime.startsWith('video/')) type = 'video';
  else if (mime.startsWith('audio/')) type = 'audio';
  else if (mime === 'image/gif') type = 'gif';
  else if (mime.startsWith('image/')) type = 'image';

  // Save file to project directory (resolved via project-manager so the new
  // <slug>_<id8> folder convention is honoured for projects created after that
  // change, while legacy <UUID> folders still work).
  const projectDir = getProjectDir(id);
  const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileName = `reel_${Date.now()}_${sanitized}`;
  const filePath = path.join(projectDir, fileName);

  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filePath, buffer);

  return NextResponse.json({
    fileName,
    originalName: file.name,
    type,
  });
}
