import type { BoardDuckRegion } from '@/types/project';
import { levelerCurvePoints } from '@/lib/leveler-curve';

/**
 * Build the FFmpeg `volume` expression for a time-varying attenuation
 * ("ducking") envelope over the board (mesa) audio, used to suppress the
 * comic's filler sounds ("je-je" chuckles, "eehh" fillers) picked up by the
 * mic. Meant to be applied as:
 *
 *     [0:a]volume=eval=frame:volume='<expr>',atrim=...,asetpts,...
 *
 * BEFORE the atrim, so the region times are ABSOLUTE within the board wav —
 * the same timeline the detection script and the ducking editor render.
 *
 * The envelope is a PRODUCT of per-region trapezoid factors. Each enabled
 * region [s, e] with gain g = 10^(attenuationDb/20) contributes a factor that
 * is 1.0 outside [s-ramp, e+ramp], ramps linearly 1→g over [s-ramp, s], holds
 * g over [s, e], and ramps g→1 over [e, e+ramp]. The short ramps (default
 * 30 ms) avoid clicks at the region edges. Regions are expected disjoint
 * (the caller merges/normalizes); overlapping ramps just multiply, which
 * still produces a smooth, monotonic dip.
 *
 * Returns null when there is nothing to duck (no enabled regions, or every
 * region attenuates by ~0 dB) so callers can skip the filter entirely and keep
 * the original mix graph byte-for-byte.
 */
export function buildDuckVolumeExpr(
  regions: BoardDuckRegion[] | undefined,
  rampMs = 30,
): string | null {
  if (!regions || regions.length === 0) return null;

  const defaultRamp = Math.max(0.001, rampMs / 1000);

  const factors: string[] = [];
  for (const r of regions) {
    if (!r.enabled) continue;
    const s = Math.min(r.startMs, r.endMs) / 1000;
    const e = Math.max(r.startMs, r.endMs) / 1000;
    if (e <= s) continue;
    // Gain change < ~0.05 dB is a no-op — skip so we don't bloat the expr.
    if (!Number.isFinite(r.attenuationDb) || Math.abs(r.attenuationDb) < 0.05) continue;
    // linear gain: < 1 attenuates (ducking), > 1 boosts (ambient/laughs swell)
    const g = Math.pow(10, r.attenuationDb / 20);
    // Per-region fade lengths (outside the marked range) — the marked range is
    // the full-gain plateau. Fall back to the short anti-click ramp.
    const rampIn = r.fadeInMs != null ? Math.max(0.001, r.fadeInMs / 1000) : defaultRamp;
    const rampOut = r.fadeOutMs != null ? Math.max(0.001, r.fadeOutMs / 1000) : defaultRamp;
    const a = s - rampIn;  // ramp-in start
    const b = e + rampOut; // ramp-out end
    // Trapezoid window w(t) in [0,1]: rises over [a,s], 1 over [s,e], falls over [e,b].
    //   w = clip( min( (t-a)/rampIn, (b-t)/rampOut, 1 ), 0, 1 )
    // factor = 1 - (1-g)*w   (== 1 outside, == g inside the flat top).
    // Works for boosts too: g > 1 → depth negative → factor rises to g.
    const depth = (1 - g).toFixed(6);
    const w = `clip(min(min((t-${a.toFixed(3)})/${rampIn.toFixed(3)}\\,(${b.toFixed(3)}-t)/${rampOut.toFixed(3)})\\,1)\\,0\\,1)`;
    // 'curve' = smoothstep on the window (w²(3−2w)): the ramp eases in and
    // out instead of turning corners. The window is stored once with st()
    // inside if()'s condition — if() evaluates the branch strictly after the
    // condition, so ld() is safe — and w+1 ≥ 1 keeps the branch always taken.
    const win = r.fadeShape === 'curve'
      ? `if(st(0\\,${w})+1\\,ld(0)*ld(0)*(3-2*ld(0))\\,0)`
      : w;
    factors.push(`(1-${depth}*${win})`);
  }

  if (factors.length === 0) return null;
  return factors.join('*');
}

/* ── Voice leveling & voice-aware ambient ducking ───────────────────────── */

/**
 * Adaptive voice leveler for the BOARD (mesa) branch — FFmpeg `speechnorm`.
 *
 * Raises every stretch of voice toward a common ceiling (peak 0.95), each by
 * however much IT needs: quiet lines get up to `maxBoostDb` of gain, already-
 * loud lines get little or none. Gain moves smoothly (slow raise/fall per
 * half-cycle) so the relative shape of the performance survives — "sube todo
 * hasta el techo manteniendo las diferencias pero suavizadas". The threshold
 * keeps near-silence (room noise between words) from being dragged up.
 *
 * Meant to REPLACE the compand step (they fight over the same dynamics), and
 * to be followed by the existing alimiter for safety.
 */
