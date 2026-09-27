import { stemKindOfTrack } from '@/lib/audio-stems';
import type { CompositionTrack } from '@/types/project';

/** Plain tracks (video, audio, image, text). */
export const TRACK_HEIGHT = 48;
/** The mesa/ambiente stem tracks: waveform + gain line + region controls need the room. */
export const STEM_TRACK_HEIGHT = 96;

export function trackHeightOf(track: Pick<CompositionTrack, 'id'>): number {
  return stemKindOfTrack(track.id) ? STEM_TRACK_HEIGHT : TRACK_HEIGHT;
}

/**
 * Which row a vertical mouse delta lands on, walking the REAL track heights
 * from the centre of the origin row (equivalent to `round(dy / 48)` when all
 * rows are 48 px). Returns the index delta, clamped to the track list.
 */
export function rowDeltaForDy(tracks: Array<Pick<CompositionTrack, 'id'>>, fromIdx: number, dy: number): number {
  if (fromIdx < 0 || fromIdx >= tracks.length) return 0;
  const tops: number[] = [];
  let acc = 0;
  for (const t of tracks) { tops.push(acc); acc += trackHeightOf(t); }
  const y = tops[fromIdx] + trackHeightOf(tracks[fromIdx]) / 2 + dy;
  if (y < 0) return -fromIdx;
  if (y >= acc) return tracks.length - 1 - fromIdx;
  for (let i = 0; i < tracks.length; i++) {
    if (y >= tops[i] && y < tops[i] + trackHeightOf(tracks[i])) return i - fromIdx;
  }
  return 0;
}
