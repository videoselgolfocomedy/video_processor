'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatDuration } from '@/lib/utils';
import { RotateCcw, Scissors } from 'lucide-react';
import type { SubtitleSegment } from '@/types/project';

interface RangeSelectorProps {
  durationMs: number;
  segments?: SubtitleSegment[];
  inMs: number;
  outMs: number;
  onChange: (inMs: number, outMs: number) => void;
}

type DragTarget = 'in' | 'out' | null;

export function RangeSelector({
  durationMs,
  segments = [],
  inMs,
  outMs,
  onChange,
}: RangeSelectorProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<DragTarget>(null);

  const isFullRange = inMs === 0 && outMs === durationMs;

  const msToPercent = useCallback(
    (ms: number) => (durationMs > 0 ? (ms / durationMs) * 100 : 0),
    [durationMs]
  );

  const clamp = useCallback(
    (ms: number) => Math.max(0, Math.min(durationMs, ms)),
    [durationMs]
  );

  const positionToMs = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar || durationMs <= 0) return 0;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      // Snap to 100ms steps
      return Math.round((ratio * durationMs) / 100) * 100;
    },
    [durationMs]
  );

  const handleMouseDown = useCallback(
    (target: DragTarget) => (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(target);
    },
    []
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const ms = clamp(positionToMs(e.clientX));
      if (dragging === 'in') {
        onChange(Math.min(ms, outMs - 500), outMs);
      } else {
        onChange(inMs, Math.max(ms, inMs + 500));
      }
    };

    const handleMouseUp = () => setDragging(null);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, inMs, outMs, clamp, positionToMs, onChange]);

  const inPct = msToPercent(inMs);
  const outPct = msToPercent(outMs);
  const selectedDuration = outMs - inMs;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Scissors className="h-3 w-3" />
        Rango de exportación
      </div>

      {/* Bar container */}
      <div
        ref={barRef}
        className="relative h-10 rounded bg-muted/50 border border-border select-none cursor-crosshair"
      >
        {/* Subtitle segment blocks */}
        {segments.map((seg, i) => (
          <div
            key={i}
            className="absolute top-1 bottom-1 rounded-sm bg-primary/15"
            style={{
              left: `${msToPercent(seg.startMs)}%`,
              width: `${Math.max(0.3, msToPercent(seg.endMs - seg.startMs))}%`,
            }}
          />
        ))}

        {/* Dimmed overlay left of in-point */}
        <div
          className="absolute inset-y-0 left-0 rounded-l bg-background/60 pointer-events-none"
          style={{ width: `${inPct}%` }}
        />

        {/* Dimmed overlay right of out-point */}
        <div
          className="absolute inset-y-0 right-0 rounded-r bg-background/60 pointer-events-none"
          style={{ width: `${100 - outPct}%` }}
        />

        {/* Selected region highlight border */}
        <div
          className="absolute inset-y-0 border-y-2 border-primary/40 pointer-events-none"
          style={{
            left: `${inPct}%`,
            width: `${outPct - inPct}%`,
          }}
        />

        {/* In-point handle */}
        <div
          className={`absolute top-0 bottom-0 w-2 cursor-ew-resize z-10 group ${
            dragging === 'in' ? 'opacity-100' : ''
          }`}
          style={{ left: `calc(${inPct}% - 4px)` }}
          onMouseDown={handleMouseDown('in')}
        >
          <div className="absolute inset-y-0 left-1 w-0.5 bg-primary rounded-full group-hover:w-1 transition-all" />
          <div className="absolute top-1/2 -translate-y-1/2 left-0 w-2 h-5 rounded-sm bg-primary" />
        </div>

        {/* Out-point handle */}
        <div
          className={`absolute top-0 bottom-0 w-2 cursor-ew-resize z-10 group ${
            dragging === 'out' ? 'opacity-100' : ''
          }`}
          style={{ left: `calc(${outPct}% - 4px)` }}
          onMouseDown={handleMouseDown('out')}
        >
          <div className="absolute inset-y-0 right-1 w-0.5 bg-primary rounded-full group-hover:w-1 transition-all" />
          <div className="absolute top-1/2 -translate-y-1/2 right-0 w-2 h-5 rounded-sm bg-primary" />
        </div>
      </div>

      {/* Time display + reset */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <div className="flex gap-3 font-mono">
          <span>In: <span className="text-foreground">{formatDuration(inMs)}</span></span>
          <span>Out: <span className="text-foreground">{formatDuration(outMs)}</span></span>
          <span>Duración: <span className="text-foreground">{formatDuration(selectedDuration)}</span></span>
        </div>
        {!isFullRange && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-2 text-[10px]"
            onClick={() => onChange(0, durationMs)}
          >
            <RotateCcw className="mr-1 h-2.5 w-2.5" />
            Full
          </Button>
        )}
      </div>
    </div>
  );
}
