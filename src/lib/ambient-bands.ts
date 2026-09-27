import type { BoardDuckRegion, ProjectPart } from '@/types/project';

/**
 * Manual AMBIENT LEVEL zones (`part.ambientBoostRegions`), shared by the engine
 * (part-mix-chain bakes them into the pre-computed curve), the timeline's
 * forecast (ambient-plan) and the editor.
 *
 * Meaning: a zone's `attenuationDb` is the level over the ORIGINAL ambient in
 * its plateau — the same scale as a "+4 dB auto" box — and inside the zone
 * (cross-faded over its ramps) it REPLACES whatever the automatic curve
 * decided there. So "make that +4 automatic raise a +6" is a +6 zone, and a
 * +4 zone drawn over the raise sounds exactly like the raise.
 *
 * It used to ADD to the curve instead (a +6 zone in a ducked stretch landed at
 * −2, on top of a raise at +10; a taken-over +4 raise was stored as +12) —
 * which is what the user read as "the +4 zones sound much louder" and "+26 /
 * +22 bands next to +4 boxes". Parts mixed under that meaning carry no
 * `ambientBandsAbsolute` flag: `absoluteAmbientBands` converts each zone by
 * the level it actually produced at its plateau centre, so nothing changes
 * audibly when an old project is opened.
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The curve's two resting levels: `lo` under voice, `hi` inside an automatic raise (0/0 with the duck off). */
export function ambientBaseLevels(part: ProjectPart): { lo: number; hi: number } {
  if (!part.ambientDuckOnVoice) return { lo: 0, hi: 0 };
  return {
    lo: -clamp(part.ambientVoiceDuckDb ?? 8, 1, 60),
    hi: clamp(part.ambientGapBoostDb ?? 0, 0, 12),
  };
}

/** The window weight (0..1) of a zone at `t` (its own clock): 1 in the plateau,
 *  a ramp of `fadeInMs`/`fadeOutMs` OUTSIDE the marked range (30 ms when
 *  absent — the anti-click default of buildDuckVolumeExpr), S-shaped when the
 *  zone says `curve`. */
export function bandWeightAt(r: Pick<BoardDuckRegion, 'startMs' | 'endMs' | 'fadeInMs' | 'fadeOutMs' | 'fadeShape'>, t: number): number {
  const s = Math.min(r.startMs, r.endMs), e = Math.max(r.startMs, r.endMs);
  const fi = r.fadeInMs != null ? Math.max(0, r.fadeInMs) : 30;
  const fo = r.fadeOutMs != null ? Math.max(0, r.fadeOutMs) : 30;
  let u = 0;
  if (t >= s && t <= e) u = 1;
  else if (fi > 0 && t >= s - fi && t < s) u = (t - (s - fi)) / fi;
  else if (fo > 0 && t > e && t <= e + fo) u = 1 - (t - e) / fo;
  if (u <= 0) return 0;
  return r.fadeShape === 'curve' ? u * u * (3 - 2 * u) : u;
}

/** Does any persisted automatic raise (minus the vetoes) cover `t`? The old
 *  meaning's base under a zone: `hi` there, `lo` elsewhere. */
function insideAutoRaise(part: ProjectPart, t: number): boolean {
  if (!part.ambientDuckOnVoice) return false;
  for (const v of part.ambientNoRaiseRegions ?? []) {
    if (!v.enabled) continue;
    if (t >= Math.min(v.startMs, v.endMs) && t <= Math.max(v.startMs, v.endMs)) return false;
  }
  for (const a of part.ambientAutoRaises ?? []) {
    if (t >= Math.min(a.startMs, a.endMs) && t <= Math.max(a.startMs, a.endMs)) return true;
  }
  return false;
}

/** The part's zones with ABSOLUTE levels — as stored when the part carries
 *  `ambientBandsAbsolute`, converted from the old additive meaning otherwise:
 *  the level the zone's plateau centre really got, i.e. the curve's base there
 *  plus EVERY enabled zone covering that point (old zones stacked — a second
 *  copy drawn over a taken-over raise doubled it, and the inner copy keeps
 *  that sum so the sound stays put). */
export function absoluteAmbientBands(part: ProjectPart): BoardDuckRegion[] {
  const bands = part.ambientBoostRegions ?? [];
  if (part.ambientBandsAbsolute || bands.length === 0) return bands;
  const { lo, hi } = ambientBaseLevels(part);
  return bands.map((r) => {
    const centre = (Math.min(r.startMs, r.endMs) + Math.max(r.startMs, r.endMs)) / 2;
    let level = insideAutoRaise(part, centre) ? hi : lo;
    for (const o of bands) {
      if (!o.enabled) continue;
      if (centre >= Math.min(o.startMs, o.endMs) && centre <= Math.max(o.startMs, o.endMs)) level += o.attenuationDb;
    }
    if (!r.enabled) level += r.attenuationDb; // a disabled zone: what it would do if switched on
    return { ...r, attenuationDb: Math.round(level * 10) / 10 };
  });
}

/**
 * One-time conversion of a part to the absolute meaning (null = already
 * converted): zones re-levelled by `absoluteAmbientBands`, and every veto that
 * sits under a zone (≥ half of the veto inside it) LINKED to that zone as its
 * owner — that is how a taken-over raise was stored (veto over the engine's
 * span + a band on it), and under the new meaning the band alone is the
 * visible thing. Vetoes with no zone over them keep their own life.
 */
export function migrateAmbientBands(part: ProjectPart): ProjectPart | null {
  if (part.ambientBandsAbsolute) return null;
  const bands = absoluteAmbientBands(part);
  const vetoes = (part.ambientNoRaiseRegions ?? []).map((v) => {
    if (v.ownerId) return v;
    const vs = Math.min(v.startMs, v.endMs), ve = Math.max(v.startMs, v.endMs);
    let best: { id: string; overlap: number } | null = null;
    for (const b of bands) {
      const overlap = Math.min(ve, Math.max(b.startMs, b.endMs)) - Math.max(vs, Math.min(b.startMs, b.endMs));
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { id: b.id, overlap };
    }
    return best && best.overlap >= (ve - vs) / 2 ? { ...v, ownerId: best.id } : v;
  });
  return {
    ...part,
    ambientBandsAbsolute: true,
    ...(part.ambientBoostRegions ? { ambientBoostRegions: bands } : {}),
    ...(part.ambientNoRaiseRegions ? { ambientNoRaiseRegions: vetoes } : {}),
  };
}
