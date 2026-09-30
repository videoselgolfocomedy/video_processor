/**
 * Join finished YouTube exports — from this project and/or others — into ONE
 * file to upload. Two paths, chosen from the probed stream parameters:
 *
 *  - every piece shares codec / size / pixel format / fps / audio layout →
 *    concat DEMUXER with `-c copy` (seconds, bit-identical to the pieces);
 *  - anything differs → concat FILTER: each piece is scaled+padded to the
 *    first piece's frame, fps-normalised and its audio brought to 48 kHz
 *    stereo, then re-encoded with libx264 (CRF of the YouTube 1080p preset).
 *
 * No colour handling on purpose (see CLAUDE.md §6): pieces are already
 * exports, so a copy join keeps them exactly as rendered.
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { getProject, getProjectDir, updateProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { getFFmpegPath } from '@/server/ffmpeg-wrapper';
import type { ConcatExportItem, ExportRecord } from '@/types/project';

const execFileAsync = promisify(execFile);

function getFFprobePath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffprobe-static').path as string;
  } catch {
    return 'ffprobe';
  }
}

/** Stream parameters that decide whether two files can be stream-copied together. */
export interface ExportSignature {
  durationMs: number;
  width: number;
  height: number;
  vcodec: string;
  pixFmt: string;
  fps: string;
  acodec: string;
  sampleRate: number;
  channels: number;
  /** Compact key: equal keys → copy join is safe. */
  key: string;
}

const sigCache = new Map<string, { mtimeMs: number; sig: ExportSignature }>();

export async function probeExportSignature(filePath: string): Promise<ExportSignature> {
  const stat = await fs.stat(filePath);
  const cached = sigCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.sig;

  const { stdout } = await execFileAsync(getFFprobePath(), [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ], { timeout: 30000 });
  const data = JSON.parse(stdout);
  const v = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video') ?? {};
  const a = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio') ?? {};
  const sig: ExportSignature = {
    durationMs: Math.round(parseFloat(data.format?.duration || '0') * 1000),
    width: v.width ?? 0,
    height: v.height ?? 0,
    vcodec: v.codec_name ?? 'none',
    pixFmt: v.pix_fmt ?? '',
    fps: v.r_frame_rate ?? '',
    acodec: a.codec_name ?? 'none',
    sampleRate: a.sample_rate ? parseInt(a.sample_rate, 10) : 0,
    channels: a.channels ?? 0,
    key: '',
  };
  sig.key = [sig.vcodec, sig.width, sig.height, sig.pixFmt, sig.fps, sig.acodec, sig.sampleRate, sig.channels].join('|');
  sigCache.set(filePath, { mtimeMs: stat.mtimeMs, sig });
  return sig;
}

/** Absolute path of a finished export of any project, or null if it is gone. */
export async function resolveExportFile(projectId: string, exportId: string): Promise<{ filePath: string; record: ExportRecord; projectName: string } | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const record = project.exports.find((e) => e.id === exportId);
  if (!record || record.status !== 'done' || !record.outputPath) return null;
  const filePath = path.join(getProjectDir(projectId, 'export'), path.basename(record.outputPath));
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  return { filePath, record, projectName: project.name };
}

interface ConcatOptions {
  projectId: string;
  jobId: string;
  exportId: string;
  items: ConcatExportItem[];
  outputPath: string;
}

async function markExport(projectId: string, exportId: string, patch: Partial<ExportRecord>): Promise<void> {
  const project = await getProject(projectId);
  if (!project) return;
  await updateProject(projectId, {
    exports: project.exports.map((e) => (e.id === exportId ? { ...e, ...patch } : e)),
  });
}

async function fail(o: ConcatOptions, message: string): Promise<void> {
  console.error(`[concat-export] ${message}`);
  await markExport(o.projectId, o.exportId, { status: 'error', error: message, completedAt: new Date().toISOString() });
  const job = jobManager.getJob(o.jobId);
  if (job && job.status === 'running') jobManager.failJob(o.jobId, message);
}

