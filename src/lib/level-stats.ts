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
