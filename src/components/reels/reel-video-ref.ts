// Module-level ref to share the single video element across components
// Avoids multiple <video> elements hitting the same file

let _videoElement: HTMLVideoElement | null = null;

export function setReelVideoElement(el: HTMLVideoElement | null) {
  _videoElement = el;
}

export function getReelVideoElement(): HTMLVideoElement | null {
  return _videoElement;
}
