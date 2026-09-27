import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { getProject, getProjectDir } from '@/server/project-manager';
import { getFFmpegPath } from '@/server/ffmpeg-wrapper';
import { ensurePartBoardWav } from '@/server/part-files';
import { resolveProjectMediaPath } from '@/server/project-media';

// In-flight decodes keyed by file path. A part card mounts several TrackRows
// (raw, processed, its `behind` reference) plus a BoardDuckingPanel that can
// all request the SAME file's envelope on first mount — without this, a cold
// cache spawns one full ffmpeg decode of a 140 MB wav PER caller instead of
// one shared computation.
const inflightEnvelopes = new Map<string, Promise<string>>();

/**
 * GET /api/projects/[id]/audio/envelope?name=<file>
 *
 * Amplitude envelope of ANY project audio file — including the MUXED VIDEOS in
 * export/, whose audio track is what a main-track clip (or one pasted from
 * another reel) actually plays; without that the timeline drew no wave for
 * them at all. See resolveProjectMediaPath for the search order and the
 * stale-muxed fallback. In
 * same shape the board-fillers JSON uses ({envelope, hop_ms, duration_s}) so
 * the waveform editor (BoardDuckingPanel) can render it directly. Used by the
 * ambient-boost panel, whose source (ambient wav) has no detection step to
 * produce an envelope as a side effect.
 *
 * Computed by decoding to mono 8 kHz PCM with FFmpeg and taking max|sample|
 * per 25 ms hop. Cached as a JSON next to the audio file and refreshed when
 * the audio is newer than the cache.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  }

  const name = request.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  const safeName = path.basename(name);
  // A part's raw mesa is rebuilt from its source if it went missing (no-op otherwise).
  await ensurePartBoardWav(id, safeName).catch((err) => console.warn('[audio/envelope]', (err as Error).message));

  const filePath = await resolveProjectMediaPath(id, safeName, project);
  if (!filePath) {
    return NextResponse.json({ error: `Audio no encontrado: ${safeName}` }, { status: 404 });
  }

  const HOP_MS = 25;
  const SR = 8000;
  const hopSamples = (SR * HOP_MS) / 1000; // 200

  // Serve the cache when it's newer than the audio file. Caches for files that
  // live in audio/ or source/ stay next to them (every existing one keeps
  // working); anything else — a muxed video in export/, an upload in the
  // project root — caches into audio/, which is where the storage panel calls
  // these "caché de onda" and where nothing else is expected to be a media file.
  const audioDir = getProjectDir(id, 'audio');
  const nearFile = filePath.startsWith(audioDir) || filePath.startsWith(getProjectDir(id, 'source'));
  const cacheDir = nearFile ? path.dirname(filePath) : audioDir;
  const cachePath = path.join(cacheDir, `envelope_${path.basename(filePath, path.extname(filePath))}.json`);
  try {
    const [cacheStat, fileStat] = await Promise.all([fs.stat(cachePath), fs.stat(filePath)]);
    if (cacheStat.mtimeMs > fileStat.mtimeMs) {
      const cached = await fs.readFile(cachePath, 'utf-8');
      return new NextResponse(cached, { headers: { 'Content-Type': 'application/json' } });
    }
  } catch { /* no cache yet */ }

  const compute = async (): Promise<string> => {
    const ffmpeg = getFFmpegPath();
    const pcm: Buffer = await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, [
        '-v', 'error',
        '-nostdin',
        '-i', filePath,
        // -vn keeps the demuxer from handing us video packets: on a 28 GB muxed
        // set that is the difference between minutes and ~6 s (measured: cost
        // scales with DURATION, not bytes, because the mov demuxer skips them).
        '-vn',
        '-map', '0:a:0',
        '-ac', '1',
        '-ar', String(SR),
        '-f', 's16le',
        '-',
      ]);
      const chunks: Buffer[] = [];
      let err = '';
      proc.stdout.on('data', (d) => chunks.push(d));
      proc.stderr.on('data', (d) => { err += String(d); if (err.length > 8192) err = err.slice(-8192); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`));
      });
    });

    const totalSamples = Math.floor(pcm.length / 2);
    const envelope: number[] = [];
    for (let i = 0; i < totalSamples; i += hopSamples) {
      let peak = 0;
      const end = Math.min(i + hopSamples, totalSamples);
      for (let j = i; j < end; j++) {
        const v = Math.abs(pcm.readInt16LE(j * 2));
        if (v > peak) peak = v;
      }
      envelope.push(Math.round((peak / 32768) * 1000) / 1000);
    }

    const payload = {
      envelope,
      hop_ms: HOP_MS,
      duration_s: totalSamples / SR,
    };
    const json = JSON.stringify(payload);
    await fs.writeFile(cachePath, json).catch(() => {});
    return json;
  };

  try {
    let json: string;
    const inflight = inflightEnvelopes.get(filePath);
    if (inflight) {
      json = await inflight;
    } else {
      const promise = compute().finally(() => inflightEnvelopes.delete(filePath!));
      inflightEnvelopes.set(filePath, promise);
      json = await promise;
    }
    return new NextResponse(json, { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return NextResponse.json(
      { error: `No se pudo calcular la envolvente: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
