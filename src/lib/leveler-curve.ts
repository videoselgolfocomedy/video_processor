/**
 * The ratio voice-leveler transfer curve (input dB → output dB), shared by the
 * FFmpeg compand builder (server, audio-duck.ts) and the UI drawing so the
 * picture IS the filter. Anchored to the measured integrated loudness I:
 *   · loudest voice (≈ I + CREST) → ceiling C
 *   · below it: differences divided by `ratio` (quiet lines get MORE boost)
 *   · knee to unity between I−18 and I−26 (room noise untouched)
 *   · gentle 8:1 stop above the crest (claps) — the limiter finishes the job
 */
export const LEVELER_CREST_DB = 18;

export interface LevelerCurveOpts {
  meanLUFS: number;
  /** Dynamics compression (2 = differences halved). Clamped 1.2–4. */
  ratio?: number;
  /** Where the LOUDEST voice ends up, dBFS. Clamped −12..−1, default −3. */
  ceilingDb?: number;
  /** Measured room noise of the window on the compand's own scale (p10 of a
   *  50 ms-attack / 300 ms-decay envelope follower, dBFS). When given, the
   *  unity knee never sits under the room: gLo ≥ floor+4, vLo ≥ floor+12 — an
   *  8 dB ramp, so the room's louder moments get a few dB, not forty. */
  noiseFloorDb?: number;
  /** A gate runs BEFORE the leveler (the room between phrases is already
   *  −24 dB): the knee then sits UNDER the floor (floor−10 → floor−2) so the
   *  quiet tail of a word keeps the full curve instead of collapsing. */
  gated?: boolean;
  /** USER knee: input level (dBFS) below which the voice is left alone (vLo);
   *  the ramp to unity is 6 dB under it. Overrides the floor-derived knee. */
  kneeDb?: number;
}

/** Breakpoints [inDb, outDb] in ascending input order (compand `points`). */
export function levelerCurvePoints(opts: LevelerCurveOpts): Array<[number, number]> {
  const I = opts.meanLUFS;
  const R = Math.max(1.2, Math.min(4, opts.ratio ?? 2));
  const C = Math.max(-12, Math.min(-1, opts.ceilingDb ?? -3));
  const vHi = I + LEVELER_CREST_DB;
  let vLo = I - 18;
  let gLo = I - 26;
  if (opts.noiseFloorDb != null && Number.isFinite(opts.noiseFloorDb)) {
    // Anchored to a quiet window (a mesa that also recorded the dinner, a
    // low-gain night) I−18/I−26 can fall BELOW the room noise and the curve
    // would lift the room by 40 dB. The knee then rides the measured floor.
    if (opts.gated) {
      gLo = opts.noiseFloorDb - 10;
      vLo = opts.noiseFloorDb - 2;
    } else {
      // With a measured floor the knee is the FLOOR's, not the anchor's: the
      // ramp runs floor−2 → floor+4, so a word that fades to floor+4 keeps the
      // full curve and the room itself (p10) gets a third of the gain. It used
      // to be max(I−26, floor+4) → max(I−18, floor+12): with the anchor on the
      // real loud voice (18-sep: loud −11, quiet words −50…−54, floor −58)
      // I−18 = −47 won, and the last 10 dB of every quiet word sat inside the
      // knee — measured −50 → +23, −52 → +15, −54 → +6 while the phrase rose
      // +30 ("bajadas absurdas, se va la voz"). Now −50…−54 → +37…+40, room
      // at the floor +16, 2 dB under it unity.
      gLo = opts.noiseFloorDb - 2;
      vLo = opts.noiseFloorDb + 4;
    }
  }
  if (opts.kneeDb != null && Number.isFinite(opts.kneeDb)) {
    vLo = opts.kneeDb;
    gLo = opts.kneeDb - 6;
  }
  vLo = Math.min(vLo, I - 2);
  gLo = Math.min(gLo, vLo - 2);
  const f = (x: number) => C - (vHi - x) / R;
  return [
    [-90, -90],
    [gLo, gLo],
    [vLo, f(vLo)],
    [I, f(I)],
    [vHi, C],
    [20, C + (20 - vHi) / 8],
  ];
}

/** Piecewise-linear evaluation of the curve at an input level (dB). */
export function levelerOutputDb(inputDb: number, pts: Array<[number, number]>): number {
  if (inputDb <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (inputDb <= x1) {
      const f = x1 > x0 ? (inputDb - x0) / (x1 - x0) : 0;
      return y0 + (y1 - y0) * f;
    }
  }
  return pts[pts.length - 1][1];
}
