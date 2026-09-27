import type { ClipGainRegion, CompositionClip, BoardDuckRegion } from '@/types/project';

/**
 * Volume automation inside an audio clip, shared by the previews (JS, per
 * frame) and the export (FFmpeg, via buildDuckVolumeExpr) so both hear the
 * same thing. Zone times are the clip's OWN file clock, the plateau is
 * [startMs, endMs] and the fades sit OUTSIDE it — the same convention the
 * mesa/ambient zones use.
 */

/** The anti-click ramp a zone gets when it asks for no fade (matches buildDuckVolumeExpr). */
const DEFAULT_RAMP_MS = 30;
const smooth = (u: number) => u * u * (3 - 2 * u);

/** Linear gain of the zones at a point in the clip's file clock (1 = untouched). */
export function regionGainAt(regions: ClipGainRegion[] | undefined, sourceMs: number): number {
  if (!regions || regions.length === 0) return 1;
  let g = 1;
  for (const r of regions) {
    if (!Number.isFinite(r.db) || Math.abs(r.db) < 0.05) continue;
    const s = Math.min(r.startMs, r.endMs);
    const e = Math.max(r.startMs, r.endMs);
    if (e <= s) continue;
    const rampIn = Math.max(0.001, (r.fadeInMs ?? DEFAULT_RAMP_MS));
    const rampOut = Math.max(0.001, (r.fadeOutMs ?? DEFAULT_RAMP_MS));
    // Trapezoid window: rises over [s−rampIn, s], 1 over [s, e], falls over [e, e+rampOut].
    let w = Math.min(Math.min((sourceMs - (s - rampIn)) / rampIn, ((e + rampOut) - sourceMs) / rampOut), 1);
    w = Math.max(0, Math.min(1, w));
    if (w <= 0) continue;
    if (r.fadeShape === 'curve') w = smooth(w);
    const lin = Math.pow(10, r.db / 20);
    g *= 1 - (1 - lin) * w;
  }
  return g;
}

/** The clip's static volume times its automation at that point. */
export function clipGainAt(clip: Pick<CompositionClip, 'volume' | 'gainRegions'>, sourceMs: number): number {
  return (clip.volume ?? 1) * regionGainAt(clip.gainRegions, sourceMs);
}

/** The loudest this clip can get — decides whether playback needs a GainNode. */
export function maxClipGain(clip: Pick<CompositionClip, 'volume' | 'gainRegions'>): number {
  const boost = (clip.gainRegions ?? []).reduce((m, r) => Math.max(m, r.db > 0 ? Math.pow(10, r.db / 20) : 1), 1);
  return (clip.volume ?? 1) * boost;
}

/** The zones that actually touch a clip's used range. */
export function activeGainRegions(clip: CompositionClip): ClipGainRegion[] {
  const a = clip.sourceInMs ?? 0;
  const b = clip.sourceOutMs ?? a;
  return (clip.gainRegions ?? []).filter((r) => {
    const s = Math.min(r.startMs, r.endMs) - (r.fadeInMs ?? DEFAULT_RAMP_MS);
    const e = Math.max(r.startMs, r.endMs) + (r.fadeOutMs ?? DEFAULT_RAMP_MS);
    return e > a && s < b;
  });
}

/**
 * The same zones as the shape buildDuckVolumeExpr eats, shifted into the clock
 * of the stream the filter runs on (`shiftMs` = where that stream starts in the
 * clip's file clock — the segment's own seek, not the clip's).
 */
export function toDuckRegions(regions: ClipGainRegion[] | undefined, shiftMs: number): BoardDuckRegion[] {
  return (regions ?? []).map((r) => ({
    id: r.id,
    startMs: Math.min(r.startMs, r.endMs) - shiftMs,
    endMs: Math.max(r.startMs, r.endMs) - shiftMs,
    attenuationDb: r.db,
    source: 'manual' as const,
    enabled: true,
    fadeInMs: r.fadeInMs,
    fadeOutMs: r.fadeOutMs,
    fadeShape: r.fadeShape,
  }));
}
