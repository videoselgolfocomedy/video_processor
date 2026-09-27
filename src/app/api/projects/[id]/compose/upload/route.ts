import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import Busboy from 'busboy';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { probeFile } from '@/server/ffmpeg-wrapper';
import {
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
} from '@/lib/constants';
import type { MediaBinAsset } from '@/types/project';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UploadResult {
  filePath: string;
  storedName: string;
  fileId: string;
  originalName: string;
  size: number;
}

function parseUpload(
  request: NextRequest,
  composeDir: string
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get('content-type') || '';
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: 10 * 1024 * 1024 * 1024 },
    });

    let fileProcessed = false;
    // Busboy's 'finish' event (= done parsing multipart) can fire BEFORE the
    // writeStream finishes flushing to disk — small files (a compose image is
    // often just a few KB) are the most likely to race, since busboy reaches
    // 'finish' almost instantly while the disk write is still pending. Must
    // await this explicitly instead of checking a synchronously-set variable
    // in the 'finish' handler, or the upload intermittently fails with
    // "No file received" even though the file writes successfully moments
    // later. See the same fix + comment in `../../upload/route.ts`.
    let fileWritePromise: Promise<UploadResult> | null = null;

    busboy.on('file', (_fieldname, stream, info) => {
      if (fileProcessed) {
        stream.resume();
        return;
      }
      fileProcessed = true;

      const fileId = uuidv4();
      const ext = path.extname(info.filename).toLowerCase();
      const storedName = `${fileId}${ext}`;
      const filePath = path.join(composeDir, storedName);
      const writeStream = createWriteStream(filePath);

      let size = 0;
      stream.on('data', (chunk: Buffer) => { size += chunk.length; });
      stream.pipe(writeStream);

      fileWritePromise = new Promise<UploadResult>((res, rej) => {
        writeStream.on('finish', () => {
          res({ filePath, storedName, fileId, originalName: info.filename, size });
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

    const body = request.body;
    if (!body) { reject(new Error('No request body')); return; }
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

  const composeDir = getProjectDir(id, 'compose');
  await fs.mkdir(composeDir, { recursive: true });

  try {
    const { filePath, storedName, fileId, originalName } =
      await parseUpload(request, composeDir);

    const ext = path.extname(originalName).toLowerCase();
    const isVideo = SUPPORTED_VIDEO_EXTENSIONS.includes(ext);
    const isImage = SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
    const isAudio = SUPPORTED_AUDIO_EXTENSIONS.includes(ext);

    let duration: number | undefined;
    let resolution: { width: number; height: number } | undefined;

    if (isVideo || isAudio) {
      try {
        const probe = await probeFile(filePath);
        duration = probe.duration ? probe.duration * 1000 : undefined; // convert to ms
        if (probe.width && probe.height) {
          resolution = { width: probe.width, height: probe.height };
        }
      } catch { /* ignore probe errors */ }
    }

    const fileType: 'video' | 'image' | 'audio' = isVideo
      ? 'video'
      : isImage
        ? 'image'
        : isAudio
          ? 'audio'
          : 'video'; // fallback

    const asset: MediaBinAsset = {
      id: fileId,
      fileName: storedName,
      originalName,
      type: fileType,
      duration,
      resolution,
    };

    const composition = { ...project.composition };
    composition.mediaBin = [...composition.mediaBin, asset];
    await updateProject(id, { composition });

    return NextResponse.json(asset, { status: 201 });
  } catch (err) {
    console.error('Compose upload error:', err);
    return NextResponse.json(
      { error: (err as Error).message || 'Failed to upload file' },
      { status: 500 }
    );
  }
}
