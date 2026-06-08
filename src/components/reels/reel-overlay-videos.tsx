'use client';

import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useReelStore } from '@/stores/reel-store';
import { setOverlayVideoElement } from './reel-video-ref';

/**
 * Mounts a hidden <video> for each secondary-track (PiP) video clip in the
 * reel and keeps each one seeked/playing in sync with the reel playhead. The
 * canvas previews (CropPreviewCanvas / TimelineCanvasPreview) read these
 * elements via getOverlayVideoElement and draw them into the PiP box, so the
 * overlay is visible live while editing — matching the export.
 *
 * The elements are muted (overlay audio isn't part of the preview mix) and
 * never shown directly; they exist only as a frame source for the canvas.
 */
export function ReelOverlayVideos({ reelId }: { reelId: string }) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));

  // Overlay video clips = video clips on any track other than the main rv1.
  const overlayClips = (reel?.composition.clips ?? []).filter(
    (c) => c.type === 'video' && c.trackId !== 'rv1' && c.fileName
  );

  const elsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const rafRef = useRef<number>(0);

  // Sync loop: seek + play/pause each overlay element against the reel playhead.
  useEffect(() => {
    const tick = () => {
      const state = useReelStore.getState();
      const r = state.reels.find((x) => x.id === reelId);
      const isPlaying = state.isPlaying;
      const t = state.currentTimeMs;
      if (r) {
        for (const clip of r.composition.clips) {
          if (clip.type !== 'video' || clip.trackId === 'rv1' || !clip.fileName) continue;
          const el = elsRef.current.get(clip.id);
          if (!el) continue;
          const inRange = t >= clip.timelineStartMs && t < clip.timelineEndMs;
          if (inRange) {
            const expected = (clip.sourceInMs + (t - clip.timelineStartMs)) / 1000;
            if (el.readyState >= 1 && Math.abs(el.currentTime - expected) > 0.25) {
              el.currentTime = Math.max(0, expected);
            }
            if (isPlaying && el.paused) el.play().catch(() => {});
            if (!isPlaying && !el.paused) el.pause();
          } else if (!el.paused) {
            el.pause();
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [reelId]);

  if (!projectId) return null;

  return (
    <div className="w-0 h-0 overflow-hidden" aria-hidden>
      {overlayClips.map((clip) => (
        <video
          key={clip.id}
          src={`/api/projects/${projectId}/reels/file?name=${encodeURIComponent(clip.fileName)}`}
          muted
          playsInline
          preload="auto"
          ref={(el) => {
            if (el) {
              elsRef.current.set(clip.id, el);
              setOverlayVideoElement(clip.id, el);
            } else {
              elsRef.current.delete(clip.id);
              setOverlayVideoElement(clip.id, null);
            }
          }}
        />
      ))}
    </div>
  );
}
