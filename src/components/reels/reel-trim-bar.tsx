'use client';

import { useCallback, useRef } from 'react';
import { useReelStore } from '@/stores/reel-store';
import { formatTimestamp } from '@/lib/utils';

interface ReelTrimBarProps {
  reelId: string;
  baseDurationMs: number;
}

export function ReelTrimBar({ reelId, baseDurationMs }: ReelTrimBarProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const updateReel = useReelStore((s) => s.updateReel);
  const regenerateReelSubtitles = useReelStore((s) => s.regenerateReelSubtitles);
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const setCurrentTime = useReelStore((s) => s.setCurrentTime);
  const barRef = useRef<HTMLDivElement>(null);

  // Lock trim handles when timeline edits exist (clips created)
  const hasTimelineEdits = reel ? reel.composition.clips.length > 0 : false;

  const handleDrag = useCallback(
    (handle: 'left' | 'right') => (e: React.MouseEvent) => {
      if (!reel || hasTimelineEdits) return;
      e.preventDefault();
      e.stopPropagation();

      const bar = barRef.current;
      if (!bar) return;

      const onMouseMove = (ev: MouseEvent) => {
        const rect = bar.getBoundingClientRect();
        const fraction = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        const ms = Math.round(fraction * baseDurationMs);

        if (handle === 'left') {
          const clamped = Math.max(0, Math.min(ms, reel.endMs - 1000));
          updateReel(reelId, { startMs: clamped });
        } else {
          const clamped = Math.max(reel.startMs + 1000, Math.min(ms, baseDurationMs));
          updateReel(reelId, { endMs: clamped });
        }
      };

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        regenerateReelSubtitles(reelId);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [reel, reelId, baseDurationMs, updateReel, regenerateReelSubtitles]
  );

  const handleBarClick = useCallback(
    (e: React.MouseEvent) => {
      if (!reel) return;
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const absMs = fraction * baseDurationMs;
      // Convert to reel-relative time
      const relMs = Math.max(0, Math.min(absMs - reel.startMs, reel.endMs - reel.startMs));
      setCurrentTime(relMs);
    },
    [reel, baseDurationMs, setCurrentTime]
  );

  if (!reel) return null;

  const startFrac = reel.startMs / baseDurationMs;
  const endFrac = reel.endMs / baseDurationMs;
  const durationSec = ((reel.endMs - reel.startMs) / 1000).toFixed(1);

  // Playhead position (currentTimeMs is reel-relative)
  const playheadAbsMs = reel.startMs + currentTimeMs;
  const playheadFrac = playheadAbsMs / baseDurationMs;

  return (
    <div className="space-y-1">
      {/* Trim bar */}
      <div
        ref={barRef}
        className="relative h-10 bg-secondary rounded-lg select-none cursor-pointer"
        onClick={handleBarClick}
      >
        {/* Dark overlay - left outside region */}
        <div
          className="absolute inset-y-0 left-0 bg-black/50 rounded-l-lg"
          style={{ width: `${startFrac * 100}%` }}
        />
        {/* Dark overlay - right outside region */}
        <div
          className="absolute inset-y-0 right-0 bg-black/50 rounded-r-lg"
          style={{ width: `${(1 - endFrac) * 100}%` }}
        />

        {/* Selected region highlight */}
        <div
          className="absolute inset-y-0 bg-amber-500/20 border-x-2 border-amber-400"
          style={{
            left: `${startFrac * 100}%`,
            width: `${(endFrac - startFrac) * 100}%`,
          }}
        />

        {/* Left handle */}
        <div
          className={`absolute inset-y-0 w-2.5 rounded-sm z-10 transition-colors ${
            hasTimelineEdits
              ? 'bg-amber-400/40 cursor-not-allowed'
              : 'bg-amber-400 cursor-ew-resize hover:bg-amber-300'
          }`}
          style={{ left: `calc(${startFrac * 100}% - 5px)` }}
          onMouseDown={handleDrag('left')}
          onClick={(e) => e.stopPropagation()}
          title={hasTimelineEdits ? 'Locked — timeline has edits. Create a new reel to change range.' : 'Drag to adjust start'}
        >
          <div className="absolute inset-y-1/3 left-0.5 right-0.5 flex flex-col justify-center gap-0.5">
            <div className="h-px bg-amber-800/50" />
            <div className="h-px bg-amber-800/50" />
            <div className="h-px bg-amber-800/50" />
          </div>
        </div>

        {/* Right handle */}
        <div
          className={`absolute inset-y-0 w-2.5 rounded-sm z-10 transition-colors ${
            hasTimelineEdits
              ? 'bg-amber-400/40 cursor-not-allowed'
              : 'bg-amber-400 cursor-ew-resize hover:bg-amber-300'
          }`}
          style={{ left: `calc(${endFrac * 100}% - 5px)` }}
          onMouseDown={handleDrag('right')}
          onClick={(e) => e.stopPropagation()}
          title={hasTimelineEdits ? 'Locked — timeline has edits. Create a new reel to change range.' : 'Drag to adjust end'}
        >
          <div className="absolute inset-y-1/3 left-0.5 right-0.5 flex flex-col justify-center gap-0.5">
            <div className="h-px bg-amber-800/50" />
            <div className="h-px bg-amber-800/50" />
            <div className="h-px bg-amber-800/50" />
          </div>
        </div>

        {/* Playhead */}
        {playheadFrac >= startFrac && playheadFrac <= endFrac && (
          <div
            className="absolute inset-y-0 w-0.5 bg-white z-20 pointer-events-none"
            style={{ left: `${playheadFrac * 100}%` }}
          >
            <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-2 h-1.5 bg-white rounded-t-sm" />
          </div>
        )}
      </div>

      {/* Timestamps */}
      <div className="flex justify-between text-[10px] text-muted-foreground px-1">
        <span>{formatTimestamp(reel.startMs)}</span>
        <span className="text-foreground font-medium">{durationSec}s</span>
        <span>{formatTimestamp(reel.endMs)}</span>
      </div>
      {hasTimelineEdits && (
        <p className="text-[10px] text-amber-500/70 text-center mt-0.5">
          Range locked — timeline has edits. Create a new reel to use a different range.
        </p>
      )}
    </div>
  );
}
