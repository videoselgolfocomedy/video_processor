'use client';

import { useCallback, useRef, useState } from 'react';
import { formatDuration } from '@/lib/utils';
import type { SubtitleSegment } from '@/types/project';

interface TimelineProps {
  durationMs: number;
  currentTimeMs: number;
  segments?: SubtitleSegment[];
  onSeek: (timeMs: number) => void;
  onSegmentClick?: (index: number) => void;
}

export function Timeline({
  durationMs,
  currentTimeMs,
  segments = [],
  onSeek,
  onSegmentClick,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const [hoverTime, setHoverTime] = useState(0);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      onSeek(percent * durationMs);
    },
    [durationMs, onSeek]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      setHoverTime(percent * durationMs);
    },
    [durationMs]
  );

  const playheadPercent =
    durationMs > 0 ? (currentTimeMs / durationMs) * 100 : 0;

  return (
    <div className="space-y-1">
      {/* Time display */}
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatDuration(currentTimeMs)}</span>
        <span>{formatDuration(durationMs)}</span>
      </div>

      {/* Timeline bar */}
      <div
        ref={containerRef}
        className="relative h-10 cursor-pointer rounded-md bg-secondary"
        onClick={handleClick}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onMouseMove={handleMouseMove}
      >
        {/* Subtitle segments */}
        {segments.map((seg, i) => {
          const left = (seg.startMs / durationMs) * 100;
          const width = ((seg.endMs - seg.startMs) / durationMs) * 100;

          return (
            <div
              key={seg.id}
              className="absolute top-1 h-4 rounded-sm bg-primary/30 hover:bg-primary/50 transition-colors"
              style={{ left: `${left}%`, width: `${width}%` }}
              title={seg.text}
              onClick={(e) => {
                e.stopPropagation();
                onSegmentClick?.(i);
              }}
            />
          );
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 h-full w-0.5 bg-primary z-10"
          style={{ left: `${playheadPercent}%` }}
        >
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-primary" />
        </div>

        {/* Hover indicator */}
        {hovering && (
          <div
            className="absolute top-0 h-full w-px bg-muted-foreground/30"
            style={{ left: `${(hoverTime / durationMs) * 100}%` }}
          >
            <div className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-popover px-1 py-0.5 text-[10px] text-popover-foreground whitespace-nowrap">
              {formatDuration(hoverTime)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
