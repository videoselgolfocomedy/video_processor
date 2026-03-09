'use client';

import { useRef, useCallback, useEffect } from 'react';
import { useReelStore } from '@/stores/reel-store';
import { ReelTimelineControls } from './reel-timeline-controls';
import { ReelTimelineTrack } from './reel-timeline-track';
import { formatDuration } from '@/lib/utils';

const TRACK_HEADER_WIDTH = 120;

interface ReelTimelineProps {
  reelId: string;
}

export function ReelTimeline({ reelId }: ReelTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const zoomLevel = useReelStore((s) => s.zoomLevel);
  const scrollOffsetMs = useReelStore((s) => s.scrollOffsetMs);
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const setZoom = useReelStore((s) => s.setZoom);
  const setScrollOffset = useReelStore((s) => s.setScrollOffset);
  const setViewportWidth = useReelStore((s) => s.setViewportWidth);
  const setCurrentTime = useReelStore((s) => s.setCurrentTime);

  const reelDurationMs = reel ? reel.endMs - reel.startMs : 0;

  // Only show tracks that have content or are primary
  const visibleTracks = reel?.composition.tracks.filter((t) => {
    // Always show main video, main audio, subtitles
    if (['rv1', 'ra1', 'rs1'].includes(t.id)) return true;
    // Show others if they have clips
    return reel.composition.clips.some((c) => c.trackId === t.id);
  }) ?? [];

  // Measure viewport width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportWidth(entry.contentRect.width - TRACK_HEADER_WIDTH);
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
      } else {
        const deltaMs = (e.deltaX || e.deltaY) / zoomLevel;
        const newOffset = Math.max(0, Math.min(reelDurationMs, scrollOffsetMs + deltaMs));
        setScrollOffset(newOffset);
      }
    },
    [zoomLevel, scrollOffsetMs, reelDurationMs, setZoom, setScrollOffset]
  );

  // Ruler click → seek
  const handleRulerClick = useCallback(
    (e: React.MouseEvent) => {
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const ms = px / zoomLevel + scrollOffsetMs;
      setCurrentTime(Math.max(0, Math.min(reelDurationMs, ms)));
    },
    [zoomLevel, scrollOffsetMs, reelDurationMs, setCurrentTime]
  );

  // Ruler ticks
  const getTickInterval = useCallback(() => {
    const pxPerSecond = zoomLevel * 1000;
    if (pxPerSecond > 200) return 1000;
    if (pxPerSecond > 50) return 5000;
    if (pxPerSecond > 20) return 10000;
    if (pxPerSecond > 5) return 30000;
    return 60000;
  }, [zoomLevel]);

  const viewportWidthPx = useReelStore((s) => s.viewportWidthPx);
  const tickInterval = getTickInterval();
  const startMs = Math.floor(scrollOffsetMs / tickInterval) * tickInterval;
  const endMs = scrollOffsetMs + viewportWidthPx / zoomLevel;
  const ticks: { ms: number; px: number; label: string; major: boolean }[] = [];

  for (let ms = startMs; ms <= Math.min(endMs + tickInterval, reelDurationMs); ms += tickInterval) {
    if (ms < 0) continue;
    const px = (ms - scrollOffsetMs) * zoomLevel;
    ticks.push({
      ms,
      px,
      label: formatDuration(ms),
      major: ms % (tickInterval * 5) === 0 || tickInterval >= 30000,
    });
  }

  // Auto-scroll to keep playhead visible
  useEffect(() => {
    const playheadPx = (currentTimeMs - scrollOffsetMs) * zoomLevel;
    const margin = 60; // px margin from edges
    if (playheadPx < 0) {
      // Playhead is left of viewport
      setScrollOffset(currentTimeMs);
    } else if (playheadPx > viewportWidthPx - margin) {
      // Playhead is right of viewport
      setScrollOffset(currentTimeMs - (viewportWidthPx - margin) / zoomLevel);
    }
  }, [currentTimeMs, scrollOffsetMs, zoomLevel, viewportWidthPx, setScrollOffset]);

  // Playhead position
  const playheadPx = (currentTimeMs - scrollOffsetMs) * zoomLevel;

  return (
    <div className="flex flex-col border-t border-border bg-background">
      <ReelTimelineControls reelId={reelId} />

      <div
        ref={containerRef}
        className="relative overflow-hidden select-none"
        onWheel={handleWheel}
      >
        {/* Ruler */}
        <div
          className="relative h-6 cursor-pointer select-none border-b border-border bg-card"
          style={{ marginLeft: TRACK_HEADER_WIDTH, width: `calc(100% - ${TRACK_HEADER_WIDTH}px)` }}
          onClick={handleRulerClick}
        >
          <div className="relative h-full" style={{ width: reelDurationMs * zoomLevel }}>
            {ticks.map((tick) => (
              <div
                key={tick.ms}
                className="absolute top-0 flex flex-col items-start"
                style={{ left: tick.px }}
              >
                <div
                  className={`w-px ${tick.major ? 'h-4 bg-muted-foreground' : 'h-2 bg-muted-foreground/50'}`}
                />
                {tick.major && (
                  <span className="ml-0.5 text-[9px] text-muted-foreground whitespace-nowrap">
                    {tick.label}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Tracks */}
        <div className="relative">
          {visibleTracks.map((track) => (
            <ReelTimelineTrack key={track.id} reelId={reelId} track={track} />
          ))}

          {/* Playhead line spanning all tracks */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ left: TRACK_HEADER_WIDTH }}
          >
            <div
              className="absolute top-0 bottom-0 z-30"
              style={{ left: playheadPx - 6, width: 12 }}
            >
              <div className="absolute left-[5px] top-0 bottom-0 w-0.5 bg-red-500" />
              <div
                className="absolute left-[1px] top-0 w-0 h-0"
                style={{
                  borderLeft: '5px solid transparent',
                  borderRight: '5px solid transparent',
                  borderTop: '7px solid rgb(239 68 68)',
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
