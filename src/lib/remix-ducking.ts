import type { ProjectPart, ProjectState } from '@/types/project';
import { partNeedsRemix } from '@/lib/part-chain-description';

/**
 * Client-side orchestration to RE-MIX the selected single-pair mix wav in place,
 * applying the current board (mesa) ducking regions. Reuses the existing audio
 * routes (no re-mux needed — Compose/Reels preview & export read the mix wav from
 * sync.selectedAudioPath):
 *   1. If the board is amplified, re-run /audio/amplify (re-bakes the duck into
 *      amplifiedBoardPath, since order is duck→amplify→mix).
 *   2. Re-run /audio/mix-preview with the SAME params (parsed from the mix
 *      filename) so it overwrites the same wav → selectedAudioPath stays valid.
 *   3. Bump sync.audioRev so the browser reloads the updated wav.
 *
 * The board duck regions must already be saved to project.audio.boardDuckRegions
 * (the caller's onSave does this) — both routes read them server-side.
 */

interface RemixResult { ok: boolean; error?: string }

interface MixParams {
  boardVolume: number;
  ambientVolume: number;
  manualAdjustMs: number;
  ambientSource: 'raw' | 'cleaned' | 'subtracted';
}

/** Recover the mix params from the selected wav's filename. Returns null if the
 *  name doesn't match the mix grammar (mix_<ambient>[_raw|_cleaned]_bv<>_av<>[_adj<>].wav). */
export function parseMixParams(selectedAudioPath: string): MixParams | null {
  const name = selectedAudioPath.split('/').pop() || selectedAudioPath;
  const m = name.match(/_bv([\d.]+)_av([\d.]+)(?:_adj(-?\d+))?\.wav$/);
  if (!m) return null;
  const srcMatch = name.match(/_(raw|cleaned)_bv/);
  return {
    boardVolume: parseFloat(m[1]),
    ambientVolume: parseFloat(m[2]),
    manualAdjustMs: m[3] ? parseInt(m[3], 10) : 0,
    ambientSource: (srcMatch ? srcMatch[1] : 'subtracted') as MixParams['ambientSource'],
  };
}

/** Poll a job to its end; resolves with the job's `result` (what the worker
 *  passed to completeJob) or throws with its error. */
export async function pollJob(jobId: string, onProgress: (p: number, m: string) => void = () => {}): Promise<{ result?: Record<string, unknown> }> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    const res = await fetch(`/api/jobs/${jobId}`);
    if (!res.ok) throw new Error(`Job ${jobId} no encontrado`);
    const job = await res.json();
    onProgress(job.progress ?? 0, job.message ?? '');
    if (job.status === 'done') return { result: job.result as Record<string, unknown> | undefined };
    if (job.status === 'error' || job.status === 'cancelled') {
      throw new Error(job.error || 'El proceso de audio falló');
    }
  }
}

export async function remixWithDucking(
  projectId: string,
  project: ProjectState,
  onProgress: (p: number, m: string) => void = () => {},
): Promise<RemixResult> {
  try {
    const sel = project.sync?.selectedAudioPath;
    if (!sel) {
      return { ok: false, error: 'No hay mezcla seleccionada. Pasa por Sync & Mix primero.' };
    }
    const params = parseMixParams(sel);
    if (!params) {
      return { ok: false, error: 'No pude leer los parámetros de la mezcla del nombre del archivo.' };
    }
    const useAmplified = !!project.audio.amplifyApplied && !!project.audio.amplifiedBoardPath;

    // 1. Re-amplify (re-bake the duck into the amplified board) when used.
    if (useAmplified && project.audio.amplifySettings) {
      onProgress(3, 'Re-amplificando mesa con la atenuación...');
      const res = await fetch(`/api/projects/${projectId}/audio/amplify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(project.audio.amplifySettings),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.jobId) throw new Error(d.error || `Error amplificando (${res.status})`);
      await pollJob(d.jobId, (p, m) => onProgress(3 + Math.round(p * 0.47), m));
    }

    // 2. Re-mix (overwrites the same wav → selectedAudioPath stays valid).
    onProgress(50, 'Re-mezclando mesa + ambiente...');
    const res2 = await fetch(`/api/projects/${projectId}/audio/mix-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, useAmplified }),
    });
    const d2 = await res2.json().catch(() => ({}));
    if (!res2.ok || !d2.jobId) throw new Error(d2.error || `Error mezclando (${res2.status})`);
    await pollJob(d2.jobId, (p, m) => onProgress(50 + Math.round(p * 0.45), m));

    // 3. Bump audioRev so the preview reloads the fresh wav.
    await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync: { ...project.sync, audioRev: Date.now() } }),
    });
    onProgress(100, 'Listo');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Re-mix ONE part with its stored offset (mode 'mix'), waiting for the job.
 *  Resolves true when the worker took the audio-only fast path (video untouched). */
