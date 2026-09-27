// Module-level clipboard for a clip's Motion transform (zoom/position/angle),
// so it survives copying in one clip's Properties panel and pasting into
// another's — same "module variable, not React state" pattern as the reel
// clip/subtitle clipboards in reel-store.ts. Shared between Compose and Reels
// (both use the same CompositionClip.transform shape) so a copy in one editor
// can be pasted in the other too.

export interface ClipMotionTransform {
  scale: number;
  x: number;
  y: number;
  rotation: number;
}

let clipboard: ClipMotionTransform | null = null;

export function copyMotionTransform(t: { scale: number; x: number; y: number; rotation?: number }): void {
  clipboard = { scale: t.scale, x: t.x, y: t.y, rotation: t.rotation ?? 0 };
}

export function getMotionTransform(): ClipMotionTransform | null {
  return clipboard ? { ...clipboard } : null;
}

export function hasMotionTransform(): boolean {
  return clipboard !== null;
}
