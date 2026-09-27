import type { ProjectPart } from '@/types/project';
import { absoluteAmbientBands, ambientBaseLevels, bandWeightAt } from '@/lib/ambient-bands';

/**
 * What the ambient gain WILL be after "Aplicar", computed from the part's
 * edit state alone — so the timeline can repaint the moment the user vetoes
 * an automatic raise or draws a manual zone, instead of waiting for the
 * re-mix. Mirrors the engine's shape (see ambient-gain-curve.ts): the voice
 * level `lo = −ambientVoiceDuckDb` everywhere, `hi = +ambientGapBoostDb`
 * inside the persisted automatic raises minus the "no raise" vetoes (rising
 * over `release` ms, falling over `attack` ms); then every manual LEVEL zone
 * REPLACES that with its own dB inside its span (cross-faded over its ramps,
 * linear or S-shaped — applyManualBandsDb does the same on the real curve);
 * plus the part's ambient volume — the stems on disk carry that volume too,
 * so applied and planned lines share a scale. Times are the MIX clock (what
 * the stem clips and the lane draw); regions live on the camera-wav clock,
 * `ambientTrimMs` later.
 */
export interface AmbientPlan { gainDbAt: (mixMs: number) => number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function buildAmbientPlan(part: ProjectPart, ambientTrimMs: number): AmbientPlan {
  const volDb = 20 * Math.log10(Math.max(1e-4, part.ambientVolume ?? 0.7));
  const duck = !!part.ambientDuckOnVoice;
  const { lo, hi } = ambientBaseLevels(part);
  const release = clamp(part.ambientVoiceReleaseMs ?? 400, 50, 3000);
  const attack = clamp(part.ambientVoiceAttackMs ?? 15, 5, 500);

  // Every veto counts — the ones drawn by hand, the ones left by ✕ on a box
  // and the invisible ones a taken-over raise carries.
  const vetoes = (part.ambientNoRaiseRegions ?? [])
    .filter((r) => r.enabled)
    .map((r) => [Math.min(r.startMs, r.endMs), Math.max(r.startMs, r.endMs)] as [number, number]);
  let raises: Array<[number, number]> = duck
    ? (part.ambientAutoRaises ?? []).map((r) => [Math.min(r.startMs, r.endMs), Math.max(r.startMs, r.endMs)] as [number, number])
    : [];
  for (const [va, vb] of vetoes) {
    raises = raises.flatMap(([a, b]) => {
      if (vb <= a || va >= b) return [[a, b] as [number, number]];
      const out: Array<[number, number]> = [];
      if (va > a) out.push([a, va]);
      if (vb < b) out.push([vb, b]);
      return out;
    });
  }
  raises = raises.filter(([a, b]) => b - a >= 100).sort((x, y) => x[0] - y[0]);

  const manual = absoluteAmbientBands(part).filter((r) => r.enabled);

  return {
    gainDbAt: (mixMs: number) => {
      const t = mixMs + ambientTrimMs;
      let level = 0;
      if (duck) {
        let w = 0;
        for (const [a, b] of raises) {
          if (t < a) break;
          if (t <= b) { w = Math.max(w, Math.min(1, (t - a) / release)); break; }
          if (t <= b + attack) w = Math.max(w, 1 - (t - b) / attack);
        }
        level = lo + (hi - lo) * w;
      }
      for (const r of manual) {
        const u = bandWeightAt(r, t);
        if (u > 0) level = level * (1 - u) + r.attenuationDb * u;
      }
      return volDb + level;
    },
  };
}
