'use client';

import { useRef, useCallback, useEffect } from 'react';
import { useComposeStore } from '@/stores/compose-store';
import { TimelineRuler } from './timeline-ruler';
import { TimelinePlayhead } from './timeline-playhead';
import { TimelineTrack } from './timeline-track';
import { TimelineControls } from './timeline-controls';

interface MultiTrackTimelineProps {
  onSave: () => void;
  saving: boolean;
}

export function MultiTrackTimeline({ onSave, saving }: MultiTrackTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tracks = useComposeStore((s) => s.tracks);
  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const durationMs = useComposeStore((s) => s.durationMs);
  const setZoom = useComposeStore((s) => s.setZoom);
  const setScrollOffset = useComposeStore((s) => s.setScrollOffset);
  const setViewportWidth = useComposeStore((s) => s.setViewportWidth);

  // Measure viewport width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportWidth(entry.contentRect.width - 120); // minus track header
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [setViewportWidth]);

  // Auto-scroll timeline when playhead moves outside the visible range
  // (e.g. clicking a subtitle, pressing arrows, navigating next/prev)
  useEffect(() => {
    const unsub = useComposeStore.subscribe(
      (state, prevState) => {
        if (state.currentTimeMs === prevState.currentTimeMs) return;
        if (state.isPlaying) return; // During playback, the playhead follows naturally

        const { scrollOffsetMs: offset, viewportWidthPx: vpW, zoomLevel: zoom } = state;
        const visibleMs = vpW / zoom;
        const margin = visibleMs * 0.1; // 10% margin
        const playheadMs = state.currentTimeMs;

        // If playhead is outside the visible window (with margin), re-center
        if (playheadMs < offset + margin || playheadMs > offset + visibleMs - margin) {
          const newOffset = Math.max(0, playheadMs - visibleMs / 2);
          useComposeStore.getState().setScrollOffset(newOffset);
        }
      }
    );
    return unsub;
  }, []);

  // Ctrl+scroll = zoom (centered on playhead), plain scroll = horizontal pan
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.85 : 1.18;
        const newZoom = Math.max(0.01, Math.min(1, zoomLevel * delta));

        // Keep playhead at the same viewport position after zoom
        const store = useComposeStore.getState();
        const playheadMs = store.currentTimeMs;
        const vpWidth = store.viewportWidthPx;
        const visibleMs = vpWidth / newZoom;
        // Center playhead in the viewport
        const newOffset = Math.max(0, Math.min(durationMs, playheadMs - visibleMs / 2));
        setZoom(newZoom);
        setScrollOffset(newOffset);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Horizontal scroll
        const deltaMs = (e.deltaX || e.deltaY) / zoomLevel;
        const newOffset = Math.max(0, Math.min(durationMs, scrollOffsetMs + deltaMs));
        setScrollOffset(newOffset);
      } else {
        // Normal vertical scroll → horizontal pan
        const deltaMs = e.deltaY / zoomLevel;
        const newOffset = Math.max(0, Math.min(durationMs, scrollOffsetMs + deltaMs));
        setScrollOffset(newOffset);
      }
    },
    [zoomLevel, scrollOffsetMs, durationMs, setZoom, setScrollOffset]
  );

  return (
    <div className="flex flex-col border-t border-border bg-background">
      <TimelineControls onSave={onSave} saving={saving} />

      <div
        ref={containerRef}
        className="relative overflow-hidden select-none"
        onWheel={handleWheel}
      >
        {/* Ruler */}
        <TimelineRuler />

        {/* Tracks */}
        <div className="relative">
          {tracks.map((track) => (
            <TimelineTrack key={track.id} track={track} />
          ))}

          {/* Playhead line spanning all tracks */}
          <TimelinePlayhead />
        </div>
      </div>
    </div>
  );
}
