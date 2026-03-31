import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import Busboy from 'busboy';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { probeFile } from '@/server/ffmpeg-wrapper';
import { SUPPORTED_VIDEO_EXTENSIONS, MAX_UPLOAD_SIZE } from '@/lib/constants';
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
      limits: { fileSize: MAX_UPLOAD_SIZE },
    });

    let role = 'other';
    let fileProcessed = false;
    let fileTruncated = false;
    // Promise that resolves when the file write completes.
    // Busboy's 'finish' event (= done parsing multipart) can fire BEFORE the
    // writeStream finishes flushing to disk, so we must await this explicitly.
    let fileWritePromise: Promise<UploadResult> | null = null;

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

      // Detect when busboy truncates the file at the fileSize limit.
      // Busboy does NOT emit an error — it silently stops the stream,
      // which produces a corrupt file (e.g. MP4 missing its moov atom).
      stream.on('limit', () => {
        fileTruncated = true;
      });

      stream.pipe(writeStream);

      fileWritePromise = new Promise<UploadResult>((res, rej) => {
        writeStream.on('finish', async () => {
          if (fileTruncated) {
            // Clean up the truncated file
            try { await fs.unlink(filePath); } catch { /* ignore */ }
            const limitGB = Math.round(MAX_UPLOAD_SIZE / (1024 * 1024 * 1024));
            rej(new Error(
              `El archivo "${info.filename}" supera el límite de ${limitGB} GB y fue truncado. ` +
              `Comprime el video antes de subirlo.`
            ));
            return;
          }
          res({
            filePath,
            storedName,
            fileId,
            originalName: info.filename,
            size,
            role,
          });
        });
        writeStream.on('error', rej);
      });

      stream.on('error', reject);
    });

    busboy.on('finish', async () => {
      if (fileWritePromise) {
        try {
          resolve(await fileWritePromise);
        } catch (err) {
          reject(err);
        }
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