async function remixOnePart(projectId: string, partId: string, onProgress: (msg: string) => void): Promise<boolean> {
  const res = await fetch(`/api/projects/${projectId}/parts/${partId}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'mix' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Error ${res.status}`);
  const done = await pollJob((data as { jobId: string }).jobId, (pct, m) => onProgress(`${m || 'Re-mezclando…'} ${pct}%`));
  return done.result?.fastPath === true;
}

/** Re-join the parts into the final muxed video, waiting for the job. */
async function joinParts(projectId: string, onProgress: (msg: string) => void): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/parts/concat`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Error ${res.status}`);
  await pollJob((data as { jobId: string }).jobId, (pct, m) => onProgress(`${m || 'Actualizando el vídeo unido…'} ${pct}%`));
}

/**
 * "Aplicar" behind the je-je / ambient panels AND the timeline region lane, so
 * both go through the same sequence: re-mix every part whose audio is pending
 * — the ones edited right now (`alsoRemixIds`) PLUS every part the server
 * already considers stale (see `partNeedsRemix`) — and then join ONCE, and
 * only if some part's VIDEO was actually re-muxed: an audio-only re-mix
 * already refreshed the audio master (the worker rebuilds parts_mix_sync.wav
 * and bumps audioRev), so compose / reels / export hear it without the join.
 *
 * Two bugs this shape fixes. (1) Applying only the parts edited in THIS
 * browser session left an older edit sitting at 'aligned', and the join, which
 * demands every part mixed, failed with «Partes sin procesar: <esa parte>» —
 * on a part the user had not touched. (2) The join stream-copies every part
 * into a new muxed file (10+ GB on a real set); running it once per re-mixed
 * part repeated all of that for nothing.
 *
 * Single-part projects join themselves inside the mix job (instant APFS
 * clone), so the explicit join is multi-part only.
 */
export async function applyPendingParts(
  projectId: string,
  parts: ProjectPart[],
  alsoRemixIds: string[] = [],
  onProgress: (msg: string) => void = () => {},
): Promise<{ ok: true; remixed: number; joined: boolean } | { ok: false; error: string }> {
  const extra = new Set(alsoRemixIds);
  const todo = parts.filter((p) => extra.has(p.id) || partNeedsRemix(p));
  if (todo.length === 0) return { ok: true, remixed: 0, joined: false };
  // Say up front what the join would refuse, instead of spending minutes
  // re-mixing towards a video that cannot be built yet.
  if (parts.length > 1) {
    const blocked = parts.filter((p) => p.alignmentOffsetMs == null || p.status === 'idle');
    if (blocked.length > 0) {
      return {
        ok: false,
        error: `Sin alinear: ${blocked.map((p) => p.name).join(', ')}. Alinea y mezcla esas partes en Sync & Mix (o bórralas) antes de aplicar.`,
      };
    }
  }
  try {
    let videoChanged = false;
    for (const part of todo) {
      onProgress(`Re-mezclando ${part.name}…`);
      const fast = await remixOnePart(projectId, part.id, (m) => onProgress(`${part.name}: ${m}`));
      if (!fast) videoChanged = true;
    }
    const joined = parts.length > 1 && videoChanged;
    if (joined) {
      onProgress('Actualizando el vídeo unido…');
      await joinParts(projectId, onProgress);
    }
    return { ok: true, remixed: todo.length, joined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'error' };
  }
}
