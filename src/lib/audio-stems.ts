import type { CompositionClip, CompositionTrack, ProjectPart, ProjectState } from '@/types/project';
import { partTrims } from '@/lib/part-trims';

/**
 * "Mesa y ambiente como pistas separadas" — the processed STEMS of every
 * part (`part_<id8>_board_proc.wav` / `part_<id8>_amb_proc.wav`, written by
 * each mix run, tapped where each branch enters the final amix and therefore
 * ALREADY carrying the part's mix volumes) brought into Compose / Reels as two
 * independent audio tracks, so the balance can be re-touched per clip there
 * without re-mixing. The main audio (the baked mix) is MUTED, not deleted —
 * unmute it to go back.
 *
 * Timelines: the stems live on the part's MIX clock; the muxed video (and so
 * the compose timeline) starts `muxedAudioTrimMs` later (keyframe-snap
 * residual). So for muxed time t inside part k:
 *   stem_time = (t − concatStart_k) + trim_k
 * Parts are laid back-to-back in `order` in the final concat.
 */

export const STEM_TRACK_IDS = {
  compose: { board: 'a_mesa', ambient: 'a_amb' },
  reel: { board: 'ra_mesa', ambient: 'ra_amb' },
} as const;

export const STEM_TRACK_LABELS = { board: 'Mesa (voz)', ambient: 'Ambiente (público)' } as const;

export type StemKind = 'board' | 'ambient';

/**
 * The part mix is `amix` with its default normalization: each branch enters
 * at ×0.5 (mix = (mesa + ambiente) / 2 → limiter; measured: (b+a)/2 −16.0 dB
 * vs mix −15.6). The stem files are the BRANCH outputs (post volume, what
 * the "techo −3 dB" / level readouts describe), so a clip on a stem track
 * enters the editors' mixer through this same ×0.5 — that way ×1 on the
 * clip = exactly its share of the mix, and mesa ×1 + ambiente ×1 = the mix.
 * Applied in the Compose preview, the reel player, BOTH export paths and the
 * MixStackView estimate. Moving a stem clip onto a plain audio track drops
 * the factor (+6 dB) — that track is not a mixer bus.
 */
export const STEM_MIX_NORMALIZATION = 0.5;

/** Mixer gain of a clip given its track: ×0.5 on the stem tracks, ×1 elsewhere. */
export function trackMixerGain(trackId: string): number {
  return stemKindOfTrack(trackId) ? STEM_MIX_NORMALIZATION : 1;
}

export function stemKindOfTrack(trackId: string): StemKind | null {
  if (trackId === STEM_TRACK_IDS.compose.board || trackId === STEM_TRACK_IDS.reel.board) return 'board';
  if (trackId === STEM_TRACK_IDS.compose.ambient || trackId === STEM_TRACK_IDS.reel.ambient) return 'ambient';
  return null;
}

export interface StemSegment {
  partId: string;
  partName: string;
  /** Start of this part in the CONCAT (muxed / compose) timeline. */
  concatStartMs: number;
  /** Length of the part's muxed video. */
  durationMs: number;
  /** Where muxed t=0 sits inside the stem files (= muxedAudioTrimMs). */
  sourceOffsetMs: number;
  /** Stem file names in audio/ — null when the part has no mesa (video-only). */
  boardFile: string | null;
  ambientFile: string | null;
  /** Filled by the server: whether the wavs are actually on disk. */
  boardExists?: boolean;
  ambientExists?: boolean;
}

/**
 * Ordered parts that made it into the final concat. A part whose settings or
 * regions changed since its last mix drops to 'aligned' (re-mix pending) but
 * its stems, mix and muxed video are still the ones on disk — so it counts.
 */
export function concatParts(project: Pick<ProjectState, 'parts'>): ProjectPart[] {
  return [...(project.parts ?? [])]
    .filter((p) => (p.status === 'done' || p.status === 'aligned') && p.muxedDurationMs != null)
    .sort((a, b) => a.order - b.order);
}

/**
 * The RAW file a processed stem came from and where the stem's t=0 sits in it
 * — Sync & Mix's "gris = original · color = procesada", for the timeline
 * clips. Mesa: `part_<id8>_board.wav` shifted by the board trim; ambiente: the
 * camera's extracted wav shifted by the camera trim. Null for non-stem files.
 */
export function stemOriginalOf(
  project: Pick<ProjectState, 'parts'>,
  fileName: string,
): { fileName: string; offsetMs: number } | null {
  const m = /^part_([0-9a-f]{8})_(board|amb)_proc\.wav$/i.exec(fileName);
  if (!m) return null;
  const part = (project.parts ?? []).find((p) => p.id.slice(0, 8).toLowerCase() === m[1].toLowerCase());
  if (!part) return null;
  const trims = partTrims(part);
  if (m[2] === 'board') return { fileName: `part_${m[1]}_board.wav`, offsetMs: trims.boardTrimMs };
  return part.videoSourceId ? { fileName: `${part.videoSourceId}_audio.wav`, offsetMs: trims.ambientTrimMs } : null;
}

