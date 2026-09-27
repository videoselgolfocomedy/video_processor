'use client';

import { useRef, useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useReelStore, getReelEffectiveDurationMs } from '@/stores/reel-store';
import { useProjectStore } from '@/stores/project-store';
import { AudioRegionsLane } from '@/components/parts/audio-regions-lane';
import { AudioRegionsProvider, RegionsApplyBar } from '@/components/parts/audio-regions-context';
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
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const hasParts = useProjectStore((s) => (s.currentProject?.parts?.length ?? 0) > 0);
  const rv1Clips = useMemo(
    () => (reel?.composition.clips ?? []).filter((c) => c.trackId === 'rv1'),
    [reel?.composition.clips],
  );

  // Effective duration includes content pasted BEYOND the reel's original
  // source window (paste-behind from another reel) — otherwise the ruler
  // clamps seeks to the original end and you can't place the playhead over
  // the pasted zone.
  const reelDurationMs = getReelEffectiveDurationMs(reel);

  // Show all tracks (including newly added empty ones)
  const visibleTracks = reel?.composition.tracks ?? [];

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
        // Plain vertical wheel pans horizontally — unless the tracks overflow
        // the pane: then it scrolls them like any list (Shift+wheel and
        // sideways trackpad still pan).
        const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        const el = containerRef.current;
        if (!sideways && el && el.scrollHeight > el.clientHeight + 1) return;
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

  const stemTracksPresent = !!reel?.composition.tracks.some((t) => t.id === 'ra_mesa' || t.id === 'ra_amb');
  const body = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-shrink-0">
        <ReelTimelineControls reelId={reelId} />
      </div>

      {/* Fills the bottom half of the screen; scrolls vertically only when
          there are more tracks than fit, with the ruler pinned on top. */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden select-none"
        onWheel={handleWheel}
      >
        {/* Ruler */}
        <div
          className="sticky top-0 z-40 h-6 cursor-pointer select-none border-b border-border bg-card"
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

          {/* Fallback lane for mesa/ambiente regions while the stems are not separated */}
          <AudioRegionsLane />

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
        <RegionsApplyBar />
      </div>
    </div>
  );
  if (!hasParts || !projectId || rv1Clips.length === 0) return body;
  return (
    <AudioRegionsProvider
      projectId={projectId}
      videoClips={rv1Clips}
      scrollOffsetMs={scrollOffsetMs}
      zoomLevel={zoomLevel}
      playheadMs={currentTimeMs}
      viewportWidthPx={viewportWidthPx}
      onSeek={setCurrentTime}
      stemTracksPresent={stemTracksPresent}
    >
      {body}
    </AudioRegionsProvider>
  );
}
