import { useReelStore } from '@/stores/reel-store';
import { useProjectStore } from '@/stores/project-store';

export interface ActiveTransform {
  scale: number;
  x: number;
  y: number;
  rotation: number;
}

/**
 * Resolve the per-clip motion transform (zoom/position/rotation) that applies
 * to the reel preview RIGHT NOW. Reads live store state (call inside a draw
 * loop). Mirrors the logic in reel-video-player:
 *  - timeline phase → the rv1 clip covering currentTimeMs
 *  - setup phase     → the compose v1 clip covering the current source position
 *    (the reel has no clips yet, so inherit straight from compose)
 */
export function getActiveReelTransform(reelId: string): ActiveTransform | undefined {
  const rs = useReelStore.getState();
  const reel = rs.reels.find((r) => r.id === reelId);
  if (!reel) return undefined;
  const currentTimeMs = rs.currentTimeMs;

  if (rs.phase === 'timeline') {
    const rv1 = reel.composition.clips
      .filter((c) => c.trackId === 'rv1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const active = rv1.find((c) => currentTimeMs >= c.timelineStartMs && currentTimeMs < c.timelineEndMs) ?? rv1[0];
    return active?.transform as ActiveTransform | undefined;
  }

  const compose = useProjectStore.getState().currentProject?.composition?.clips ?? [];
  const srcStartMs = reel.sourceStartMs ?? reel.startMs;
  const curSourceMs = srcStartMs + currentTimeMs;
  const v1 = compose
    .filter((c) => c.trackId === 'v1')
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const inSrc = v1.find((c) => curSourceMs >= c.sourceInMs && curSourceMs < c.sourceOutMs);
  const overlap = v1.find((c) => c.timelineEndMs > reel.startMs && c.timelineStartMs < reel.endMs);
  return (inSrc ?? overlap)?.transform as ActiveTransform | undefined;
}

/** True when the transform actually changes the frame. */
export function isNonIdentity(t?: ActiveTransform): boolean {
  if (!t) return false;
  return Math.abs((t.scale ?? 1) - 1) > 0.001 || Math.abs(t.x ?? 0) > 0.001 || Math.abs(t.y ?? 0) > 0.001 || Math.abs(t.rotation ?? 0) > 0.001;
}

/**
 * Apply the transform to a 2D canvas context around the canvas center, matching
 * the CSS `translate(x%,y%) rotate(deg) scale(s)` used in the DOM preview and
 * the `scale → rotate → overlay` math in the FFmpeg export. Call between a
 * black fillRect and the drawImage(0,0,cw,ch); the caller is responsible for
 * ctx.save()/ctx.restore() (returns whether it applied anything).
 */
export function applyCanvasTransform(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  t?: ActiveTransform
): boolean {
  if (!isNonIdentity(t)) return false;
  const scale = t!.scale ?? 1;
  const x = t!.x ?? 0;
  const y = t!.y ?? 0;
  const rot = t!.rotation ?? 0;
  ctx.translate(cw / 2 + x * cw, ch / 2 + y * ch);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.translate(-cw / 2, -ch / 2);
  return true;
}
