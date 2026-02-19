'use client';

import { useRef, useCallback } from 'react';
import { useComposeStore } from '@/stores/compose-store';
import { formatDuration } from '@/lib/utils';

const TRACK_HEADER_WIDTH = 120;

export function TimelineRuler() {
  const rulerRef = useRef<HTMLDivElement>(null);
  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const durationMs = useComposeStore((s) => s.durationMs);
  const viewportWidthPx = useComposeStore((s) => s.viewportWidthPx);
  const setCurrentTime = useComposeStore((s) => s.setCurrentTime);

  const totalWidthPx = durationMs * zoomLevel;

  // Adaptive tick interval based on zoom
  const getTickInterval = useCallback(() => {
    const pxPerSecond = zoomLevel * 1000;
    if (pxPerSecond > 200) return 1000;      // 1s
    if (pxPerSecond > 50) return 5000;        // 5s
    if (pxPerSecond > 20) return 10000;       // 10s
    if (pxPerSecond > 5) return 30000;        // 30s
    return 60000;                              // 1m
  }, [zoomLevel]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const ruler = rulerRef.current;
      if (!ruler) return;
      const rect = ruler.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const ms = px / zoomLevel + scrollOffsetMs;
      setCurrentTime(Math.max(0, Math.min(durationMs, ms)));
    },
    [zoomLevel, scrollOffsetMs, durationMs, setCurrentTime]
  );

  const tickInterval = getTickInterval();
  const startMs = Math.floor(scrollOffsetMs / tickInterval) * tickInterval;
  const endMs = scrollOffsetMs + viewportWidthPx / zoomLevel;
  const ticks: { ms: number; px: number; label: string; major: boolean }[] = [];

  for (let ms = startMs; ms <= Math.min(endMs + tickInterval, durationMs); ms += tickInterval) {
    if (ms < 0) continue;
    const px = (ms - scrollOffsetMs) * zoomLevel;
    ticks.push({
      ms,
      px,
      label: formatDuration(ms),
      major: ms % (tickInterval * 5) === 0 || tickInterval >= 30000,
    });
  }

  return (
    <div
      ref={rulerRef}
      className="relative h-6 cursor-pointer select-none border-b border-border bg-card"
      style={{ marginLeft: TRACK_HEADER_WIDTH, width: `calc(100% - ${TRACK_HEADER_WIDTH}px)` }}
      onClick={handleClick}
    >
      <div className="relative h-full" style={{ width: totalWidthPx }}>
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
  );
}
