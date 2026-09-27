import type { CompositionClip } from '@/types/project';

export interface ReelSourceMapping {
  /** Source time of the reel start (seek target in the muxed file). */
  sourceStartMs: number;
  /** Source time of the reel end. */
  sourceEndMs: number;
  /** Back-to-back source ranges when the compose range spans >1 v1 clip
   * (i.e. crosses compose cuts). Undefined for a single, contiguous clip. */
  sourceSegments?: { sourceInMs: number; sourceOutMs: number }[];
}

/**
 * Map a COMPOSE-timeline range [startMs, endMs] to source-file time(s) using the
 * compose v1 clips. The compose timeline is contiguous (cuts already removed),
 * so a range may overlap several v1 clips whose SOURCE positions are
 * discontinuous. Returns the seek bounds plus, when the range spans more than
 * one clip, the per-clip source segments so playback can skip the cut material.
 *
 * Falls back to identity mapping (source = compose) when there are no compose
 * clips — matches bits detected from the full transcription.
 */
export function mapComposeRangeToSource(
  composeClips: CompositionClip[] | undefined,
  startMs: number,
  endMs: number
): ReelSourceMapping {
  const spanning = (composeClips ?? [])
    .filter((c) => c.trackId === 'v1' && c.timelineEndMs > startMs && c.timelineStartMs < endMs)
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  if (spanning.length === 0) {
    return { sourceStartMs: startMs, sourceEndMs: endMs };
  }

  const segs = spanning.map((c) => {
    const cs = Math.max(c.timelineStartMs, startMs);
    const ce = Math.min(c.timelineEndMs, endMs);
    const sin = c.sourceInMs + (cs - c.timelineStartMs);
    return { sourceInMs: sin, sourceOutMs: sin + (ce - cs) };
  });

  return {
    sourceStartMs: segs[0].sourceInMs,
    sourceEndMs: segs[segs.length - 1].sourceOutMs,
    sourceSegments: segs.length > 1 ? segs : undefined,
  };
}