export function buildSpeechLevelFilter(maxBoostDb = 12): string {
  const e = Math.pow(10, Math.max(0, Math.min(30, maxBoostDb)) / 20);
  // p: target peak · e: max expansion (boost cap) · r/f: gain raise/fall speed
  // per half-cycle (smaller = smoother) · t: below this amplitude the sample
  // is treated as silence and NOT boosted · l=1: link channels.
  // r/f 0.005: gain adapts over ~1 s — fast enough to catch a quiet line,
  // slow enough to keep the delivery's shape (verified on synthetic bursts:
  // 0.0005 needed ~10 s to reach the cap; 0.02 was instant/pumpy).
  return `speechnorm=p=0.95:e=${e.toFixed(4)}:r=0.005:f=0.005:t=0.02:l=1`;
}

/**
 * Ratio-based voice leveler for the BOARD branch — a `compand` transfer curve
 * ANCHORED to the measured integrated loudness (I, LUFS) of the mesa:
 *
 *   · the loudest voice (≈ I+12, speech crest) maps to `ceilingDb` — loud
 *     lines reach the ceiling but are NOT slammed into 0/the limiter;
 *   · below that, dynamics compress by `ratio`: a line 10 dB quieter than
 *     another ends up 10/ratio dB quieter — quiet zones get MORE absolute
 *     boost, yet the volume differences of the delivery stay audible;
 *   · below I−18 the curve knees down to unity by I−26, so breaths and room
 *     noise between phrases are not dragged up.
 *
 * Replaces the earlier speechnorm approach, which normalized EVERYTHING
 * toward the peak (cap-limited): loud hit the ceiling harshly while quiet got
 * only the same capped dB — the user heard exactly that and asked for this.
 * Verified on synthetic bursts (−6/−16/−28 dB, R=2, C=−3): → −4.4/−9.4/−16.2,
 * silence untouched.
 */
export function buildVoiceLevelerFilter(opts: {
  meanLUFS: number;
  /** Dynamics compression (2 = differences halved). 1.2–4. */
  ratio?: number;
  /** Where the LOUDEST voice ends up, dBFS. −12..−1, default −3. */
  ceilingDb?: number;
  /** Measured room noise of the part's window (see levelerCurvePoints). */
  noiseFloorDb?: number;
  /** The mesa gate runs before this leveler (knee under the floor). */
  gated?: boolean;
  /** User knee (see levelerCurvePoints.kneeDb). */
  kneeDb?: number;
}): string {
  // Loudest speech ≈ mean + 18 dB (LEVELER_CREST_DB). Measured on the user's
  // real mesa: the whole-night integrated loudness sits ~18 dB under the
  // loudest phrases (silences drag I down); with 12 the top of the set
  // overshot the curve into the limiter (max 0.0 dB — the harsh "acople" the
  // user reported). The breakpoints live in src/lib/leveler-curve.ts so the
  // UI draws exactly this curve.
  const pts = levelerCurvePoints(opts);
  const points = pts.map(([a, b]) => `${a.toFixed(1)}/${b.toFixed(1)}`).join('|');
  // attack 50 ms / decay 300 ms: gain rides the phrase envelope, not the
  // waveform; delay=attack gives the attack lookahead.
  return `compand=attacks=0.05:decays=0.30:points=${points}:soft-knee=4:delay=0.05`;
}

/**
 * Sidechain-duck the AMBIENT branch with the BOARD voice as the key:
 * while the comic speaks the ambient drops (fast ~15 ms attack — this is what
 * kills the roomy echo of the voice in the camera mic), and in every gap it
 * swells back over `releaseMs` (the fade-in of the laughter/audience).
 *
 * Duck depth is made DETERMINISTIC with the parallel-blend trick: the ducked
 * ("wet") copy is blended with a dry copy at weights (1-α, α) where
 * α = 10^(-depthDb/20); with a high ratio the wet copy squashes to ~nothing
 * under voice, so the output floor is exactly α → max attenuation = depthDb,
 * and silence passes bit-transparent (dry+wet sum back to 1.0).
 *
 * Returns filter_complex LINES. The caller must feed it a board label it no
 * longer uses directly — the helper splits it into `<board>M` (for the mix)
 * and an internal key copy.
 */
