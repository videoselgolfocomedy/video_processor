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

  // Ctrl+scroll = zoom, plain scroll = horizontal pan
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.85 : 1.18;
        const newZoom = Math.max(0.01, Math.min(1, zoomLevel * delta));
        setZoom(newZoom);
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
