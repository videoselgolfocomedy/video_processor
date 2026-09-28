import type { ProjectPart } from '@/types/project';

/**
 * Where a part's mix starts inside each source file, in ONE place.
 *
 * Offset convention: positive = the mesa started before the camera, so mesa
 * time = camera time + offset. Without a video range the mix starts where both
 * files exist (camera trim max(0, −offset), mesa trim max(0, offset)). With a
 * `videoRangeMs` the part is only that stretch of the video: the camera trim
 * is the range start (never before the mesa exists), the mesa trim follows by
 * the offset, and `capMs` bounds the mix at the range end. Every consumer of
 * the offset — worker, preview, auto-raises, stems, region clocks — goes
 * through here so the clocks never disagree.
 */
export function partTrims(part: Pick<ProjectPart, 'alignmentOffsetMs' | 'videoRangeMs'>): {
  boardTrimMs: number;
  ambientTrimMs: number;
  /** Max mix length (ms) imposed by the video range; null = until a file ends. */
  capMs: number | null;
} {
  const off = part.alignmentOffsetMs ?? 0;
  const r = part.videoRangeMs;
  const start = r ? Math.max(r.startMs, 0) : 0;
  const ambientTrimMs = Math.max(start, Math.max(0, -off));
  const boardTrimMs = ambientTrimMs + off;
  const capMs = r ? Math.max(100, r.endMs - ambientTrimMs) : null;
  return { boardTrimMs, ambientTrimMs, capMs };
}

/**
 * The stretch of each source file the part's mix actually plays, on the file's
 * own clock. The end is the video range's cap, else the mixed duration; absent
 * when neither is known yet (never mixed, whole video).
 */
export function partUsedRanges(part: Pick<ProjectPart, 'alignmentOffsetMs' | 'videoRangeMs' | 'muxedDurationMs'>): {
  board: { startMs: number; endMs?: number };
  ambient: { startMs: number; endMs?: number };
} {
  const { boardTrimMs, ambientTrimMs, capMs } = partTrims(part);
  const lenMs = capMs ?? (part.muxedDurationMs && part.muxedDurationMs > 0 ? part.muxedDurationMs : null);
  return {
    board: { startMs: boardTrimMs, endMs: lenMs != null ? boardTrimMs + lenMs : undefined },
    ambient: { startMs: ambientTrimMs, endMs: lenMs != null ? ambientTrimMs + lenMs : undefined },
  };
}

/** Identity of a video range for "was the picture cut for this?" checks. */
export function videoRangeKey(part: Pick<ProjectPart, 'videoRangeMs'>): string {
  const r = part.videoRangeMs;
  return r ? `${Math.round(r.startMs)}-${Math.round(r.endMs)}` : 'full';
}

export const fmtMs = (ms: number): string => {
  const s = Math.max(0, ms) / 1000;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