export function ambientSidechainDuckFilters(params: {
  boardLabel: string;    // input: processed board branch (post trim/gain)
  ambientLabel: string;  // input: processed ambient branch (post trim/volume)
  outLabel: string;      // output: ducked ambient
  depthDb?: number;
  releaseMs?: number;
  /** Linear level of the key considered "voice" — callers scale it to the
   *  measured board loudness (0.02 assumes a healthy ~-20 LUFS signal). */
  thresholdLin?: number;
  /** LOOKAHEAD: the sidechain key runs this many ms AHEAD of the mix, so the
   *  ambient ANTICIPATES the voice — it starts dropping before a phrase
   *  begins (no echo leak at the onset) and starts swelling before the
   *  phrase ends (the laugh is already up when the voice stops, even in
   *  short gaps). Offline luxury a live compressor can't do. Default 200. */
  anticipateMs?: number;
  /** ATTACK: ms the ambient takes to reach the duck floor once the key
   *  crosses the threshold (sidechaincompress attack). 5–500, default 15. */
  attackMs?: number;
  /** HOLD = MINIMUM PAUSE: ms the ambient STAYS ducked after the voice
   *  really stops before the release starts — so the short gaps between
   *  words never pump the ambient up; only a longer pause (end of a phrase
   *  or paragraph, or an attenuated je-je) lets it rise. Implemented on the
   *  KEY: a copy delayed by hold+anticipate is summed into it, so the
   *  compressor keeps "seeing" voice until exactly `hold` ms after the real
   *  end of the voice, regardless of the lookahead. 0–2000, default 600. */
  holdMs?: number;
  /** GAP BOOST: dB the ambient is RAISED in the gaps between phrases (the
   *  laughs/audience come up), while the voice-time level stays at −depthDb
   *  vs the ORIGINAL: the branch is pre-gained by +boost and the duck floor
   *  deepened by the same amount. 0–12, default 0. */
  gapBoostDb?: number;
}): string[] {
  const depth = Math.max(1, Math.min(60, params.depthDb ?? 8));
  const release = Math.max(50, Math.min(3000, Math.round(params.releaseMs ?? 400)));
  const attack = Math.max(5, Math.min(500, Math.round(params.attackMs ?? 15)));
  const hold = Math.max(0, Math.min(2000, Math.round(params.holdMs ?? 600)));
  const gapBoost = Math.max(0, Math.min(12, params.gapBoostDb ?? 0));
  // Floor relative to the (pre-gained) branch = −(depth + gapBoost), so that
  // relative to the ORIGINAL ambient: gaps sit at +gapBoost, voice at −depth.
  const alpha = Math.pow(10, -(depth + gapBoost) / 20);
  const b = params.boardLabel;
  const a = params.ambientLabel;
  const thr = (params.thresholdLin ?? 0.02).toFixed(4);
  const anticipate = Math.max(0, Math.min(1000, Math.round(params.anticipateMs ?? 200)));
  const lines: string[] = [`[${b}]asplit=2[${b}M][${b}Kp]`];
  // Key prep: anticipation (lookahead) → optional hold → split for the two stages.
  lines.push(anticipate > 0
    ? `[${b}Kp]atrim=start=${(anticipate / 1000).toFixed(3)},asetpts=PTS-STARTPTS[${b}Ka]`
    : `[${b}Kp]anull[${b}Ka]`);
  if (hold > 0) {
    // The anticipated key runs `anticipate` ms early, so its held tail would
    // end `anticipate` ms BEFORE hold expires; delaying the copy by
    // hold+anticipate makes the minimum pause count from the REAL voice end.
    lines.push(`[${b}Ka]asplit=2[${b}Kh0][${b}Kh1]`);
    lines.push(`[${b}Kh1]adelay=delays=${hold + anticipate}:all=1[${b}Kh1d]`);
    lines.push(`[${b}Kh0][${b}Kh1d]amix=inputs=2:normalize=0,asplit=2[${b}K1][${b}K2]`);
  } else {
    lines.push(`[${b}Ka]asplit=2[${b}K1][${b}K2]`);
  }
  lines.push(gapBoost > 0
    ? `[${a}]volume=${gapBoost.toFixed(2)}dB,asplit=2[${a}D][${a}W]`
    : `[${a}]asplit=2[${a}D][${a}W]`);
  // Default threshold 0.02 ≈ −34 dBFS assumes a healthy (~-20 LUFS) key;
  // pass thresholdLin scaled to the measured board level otherwise.
  // TWO sidechain stages in series: one stage's gain reduction tops out at
  // (key − threshold)·0.95 ≈ 28 dB on real material, so deep settings
  // (30–60 dB) never reached their depth — the wet residual dominated the
  // blend floor. Two stages double the reduction and the α floor governs
  // again (verified: 40 dB setting → −39.4 dB measured).
  lines.push(`[${a}W][${b}K1]sidechaincompress=threshold=${thr}:ratio=20:attack=${attack}:release=${release}:makeup=1[${a}W1]`);
  lines.push(`[${a}W1][${b}K2]sidechaincompress=threshold=${thr}:ratio=20:attack=${attack}:release=${release}:makeup=1[${a}WD]`);
  lines.push(`[${a}D][${a}WD]amix=inputs=2:weights='${alpha.toFixed(6)} ${(1 - alpha).toFixed(6)}':normalize=0[${params.outLabel}]`);
  return lines;
}
