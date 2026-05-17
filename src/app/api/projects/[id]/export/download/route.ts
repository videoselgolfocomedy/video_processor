import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { getProject, getProjectDir } from '@/server/project-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  // Stat first so we can distinguish "missing file" from "read error" and so we
  // can set Content-Length up front. Don't readFile() — exports can be 2+ GB
  // and buffering them in memory either OOMs the Node process or trips Buffer
  // size limits, which previously surfaced as a misleading 404 (the catch
  // block returned `{ error: 'File not found' }`, which Chrome saved as
  // `download.json`).
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    console.error(`[export/download] 404: file not on disk at ${filePath}`);
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'Not a file' }, { status: 400 });
  }

  const nodeStream = createReadStream(filePath);
  // Convert Node Readable → Web ReadableStream so we can hand it to Response.
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${safeName}"`,
    },
  });
}
