import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { getProject, getProjectDir } from '@/server/project-manager';

function ffmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
}

/**
 * Resolve an audio/video source fileName to a real path. A clip's fileName may
 * live in audio/ (mixes), the project root (uploads / pasted reel_* clips),
 * export/ (muxed video) or source/ (raw uploads).
 */
function resolveSourcePath(projectId: string, name: string): string | undefined {
  if (name.includes('/') && existsSync(name)) return name;
  const base = path.basename(name);
  for (const dir of [
    getProjectDir(projectId, 'audio'),
    getProjectDir(projectId),
    getProjectDir(projectId, 'export'),
    getProjectDir(projectId, 'source'),
  ]) {
    const cand = path.join(dir, base);
    if (existsSync(cand)) return cand;
  }
  return undefined;
}

/**
 * POST /api/projects/[id]/audio/export-clip
 * Body: { fileName, sourceInMs, sourceOutMs, downloadName? }
 * Extracts the [sourceInMs, sourceOutMs] slice of the clip's source file as a
 * 48kHz 16-bit stereo WAV and streams it as a download (for external editing
 * in Audacity, etc.).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const { fileName, sourceInMs, sourceOutMs, downloadName } = body as {
    fileName?: string;
    sourceInMs?: number;
    sourceOutMs?: number;
    downloadName?: string;
  };

  if (!fileName || typeof sourceInMs !== 'number' || typeof sourceOutMs !== 'number') {
    return NextResponse.json({ error: 'Missing fileName / sourceInMs / sourceOutMs' }, { status: 400 });
  }
  const durMs = sourceOutMs - sourceInMs;
  if (durMs <= 0) {
    return NextResponse.json({ error: 'Invalid range' }, { status: 400 });
  }

  const srcPath = resolveSourcePath(id, fileName);
  if (!srcPath) {
    return NextResponse.json({ error: `Source file not found: ${fileName}` }, { status: 404 });
  }

  const inSec = Math.max(0, sourceInMs / 1000);
  const durSec = durMs / 1000;

  const tmpWav = path.join(
    os.tmpdir(),
    `clip-export-${id}-${Date.now()}.wav`
  );

  // Input-seek then -t: fast and sample-accurate enough for a WAV extraction
  // (audio, no keyframe concerns). -vn drops any video stream.
  const args = [
    '-y',
    '-ss', String(inSec),
    '-i', srcPath,
    '-t', String(durSec),
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    tmpWav,
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath(), args);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.split('\n').slice(-4).join(' ')}`));
      });
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  let stat;
  try {
    stat = await fs.stat(tmpWav);
  } catch {
    return NextResponse.json({ error: 'Export produced no file' }, { status: 500 });
  }

  const safeBase = (downloadName || path.basename(fileName).replace(/\.[^.]+$/, '') || 'clip')
    .replace(/[^\w\-]+/g, '_')
    .slice(0, 80);
  const outName = `${safeBase}_${Math.round(sourceInMs)}-${Math.round(sourceOutMs)}.wav`;

  const nodeStream = createReadStream(tmpWav);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(chunk));
      nodeStream.on('end', () => {
        controller.close();
        fs.unlink(tmpWav).catch(() => {});
      });
      nodeStream.on('error', (e) => {
        controller.error(e);
        fs.unlink(tmpWav).catch(() => {});
      });
    },
    cancel() {
      nodeStream.destroy();
      fs.unlink(tmpWav).catch(() => {});
    },
  });

  return new Response(webStream, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${outName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
