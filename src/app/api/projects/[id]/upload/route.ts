import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import Busboy from 'busboy';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { probeFile } from '@/server/ffmpeg-wrapper';
import { SUPPORTED_VIDEO_EXTENSIONS } from '@/lib/constants';
import type { SourceFile } from '@/types/project';

// Disable Next.js body parsing for this route - we handle it with busboy
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UploadResult {
  filePath: string;
  storedName: string;
  fileId: string;
  originalName: string;
  size: number;
  role: string;
}

function parseUpload(
  request: NextRequest,
  sourceDir: string
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get('content-type') || '';
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10GB
    });

    let role = 'other';
    let result: UploadResult | null = null;
    let fileProcessed = false;

    busboy.on('field', (name, value) => {
      if (name === 'role') role = value;
    });

    busboy.on('file', (_fieldname, stream, info) => {
      if (fileProcessed) {
        stream.resume(); // skip additional files
        return;
      }
      fileProcessed = true;

      const fileId = uuidv4();
      const ext = path.extname(info.filename).toLowerCase();
      const storedName = `${fileId}${ext}`;
      const filePath = path.join(sourceDir, storedName);
      const writeStream = createWriteStream(filePath);

      let size = 0;

      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
      });

      stream.pipe(writeStream);

      writeStream.on('finish', () => {
        result = {
          filePath,
          storedName,
          fileId,
          originalName: info.filename,
          size,
          role,
        };
      });

      writeStream.on('error', reject);
      stream.on('error', reject);
    });

    busboy.on('finish', () => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error('No file received'));
      }
    });

    busboy.on('error', reject);

    // Pipe request body to busboy
    const body = request.body;
    if (!body) {
      reject(new Error('No request body'));
      return;
    }

    const nodeStream = Readable.fromWeb(body as import('stream/web').ReadableStream);
    nodeStream.pipe(busboy);
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const sourceDir = getProjectDir(id, 'source');
  await fs.mkdir(sourceDir, { recursive: true });

  try {
    const { filePath, storedName, fileId, originalName, size, role } =
      await parseUpload(request, sourceDir);

    // Probe file for metadata
    let probe;
    try {
      probe = await probeFile(filePath);
    } catch {
      probe = null;
    }

    const ext = path.extname(originalName).toLowerCase();
    const isVideo = SUPPORTED_VIDEO_EXTENSIONS.includes(ext);
    const sourceFile: SourceFile = {
      id: fileId,
      originalName,
      storedName,
      type: isVideo ? 'video' : 'audio',
      role: role as 'camera' | 'board' | 'other',
      size,
      duration: probe?.duration,
      codec: probe?.codec,
      resolution:
        probe?.width && probe?.height
          ? { width: probe.width, height: probe.height }
          : undefined,
      addedAt: new Date().toISOString(),
    };

    const updatedSources = [...project.sources, sourceFile];
    await updateProject(id, { sources: updatedSources });

    return NextResponse.json(sourceFile, { status: 201 });
  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json(
      { error: (err as Error).message || 'Failed to upload file' },
      { status: 500 }
    );
  }
}
