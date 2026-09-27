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

  // inline=1 → play in an embedded <video> instead of forcing a download
  // (used by the part card to audition part_<id8>_muxed.mp4 without concat).
  const inline = request.nextUrl.searchParams.get('inline') === '1';
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`;

  // HTTP Range support — browsers seek <video> with range requests; without
  // it playback can't jump and Safari refuses to play at all.
  const rangeHeader = request.headers.get('range');
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    const start = m[1] !== '' ? parseInt(m[1], 10) : Math.max(0, stat.size - parseInt(m[2], 10));
    const end = m[1] !== '' && m[2] !== '' ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    }
    const webStream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(webStream, {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': disposition,
      },
    });
  }

  const nodeStream = createReadStream(filePath);
  // Convert Node Readable → Web ReadableStream so we can hand it to Response.
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
    },
  });
}
