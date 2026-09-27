import type { CompositionClip, CompositionTrack } from '@/types/project';

/**
 * Can this clip live on that track? Images and gifs share the 'image' tracks;
 * everything else must match its own type. The same rule the cross-track drag
 * has always used — hoisted here so paste, drag and both editors can never
 * drift apart.
 */
export function clipFitsTrack(clipType: CompositionClip['type'], trackType: string): boolean {
  return clipType === 'image' || clipType === 'gif' ? trackType === 'image' : clipType === trackType;
}

/**
 * Where a pasted clip lands. In order:
 *  1. the ACTIVE track (the one the user last clicked) when it is unlocked and
 *     takes this clip's type — "marca la pista donde se va a pegar";
 *  2. the clip's own track, which is what paste always did;
 *  3. the first unlocked compatible track, so a clip copied from a reel that
 *     had an extra track (ra3) does not land on a track this reel lacks — it
 *     used to become invisible while still playing in the export.
 */
export function resolvePasteTrackId(
  clip: CompositionClip,
  tracks: CompositionTrack[],
  activeTrackId: string | null,
): string {
  const active = activeTrackId ? tracks.find((t) => t.id === activeTrackId) : undefined;
  if (active && !active.locked && clipFitsTrack(clip.type, active.type)) return active.id;
  if (tracks.some((t) => t.id === clip.trackId)) return clip.trackId;
  const fallback = tracks.find((t) => !t.locked && clipFitsTrack(clip.type, t.type));
  return fallback ? fallback.id : clip.trackId;
}
