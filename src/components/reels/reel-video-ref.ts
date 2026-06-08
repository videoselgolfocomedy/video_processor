// Module-level ref to share the single video element across components
// Avoids multiple <video> elements hitting the same file

let _videoElement: HTMLVideoElement | null = null;

export function setReelVideoElement(el: HTMLVideoElement | null) {
  _videoElement = el;
}

export function getReelVideoElement(): HTMLVideoElement | null {
  return _videoElement;
}

// Secondary (PiP) overlay video elements, keyed by clip id. The canvas
// previews look these up to draw the picture-in-picture box live.
const _overlayElements = new Map<string, HTMLVideoElement>();

export function setOverlayVideoElement(clipId: string, el: HTMLVideoElement | null) {
  if (el) _overlayElements.set(clipId, el);
  else _overlayElements.delete(clipId);
}

export function getOverlayVideoElement(clipId: string): HTMLVideoElement | null {
  return _overlayElements.get(clipId) ?? null;
}
