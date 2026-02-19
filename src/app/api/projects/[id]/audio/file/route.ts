import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';

/**
 * GET  /api/projects/[id]/audio/file?name=ambient.wav  → serve file
 * GET  /api/projects/[id]/audio/file?list=generated     → list generated files
 * DELETE /api/projects/[id]/audio/file?name=foo.wav     → delete file
 * PATCH  /api/projects/[id]/audio/file                  → select ambient for sync
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // List generated audio files
  const listParam = request.nextUrl.searchParams.get('list');
  if (listParam === 'generated') {
    const audioDir = getProjectDir(id, 'audio');
    try {
      const entries = await fs.readdir(audioDir);
      const files = [];
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'demucs_output') continue;
        const fileStat = await fs.stat(path.join(audioDir, entry));
        if (!fileStat.isFile()) continue;
        files.push({
          name: entry,
          size: fileStat.size,
          modified: fileStat.mtime.toISOString(),
          isAmbient: project.audio.ambientPath?.endsWith(entry) || false,
          isCleanup: project.audio.cameraAmbientPath?.endsWith(entry) || false,
          isMix: entry.startsWith('mix_'),
          isExtracted: project.audio.extractedTracks.some(t => t.path.endsWith(entry)),
        });
      }
      files.sort((a, b) => b.modified.localeCompare(a.modified));
      return NextResponse.json({ files });
    } catch {
      return NextResponse.json({ files: [] });
    }
  }

  const name = request.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'Missing name parameter' }, { status: 400 });
  }

  // Security: prevent path traversal
  const safeName = path.basename(name);

  // Check in audio dir, then export dir, then source dir
  const audioDir = getProjectDir(id, 'audio');
  const exportDir = getProjectDir(id, 'export');
  const sourceDir = getProjectDir(id, 'source');
  let filePath = path.join(audioDir, safeName);

  try {
    await fs.access(filePath);
  } catch {
    // Try export dir (muxed videos)
    filePath = path.join(exportDir, safeName);
    try {
      await fs.access(filePath);
    } catch {
      // Try source dir
      filePath = path.join(sourceDir, safeName);
      try {
        await fs.access(filePath);
      } catch {
        // Try absolute path if it's within the project dir
        const projectDir = getProjectDir(id);
        if (name.startsWith(projectDir)) {
          filePath = name;
          try {
            await fs.access(filePath);
          } catch {
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
          }
        } else {
          return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }
      }
    }
  }

  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.json': 'application/json',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  // Stream file using ReadableStream (handles large files without loading into memory)
  const range = request.headers.get('range');
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1]);
      const end = match[2] ? parseInt(match[2]) : stat.size - 1;
      const chunkSize = end - start + 1;

      const nodeStream = createReadStream(filePath, { start, end });
      const webStream = new ReadableStream({
        start(controller) {
          nodeStream.on('data', (chunk) => controller.enqueue(chunk));
          nodeStream.on('end', () => controller.close());
          nodeStream.on('error', (err) => controller.error(err));
        },
        cancel() { nodeStream.destroy(); },
      });

      return new Response(webStream, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(chunkSize),
          'Accept-Ranges': 'bytes',
        },
      });
    }
  }

  const nodeStream = createReadStream(filePath);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(chunk));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() { nodeStream.destroy(); },
  });

  return new Response(webStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * DELETE /api/projects/[id]/audio/file?name=foo.wav
 * Delete a generated audio file (won't delete extracted tracks or source files).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const name = request.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'Missing name parameter' }, { status: 400 });
  }

  const safeName = path.basename(name);

  // Don't allow deleting extracted tracks or source files
  const isExtracted = project.audio.extractedTracks.some(t => t.path.endsWith(safeName));
  if (isExtracted) {
    return NextResponse.json({ error: 'No se puede borrar una pista extraída' }, { status: 400 });
  }

  // Try audio dir first, then export dir (for muxed videos)
  const audioDir = getProjectDir(id, 'audio');
  const exportDir = getProjectDir(id, 'export');
  let filePath = path.join(audioDir, safeName);

  try {
    await fs.access(filePath);
  } catch {
    // Try export dir (muxed videos live there)
    filePath = path.join(exportDir, safeName);
    try {
      await fs.access(filePath);
    } catch {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
  }

  try {
    await fs.unlink(filePath);

    // Clear project references if this was the active ambient, cleanup, mix, or muxed video
    const audioUpdates: Record<string, unknown> = {};
    const syncUpdates: Record<string, unknown> = {};
    if (project.audio.ambientPath?.endsWith(safeName)) {
      audioUpdates.ambientPath = undefined;
      audioUpdates.subtractionStatus = 'idle';
    }
    if (project.audio.cameraAmbientPath?.endsWith(safeName)) {
      audioUpdates.cameraAmbientPath = undefined;
      audioUpdates.cleanupApplied = false;
    }
    if (project.sync.mixedAudioPath?.endsWith(safeName)) {
      syncUpdates.mixedAudioPath = undefined;
    }
    if (project.sync.muxedVideoPath?.endsWith(safeName)) {
      syncUpdates.muxedVideoPath = undefined;
    }
    const hasAudioUpdates = Object.keys(audioUpdates).length > 0;
    const hasSyncUpdates = Object.keys(syncUpdates).length > 0;
    if (hasAudioUpdates || hasSyncUpdates) {
      const patch: Record<string, unknown> = {};
      if (hasAudioUpdates) patch.audio = { ...project.audio, ...audioUpdates };
      if (hasSyncUpdates) patch.sync = { ...project.sync, ...syncUpdates };
      await updateProject(id, patch);
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Error deleting file' }, { status: 500 });
  }
}

/**
 * PATCH /api/projects/[id]/audio/file
 * Select which ambient file to use for sync.
 * Body: { ambientFile: "ambient_spectral_a1.5_f0.02.wav" }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();
  const { ambientFile } = body;

  if (!ambientFile) {
    return NextResponse.json({ error: 'Missing ambientFile' }, { status: 400 });
  }

  const safeName = path.basename(ambientFile);
  const audioDir = getProjectDir(id, 'audio');
  const filePath = path.join(audioDir, safeName);

  try {
    await fs.access(filePath);
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  await updateProject(id, {
    audio: {
      ...project.audio,
      ambientPath: filePath,
    },
  });

  return NextResponse.json({ ok: true, ambientPath: filePath });
}