export async function startConcatExport(o: ConcatOptions): Promise<void> {
  const { projectId, jobId, exportId, items, outputPath } = o;
  jobManager.updateProgress(jobId, 1, 'Comprobando los vídeos…');
  const listPath = outputPath.replace(/\.mp4$/, '_list.txt');

  try {
    // Resolve + probe every piece up front so a missing file fails before
    // ffmpeg starts, with the name of the piece that is gone.
    const pieces: { filePath: string; sig: ExportSignature; item: ConcatExportItem }[] = [];
    for (const item of items) {
      const resolved = await resolveExportFile(item.projectId, item.exportId);
      if (!resolved) {
        await fail(o, `No se encuentra el export «${item.fileName}» de «${item.projectName}» (¿borrado?).`);
        return;
      }
      pieces.push({ filePath: resolved.filePath, sig: await probeExportSignature(resolved.filePath), item });
    }
    if (pieces.length < 2) {
      await fail(o, 'Hacen falta al menos dos vídeos para unir.');
      return;
    }

    const totalMs = pieces.reduce((s, p) => s + p.sig.durationMs, 0);
    const sameFormat = pieces.every((p) => p.sig.key === pieces[0].sig.key);
    const first = pieces[0].sig;

    let args: string[];
    if (sameFormat) {
      const listContent = pieces
        .map((p) => `file '${p.filePath.replace(/'/g, `'\\''`)}'`)
        .join('\n') + '\n';
      await fs.writeFile(listPath, listContent, 'utf-8');
      args = [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy', '-movflags', '+faststart',
        '-progress', 'pipe:1', outputPath,
      ];
      jobManager.updateProgress(jobId, 2, `Mismo formato en los ${pieces.length} vídeos: uniendo sin recodificar…`);
    } else {
      const W = first.width, H = first.height;
      const fps = first.fps && /^\d+(\/\d+)?$/.test(first.fps) ? first.fps : '30';
      const filters: string[] = [];
      const labels: string[] = [];
      pieces.forEach((p, i) => {
        filters.push(
          `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
        );
        // Mono → duplicated to both sides at unity (aformat alone drops 3 dB, CLAUDE.md §8).
        const toStereo = p.sig.channels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '';
        filters.push(`[${i}:a]${toStereo}aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
        labels.push(`[v${i}][a${i}]`);
      });
      filters.push(`${labels.join('')}concat=n=${pieces.length}:v=1:a=1[v][a]`);
      args = [
        '-y',
        ...pieces.flatMap((p) => ['-i', p.filePath]),
        '-filter_complex', filters.join(';'),
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-c:a', 'aac', '-b:a', '256k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1', outputPath,
      ];
      jobManager.updateProgress(jobId, 2, `Formatos distintos: recodificando a ${W}x${H}…`);
    }

    console.log(`[concat-export] ${sameFormat ? 'copy' : 're-encode'} join of ${pieces.length} pieces → ${path.basename(outputPath)}`);
    console.log(`[concat-export] ffmpeg ${args.join(' ')}`);

    const proc = spawn(getFFmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    jobManager.setProcess(jobId, proc);

    let stderrTail: string[] = [];
    proc.stderr?.on('data', (d: Buffer) => {
      stderrTail.push(d.toString());
      if (stderrTail.length > 30) stderrTail = stderrTail.slice(-30);
    });
    proc.stdout?.on('data', (d: Buffer) => {
      const m = d.toString().match(/out_time_us=(\d+)/);
      if (m && totalMs > 0) {
        const pct = Math.min(97, 2 + (parseInt(m[1], 10) / 1000 / totalMs) * 95);
        jobManager.updateProgress(jobId, Math.round(pct), sameFormat ? 'Uniendo…' : 'Recodificando…');
      }
    });

    await new Promise<void>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg salió con ${code}: ${stderrTail.join('').split('\n').filter(Boolean).slice(-4).join(' | ')}`));
      });
    });

    await markExport(projectId, exportId, { status: 'done', outputPath, completedAt: new Date().toISOString(), progress: 100 });
    jobManager.completeJob(jobId, { outputPath });
  } catch (err) {
    await fail(o, `No se pudo unir: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    try { await fs.unlink(listPath); } catch { /* not created on the re-encode path */ }
  }
}
