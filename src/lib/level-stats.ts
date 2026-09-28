/**
 * Level readouts from an amplitude envelope (|peak|/32768 per hop, as served
 * by /api/projects/[id]/audio/envelope) — the numbers behind "de qué valores
 * viene la señal y en cuáles queda": room floor, typical voice, loud voice,
 * absolute peak, all in dBFS.
 *
 *   floor   = 10th percentile of all hops (room noise between phrases)
 *   voiced  = hops at least 12 dB above the floor (and above −60 dBFS)
 *   typical = median of the voiced hops
 *   loud    = 95th percentile of the voiced hops
 *   peak    = loudest hop
 */
export interface LevelStats {
  peakDb: number;
  loudDb: number;
  typicalDb: number;
  floorDb: number;
  /** Share of hops considered voiced (0..1) — sanity check for the readout. */
  voicedFrac: number;
}

function toDb(v: number): number {
  return 20 * Math.log10(Math.max(1e-4, v));
}

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return -80;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[i];
}

export function computeLevelStats(envelope: ArrayLike<number>, from = 0, to = envelope.length): LevelStats | null {
  const n = Math.max(0, Math.min(envelope.length, to) - Math.max(0, from));
  if (n < 8) return null;
  const db = new Array<number>(n);
  let peak = -80;
  for (let i = 0; i < n; i++) {
    const d = toDb(envelope[from + i]);
    db[i] = d;
    if (d > peak) peak = d;
  }
  const sorted = [...db].sort((a, b) => a - b);
  const floor = percentileSorted(sorted, 0.10);
  const gate = Math.max(-60, floor + 12);
  const voiced = sorted.filter((d) => d >= gate);
  if (voiced.length < 4) {
    return { peakDb: peak, loudDb: peak, typicalDb: percentileSorted(sorted, 0.5), floorDb: floor, voicedFrac: 0 };
  }
  return {
    peakDb: peak,
    loudDb: percentileSorted(voiced, 0.95),
    typicalDb: percentileSorted(voiced, 0.5),
    floorDb: floor,
    voicedFrac: voiced.length / n,
  };
}

export function fmtDb(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

export function fmtDelta(after: number, before: number): string {
  const d = after - before;
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
}

/**
 * Applied gain per column (processed ÷ original, dB) as a CONTINUOUS series.
 * Columns where the ratio cannot be computed (digital silence on either side)
 * hold the nearest known value instead of breaking the line: on a mesa
 * recorded low the original sits under −50 dBFS most of the time and a line
 * that only existed above that level vanished exactly where the chain does
 * the most (pauses, quiet words). Returns null when no column is measurable.
 */
export function continuousGainDb(orig: ArrayLike<number>, proc: ArrayLike<number>, procGain = 1): Float32Array | null {
  const n = Math.min(orig.length, proc.length);
  const out = new Float32Array(n);
  const MIN = 1e-5; // −100 dBFS: below it the peaks are rounding, not signal
  let first = -1;
  let last = 0;
  for (let x = 0; x < n; x++) {
    const r = orig[x], q = proc[x] * procGain;
    if (r >= MIN && q >= MIN) {
      last = 20 * Math.log10(q / r);
      if (first < 0) first = x;
    }
    out[x] = last;
  }
  if (first < 0) return null;
  for (let x = 0; x < first; x++) out[x] = out[first];
  return out;
}

/**
 * Vertical scale (dB) for the applied-gain line: the default window, widened
 * in 6 dB steps when the gain goes beyond it — a mesa recorded low gets +45 dB
 * and a line clamped to a +24 top sat glued to the edge, invisible.
 */
export function gainScale(db: ArrayLike<number> | null, lo: number, hi: number): { lo: number; hi: number } {
  if (!db || !db.length) return { lo, hi };
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < db.length; i++) { const v = db[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  return {
    lo: Math.max(-72, Math.min(lo, Math.floor((mn - 3) / 6) * 6)),
    hi: Math.min(72, Math.max(hi, Math.ceil((mx + 3) / 6) * 6)),
  };
}