export function computeStemLayout(project: Pick<ProjectState, 'parts' | 'partsConcat'>): StemSegment[] {
  const parts = concatParts(project);
  const out: StemSegment[] = [];
  let acc = 0;
  for (const p of parts) {
    const prefix = `part_${p.id.slice(0, 8)}`;
    const hasBoard = !!p.boardSourceId;
    out.push({
      partId: p.id,
      partName: p.name,
      concatStartMs: acc,
      durationMs: p.muxedDurationMs ?? 0,
      sourceOffsetMs: p.muxedAudioTrimMs ?? 0,
      boardFile: hasBoard ? `${prefix}_board_proc.wav` : null,
      ambientFile: hasBoard ? `${prefix}_amb_proc.wav` : null,
    });
    acc += p.muxedDurationMs ?? 0;
  }
  return out;
}

/** The file the main audio track plays (mix wav, or the muxed video itself). */
export function mainAudioFileName(project: Pick<ProjectState, 'sync'>): string | undefined {
  const p = project.sync.mixedAudioPath || project.sync.selectedAudioPath || project.sync.muxedVideoPath;
  return p ? p.split('/').pop() : undefined;
}

/**
 * Build the two stem clips per part for a window of the concat timeline,
 * placed on the editor's timeline starting at `timelineStartMs`. Used by
 * Compose (window = whole concat) and by Reels (window = each ra1 clip's
 * source range). Parts without stems put the MAIN audio on the ambient track
 * for that stretch instead, so muting the main track never leaves a hole.
 */
export function buildStemClipsForWindow(opts: {
  layout: StemSegment[];
  trackIds: { board: string; ambient: string };
  /** Window in CONCAT (muxed) time. */
  concatFromMs: number;
  concatToMs: number;
  /** Where concatFromMs lands on the editor timeline. */
  timelineStartMs: number;
  mainAudioFileName?: string;
  /** How the main audio file is offset from muxed time (sync.muxedAudioOffsetMs). */
  mainAudioOffsetMs?: number;
  makeId: () => string;
}): CompositionClip[] {
  const clips: CompositionClip[] = [];
  for (const seg of opts.layout) {
    const segEnd = seg.concatStartMs + seg.durationMs;
    const a = Math.max(opts.concatFromMs, seg.concatStartMs);
    const b = Math.min(opts.concatToMs, segEnd);
    if (b - a < 20) continue;
    const tStart = opts.timelineStartMs + (a - opts.concatFromMs);
    const tEnd = tStart + (b - a);
    const local = a - seg.concatStartMs; // muxed time inside the part
    const hasStems = !!(seg.boardFile && seg.boardExists !== false && seg.ambientFile && seg.ambientExists !== false);
    if (hasStems) {
      const sIn = local + seg.sourceOffsetMs;
      for (const [kind, file] of [['board', seg.boardFile!], ['ambient', seg.ambientFile!]] as const) {
        clips.push({
          id: opts.makeId(),
          type: 'audio',
          fileName: file,
          originalName: `${STEM_TRACK_LABELS[kind]} · ${seg.partName}`,
          trackId: opts.trackIds[kind],
          timelineStartMs: tStart,
          timelineEndMs: tEnd,
          sourceInMs: sIn,
          sourceOutMs: sIn + (b - a),
          volume: 1,
        });
      }
    } else if (opts.mainAudioFileName) {
      // No stems for this part (video-only): its already-mixed audio rides
      // the ambient stem track; ×2 cancels that track's ×0.5 mixer gain.
      const sIn = a + (opts.mainAudioOffsetMs ?? 0);
      clips.push({
        id: opts.makeId(),
        type: 'audio',
        fileName: opts.mainAudioFileName,
        originalName: `Audio de ${seg.partName} (sin stems, ya mezclado)`,
        trackId: opts.trackIds.ambient,
        timelineStartMs: tStart,
        timelineEndMs: tEnd,
        sourceInMs: sIn,
        sourceOutMs: sIn + (b - a),
        volume: 1 / STEM_MIX_NORMALIZATION,
      });
    }
  }
  return clips;
}

/** Insert the two stem tracks right after the main audio track (idempotent). */
export function ensureStemTracks(
  tracks: CompositionTrack[],
  ids: { board: string; ambient: string },
  mainAudioTrackId: string,
): CompositionTrack[] {
  const out = tracks.filter((t) => t.id !== ids.board && t.id !== ids.ambient);
  const mk = (id: string, label: string): CompositionTrack => ({ id, type: 'audio', label, locked: false, muted: false, visible: true });
  const stem = [mk(ids.board, STEM_TRACK_LABELS.board), mk(ids.ambient, STEM_TRACK_LABELS.ambient)];
  const idx = out.findIndex((t) => t.id === mainAudioTrackId);
  if (idx >= 0) out.splice(idx + 1, 0, ...stem);
  else out.push(...stem);
  return out;
}

export function hasStemTracks(tracks: CompositionTrack[], ids: { board: string; ambient: string }): boolean {
  return tracks.some((t) => t.id === ids.board) || tracks.some((t) => t.id === ids.ambient);
}
