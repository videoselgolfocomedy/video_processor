import { useReelStore } from '@/stores/reel-store';
import { useProjectStore } from '@/stores/project-store';
import { getOverlayVideoElement } from '@/components/reels/reel-video-ref';

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

// Cached offscreen 16:9 working canvas for drawTransformedCrop (module-level
// so the rAF draw loops don't allocate a canvas per frame).
let workCanvas: HTMLCanvasElement | null = null;

/**
 * WYSIWYG crop of a transformed frame: apply the clip's motion transform
 * (zoom/position/rotation) to the SOURCE 16:9 frame first, THEN sample the
 * 9:16 crop window from the transformed image. This matches what the user
 * sees in the setup view — the crop rectangle is drawn over the CSS-transformed
 * video — and the FFmpeg export order (transform → crop when both present).
 *
 * The old order (crop the raw source, then rotate the cropped patch) showed a
 * completely different region whenever the compose clip carried a rotation
 * (e.g. a sideways-recorded video straightened with rotation=90).
 *
 * With an identity transform this is a single drawImage — same as before.
 */
export function drawTransformedCrop(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  outW: number,
  outH: number,
  srcW: number,
  srcH: number,
  crop: { centerX: number; centerY: number; scale: number },
  t?: ActiveTransform
): void {
  const cropPixH = srcH * crop.scale;
  const cropPixW = cropPixH * (9 / 16);
  const sx = crop.centerX * srcW - cropPixW / 2;
  const sy = crop.centerY * srcH - cropPixH / 2;

  if (!isNonIdentity(t)) {
    ctx.drawImage(video, Math.max(0, sx), Math.max(0, sy), cropPixW, cropPixH, 0, 0, outW, outH);
    return;
  }

  // Work canvas: 16:9 at capped resolution (perf) — crop coords scale by k.
  const workW = Math.min(srcW, 1280);
  const k = workW / srcW;
  const workH = Math.round(srcH * k);
  if (!workCanvas || workCanvas.width !== workW || workCanvas.height !== workH) {
    workCanvas = document.createElement('canvas');
    workCanvas.width = workW;
    workCanvas.height = workH;
  }
  const wctx = workCanvas.getContext('2d');
  if (!wctx) return;

  // Transparent gaps — the caller already painted the backgroundColor on the
  // output canvas, so exposed corners show it (matches export).
  wctx.clearRect(0, 0, workW, workH);
  const scale = t!.scale ?? 1;
  const x = t!.x ?? 0;
  const y = t!.y ?? 0;
  const rot = t!.rotation ?? 0;
  wctx.save();
  wctx.translate(workW / 2 + x * workW, workH / 2 + y * workH);
  wctx.rotate((rot * Math.PI) / 180);
  wctx.scale(scale, scale);
  wctx.translate(-workW / 2, -workH / 2);
  // Contain-fit the frame into the work canvas (like the <video>'s
  // object-contain and FFmpeg's force_original_aspect_ratio=decrease+pad) so
  // a source whose aspect differs from the work canvas isn't stretched.
  const vw = video.videoWidth || workW;
  const vh = video.videoHeight || workH;
  const fit = Math.min(workW / vw, workH / vh);
  const dw = vw * fit;
  const dh = vh * fit;
  wctx.drawImage(video, (workW - dw) / 2, (workH - dh) / 2, dw, dh);
  wctx.restore();

  ctx.drawImage(workCanvas, sx * k, sy * k, cropPixW * k, cropPixH * k, 0, 0, outW, outH);
}

/** True if a PiP overlay video is active at the current playhead. */
export function hasActiveOverlayVideo(reelId: string): boolean {
  const rs = useReelStore.getState();
  const reel = rs.reels.find((r) => r.id === reelId);
  if (!reel) return false;
  const t = rs.currentTimeMs;
  return reel.composition.clips.some(
    (c) => c.type === 'video' && c.trackId !== 'rv1' && c.fileName && t >= c.timelineStartMs && t < c.timelineEndMs
  );
}

/**
 * Draw any active PiP (secondary-track) video overlays into the canvas, on top
 * of the main video, in their overlayPosition box. Reads the live overlay
 * <video> elements (kept seeked by ReelOverlayVideos). Call with an identity
 * transform matrix — overlays are positioned in output space, independent of
 * the main clip's zoom/rotation.
 */
export function drawActiveOverlayVideos(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  reelId: string
): void {
  const rs = useReelStore.getState();
  const reel = rs.reels.find((r) => r.id === reelId);
  if (!reel) return;
  const t = rs.currentTimeMs;
  const overlays = reel.composition.clips
    .filter((c) => c.type === 'video' && c.trackId !== 'rv1' && c.fileName)
    .filter((c) => t >= c.timelineStartMs && t < c.timelineEndMs)
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  for (const clip of overlays) {
    const el = getOverlayVideoElement(clip.id);
    if (!el || el.readyState < 2 || !el.videoWidth) continue;
    const pos = clip.overlayPosition ?? { x: 0.5, y: 0.5, width: 0.4 };
    const boxW = pos.width * cw;
    const boxH = boxW * (el.videoHeight / el.videoWidth);
    const dx = pos.x * cw - boxW / 2;
    const dy = pos.y * ch - boxH / 2;
    ctx.save();
    ctx.globalAlpha = clip.opacity ?? 1;
    try {
      ctx.drawImage(el, dx, dy, boxW, boxH);
    } catch { /* element not ready */ }
    ctx.restore();
  }
}
