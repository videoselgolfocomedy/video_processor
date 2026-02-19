'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useComposeStore } from '@/stores/compose-store';

const TRACK_HEADER_WIDTH = 120;

export function TimelinePlayhead() {
  const currentTimeMs = useComposeStore((s) => s.currentTimeMs);
  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const durationMs = useComposeStore((s) => s.durationMs);
  const setCurrentTime = useComposeStore((s) => s.setCurrentTime);

  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const px = (currentTimeMs - scrollOffsetMs) * zoomLevel;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current?.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const relX = e.clientX - rect.left - TRACK_HEADER_WIDTH;
      const ms = relX / zoomLevel + scrollOffsetMs;
      setCurrentTime(Math.max(0, Math.min(durationMs, ms)));
    };

    const handleMouseUp = () => setDragging(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, zoomLevel, scrollOffsetMs, durationMs, setCurrentTime]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0"
      style={{ left: TRACK_HEADER_WIDTH }}
    >
      <div
        className="absolute top-0 bottom-0 z-30 pointer-events-auto"
        style={{ left: px - 6, width: 12 }}
      >
        {/* Playhead line */}
        <div
          className="absolute left-[5px] top-0 bottom-0 w-0.5 bg-red-500"
          style={{ cursor: dragging ? 'grabbing' : 'grab' }}
          onMouseDown={handleMouseDown}
        />
        {/* Playhead head triangle */}
        <div
          className="absolute left-[1px] top-0 w-0 h-0 cursor-grab"
          style={{
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: '7px solid rgb(239 68 68)',
            cursor: dragging ? 'grabbing' : 'grab',
          }}
          onMouseDown={handleMouseDown}
        />
      </div>
    </div>
  );
}
