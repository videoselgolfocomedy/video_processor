import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { probeFile, getFFmpegPath } from '@/server/ffmpeg-wrapper';
import { INBOX_DIR, SUPPORTED_VIDEO_EXTENSIONS, SUPPORTED_EXTENSIONS } from '@/lib/constants';
import type { SourceFile } from '@/types/project';

/**
 * Lossless range cut via FFmpeg stream copy (`-c copy` — NO re-encode, so the
 * quality is bit-identical to the original and it runs at disk speed).
 * Input-side `-ss` with stream copy starts at the keyframe AT-OR-BEFORE the
 * requested start (iPhone ≈ 1s keyframes → at most ~1s of extra head), which
 * is exactly what we want for a trim: never lose requested material. The end
 * lands at/just after the requested point for the same reason. Container and
 * extension are preserved (.mov stays .mov). Only video+audio streams are
 * mapped — iPhone timed-metadata data tracks can break the copy muxer.
 */
function losslessCut(
  src: string,
  dest: string,
  trimStartMs: number | undefined,
  trimEndMs: number | undefined,
): Promise<void> {
  const ffmpeg = getFFmpegPath();
  const startSec = Math.max(0, (trimStartMs ?? 0) / 1000);
  const args: string[] = ['-y', '-v', 'error'];
  if (startSec > 0) args.push('-ss', String(startSec));
  args.push('-i', src);
  if (trimEndMs != null) {
    args.push('-t', String((trimEndMs - (trimStartMs ?? 0)) / 1000));
  }
  args.push('-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', dest);
  console.log(`[import-trim] ${ffmpeg} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args);
    let err = '';
    proc.stderr.on('data', (d) => {
      err += String(d);
      if (err.length > 65536) err = err.slice(-65536);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`));
    });
  });
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

  const body = await request.json();
  const { filename, role = 'other', mode = 'move', trimStartMs, trimEndMs } = body as {
    filename: string;
    role?: 'camera' | 'board' | 'other';
    mode?: 'move' | 'copy' | 'link';
    /** Optional lossless range cut (ms). When either is set, the import runs a
     * stream-copy cut of just that range instead of moving/copying the whole
     * file; the original stays in the inbox. */
    trimStartMs?: number;
    trimEndMs?: number;
  };

  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }
  const hasTrim = trimStartMs != null || trimEndMs != null;
  if (hasTrim && trimEndMs != null && trimEndMs <= (trimStartMs ?? 0)) {
    return NextResponse.json({ error: 'El fin del tramo debe ser mayor que el inicio' }, { status: 400 });
  }

  // Prevent path traversal
  const safeName = path.basename(filename);
  const sourcePath = path.join(INBOX_DIR, safeName);

  // Verify file exists
  try {
    await fs.access(sourcePath);
  } catch {
    return NextResponse.json(
      { error: `File not found in inbox: ${safeName}` },
      { status: 404 }
    );
  }

  const ext = path.extname(safeName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${ext}` },
      { status: 400 }
    );
  }

  const fileId = uuidv4();
  let storedName = `${fileId}${ext}`;
  const sourceDir = getProjectDir(id, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  let destPath = path.join(sourceDir, storedName);

  try {
    if (hasTrim) {
      // Lossless range cut — the original stays untouched in the inbox.
      try {
        await losslessCut(sourcePath, destPath, trimStartMs, trimEndMs);
      } catch (cutErr) {
        // Some cameras record ".MP4" files that are really QuickTime-structured
        // with PCM audio (pcm_s16be/pcm_s16le); FFmpeg's mp4 muxer refuses to
        // stream-copy that audio ("Could not find tag for codec ... in
        // container"). The .mov container accepts it, and the copy stays
        // 100% lossless — so retry the same cut into .mov.
        const msg = (cutErr as Error).message ?? '';
        const containerRefused = /Could not find tag for codec|not currently supported in container|Could not write header/i.test(msg);
        if (containerRefused && ext !== '.mov') {
          await fs.rm(destPath, { force: true });
          storedName = `${fileId}.mov`;
          destPath = path.join(sourceDir, storedName);
          console.log(`[import-trim] container refused stream copy — retrying as .mov`);
          await losslessCut(sourcePath, destPath, trimStartMs, trimEndMs);
        } else {
          throw cutErr;
        }
      }
    } else if (mode === 'link') {
      // Symlink - file stays in inbox, no disk usage
      await fs.symlink(sourcePath, destPath);
    } else if (mode === 'copy') {
      await fs.copyFile(sourcePath, destPath);
    } else {
      // move (default) - rename if same filesystem, else copy+delete
      try {
        await fs.rename(sourcePath, destPath);
      } catch {
        // Cross-device move: copy then delete
        await fs.copyFile(sourcePath, destPath);
        await fs.unlink(sourcePath);
      }
    }

    const stat = await fs.stat(destPath);

    // Probe file for metadata
    let probe;
    try {
      probe = await probeFile(destPath);
    } catch {
      probe = null;
    }

    const isVideo = SUPPORTED_VIDEO_EXTENSIONS.includes(ext);
    // Annotate the cut range in the display name, e.g. "CENA 2 (12:30–58:00).MP4".
    // Strip the extension with its ORIGINAL case (`ext` is lowercased for the
    // checks, so basename(name, ext) wouldn't strip ".MP4").
    const rawExt = path.extname(safeName);
    const base = path.basename(safeName, rawExt);
    const displayName = hasTrim
      ? `${base} (${fmtMs(trimStartMs ?? 0)}–${trimEndMs != null ? fmtMs(trimEndMs) : 'fin'})${rawExt}`
      : safeName;
    const sourceFile: SourceFile = {
      id: fileId,
      originalName: displayName,
      storedName,
      type: isVideo ? 'video' : 'audio',
      role,
      size: stat.size,
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
    console.error('Import error:', err);
    // Don't leave a partial/empty cut behind on failure.
    await fs.rm(destPath, { force: true }).catch(() => {});
    return NextResponse.json(
      { error: (err as Error).message || 'Failed to import file' },
      { status: 500 }
    );
  }
}
