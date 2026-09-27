import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { ensurePartBoardWav } from '@/server/part-files';
import { resolveProjectMediaPath } from '@/server/project-media';

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
  // A part's raw mesa is rebuilt from its source if it went missing (no-op otherwise).
  await ensurePartBoardWav(id, safeName).catch((err) => console.warn('[audio/file]', (err as Error).message));

  // audio/ → export/ → source/ → project root, plus the stale-muxed fallback
  // (see resolveProjectMediaPath). Shared with the envelope endpoint so a name
  // that draws a waveform always plays too, and vice versa.
  let filePath = await resolveProjectMediaPath(id, safeName);
  if (!filePath) {
    // An absolute path inside the project is accepted as-is (stored paths).
    const projectDir = getProjectDir(id);
    if (name.startsWith(projectDir)) {
      try {
        await fs.access(name);
        filePath = name;
      } catch { /* fall through */ }
    }
  }
  if (!filePath) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
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

  // Revalidation info so the browser can skip re-transferring bytes it
  // already has (a 304 costs nothing) instead of re-downloading the whole
  // file on every mount — these files ARE overwritten in place (re-mixes,
  // re-amplifies), so the tag must track mtime, never claim "immutable".
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  const lastModified = stat.mtime.toUTCString();
  const ifNoneMatch = request.headers.get('if-none-match');
  const ifModifiedSince = request.headers.get('if-modified-since');
  if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince) >= stat.mtime)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' },
    });
  }

  // Stream via Readable.toWeb (propagates backpressure to the fs stream) —
  // the old manual `nodeStream.on('data', chunk => controller.enqueue(chunk))`
  // bridge ignores controller.desiredSize, so a stalled client (Chrome caps
  // its media buffer) let the server keep reading a 25+ GB file into an
  // unbounded queue at disk speed. Same fix already used in export/download.
  const range = request.headers.get('range');
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1]);
      const end = match[2] ? parseInt(match[2]) : stat.size - 1;
      const chunkSize = end - start + 1;

      const webStream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;

      return new Response(webStream, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(chunkSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
          ETag: etag,
          'Last-Modified': lastModified,
        },
      });
    }
  }

  const webStream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;

  return new Response(webStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': lastModified,
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
