import type { CompositionClip } from '@/types/project';

export type FadeCurve = NonNullable<CompositionClip['fadeInCurve']>;

/**
 * Fade-in gain multiplier (0..1) at normalized progress p (0..1) for a given
 * curve shape. Mirrors the FFmpeg afade curves used on export so the live
 * preview and the rendered output ramp the same way.
 */
export function fadeInGain(p: number, curve: FadeCurve = 'linear'): number {
  const x = Math.max(0, Math.min(1, p));
  switch (curve) {
    case 'exponential':
      // Slow start, accelerates — soft entrance.
      return x * x;
    case 'logarithmic':
      // Fast start, eases out near the top.
      return Math.sqrt(x);
    case 'quarter-sine':
      // Very smooth S-less ramp (FFmpeg qsin).
      return Math.sin((x * Math.PI) / 2);
    case 'linear':
    default:
      return x;
  }
}

/** Map our curve names to FFmpeg afade `curve=` values. */
export function ffmpegFadeCurve(curve: FadeCurve = 'linear'): string {
  switch (curve) {
    case 'exponential': return 'exp';
    case 'logarithmic': return 'log';
    case 'quarter-sine': return 'qsin';
    case 'linear':
    default: return 'tri'; // triangular = linear ramp
  }
}
