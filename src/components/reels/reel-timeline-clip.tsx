'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import { Film, Music } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReelStore } from '@/stores/reel-store';
import type { CompositionClip } from '@/types/project';

interface ReelTimelineClipProps {
  reelId: string;
  clip: CompositionClip;
  trackLocked: boolean;
}

type DragMode = 'move' | 'trim-in' | 'trim-out' | null;

export function ReelTimelineClip({ reelId, clip, trackLocked }: ReelTimelineClipProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const dragOrigin = useRef({ mouseX: 0, startMs: 0, endMs: 0, sourceInMs: 0, sourceOutMs: 0 });

  const zoomLevel = useReelStore((s) => s.zoomLevel);
  const scrollOffsetMs = useReelStore((s) => s.scrollOffsetMs);
  const selectedClipId = useReelStore((s) => s.selectedClipId);
  const selectClip = useReelStore((s) => s.selectClip);
  const moveClip = useReelStore((s) => s.moveClip);
  const trimClip = useReelStore((s) => s.trimClip);

  const isSelected = selectedClipId === clip.id;
  const leftPx = (clip.timelineStartMs - scrollOffsetMs) * zoomLevel;
  const widthPx = (clip.timelineEndMs - clip.timelineStartMs) * zoomLevel;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      // All interactions allowed on all tracks
      e.preventDefault();
      e.stopPropagation();
      useReelStore.getState().saveSnapshot();
      selectClip(clip.id);
      useReelStore.getState().selectSubtitle(null);

      dragOrigin.current = {
        mouseX: e.clientX,
        startMs: clip.timelineStartMs,
        endMs: clip.timelineEndMs,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
      };
      setDragMode(mode);
    },
    [clip, selectClip]
  );

  useEffect(() => {
    if (!dragMode) return;

    const SNAP_THRESHOLD_MS = 200;

    const getSnapTargets = (): number[] => {
      const store = useReelStore.getState();
      const reel = store.reels.find((r) => r.id === reelId);
      if (!reel) return [store.currentTimeMs];
      const targets: number[] = [store.currentTimeMs];
      for (const c of reel.composition.clips) {
        if (c.id === clip.id) continue;
        targets.push(c.timelineStartMs, c.timelineEndMs);
      }
      return targets;
    };

    const snap = (ms: number): number => {
      const targets = getSnapTargets();
      for (const t of targets) {
        if (Math.abs(ms - t) < SNAP_THRESHOLD_MS) return t;
      }
      return ms;
    };

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragOrigin.current.mouseX;
      const deltaMs = deltaX / zoomLevel;

      if (dragMode === 'move') {
        const rawStart = Math.max(0, dragOrigin.current.startMs + deltaMs);
        const duration = dragOrigin.current.endMs - dragOrigin.current.startMs;
        const snappedStart = snap(rawStart);
        const snappedEnd = snap(rawStart + duration);
        const finalStart = snappedStart !== rawStart ? snappedStart
          : snappedEnd !== rawStart + duration ? snappedEnd - duration
            : rawStart;
        moveClip(reelId, clip.id, finalStart);
      } else if (dragMode === 'trim-in') {
        const rawStart = Math.max(0, dragOrigin.current.startMs + deltaMs);
        trimClip(reelId, clip.id, 'in', snap(rawStart));
      } else if (dragMode === 'trim-out') {
        const rawEnd = Math.max(0, dragOrigin.current.endMs + deltaMs);
        trimClip(reelId, clip.id, 'out', snap(rawEnd));
      }
    };

    const handleMouseUp = () => setDragMode(null);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragMode, clip.id, reelId, zoomLevel, moveClip, trimClip]);

  const icon = clip.type === 'video'
    ? <Film className="h-3 w-3 flex-shrink-0" />
    : <Music className="h-3 w-3 flex-shrink-0" />;

  const clipColor = clip.type === 'video'
    ? 'bg-blue-600/80 border-blue-400'
    : 'bg-green-600/80 border-green-400';

  return (
    <div
      className={cn(
        'absolute top-1 bottom-1 rounded border cursor-grab select-none flex items-center gap-1 px-1 overflow-hidden',
        clipColor,
        isSelected && 'ring-2 ring-white/60',
        trackLocked && 'opacity-60 cursor-default',
        dragMode === 'move' && 'cursor-grabbing'
      )}
      style={{
        left: leftPx,
        width: Math.max(4, widthPx),
      }}
      onMouseDown={(e) => handleMouseDown(e, 'move')}
      onClick={(e) => {
        e.stopPropagation();
        selectClip(clip.id);
        useReelStore.getState().selectSubtitle(null);
      }}
    >
      {/* Trim-in handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-3 cursor-ew-resize z-10 group/trim"
        onMouseDown={(e) => handleMouseDown(e, 'trim-in')}
      >
        <div className="absolute left-0.5 top-1 bottom-1 w-1 rounded-full bg-white/40 transition-colors group-hover/trim:bg-white/80" />
      </div>

      {/* Content */}
      <div className="flex items-center gap-1 min-w-0 pointer-events-none">
        {icon}
        <span className="text-[9px] text-white/90 truncate">{clip.originalName}</span>
      </div>

      {/* Trim-out handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize z-10 group/trim"
        onMouseDown={(e) => handleMouseDown(e, 'trim-out')}
      >
        <div className="absolute right-0.5 top-1 bottom-1 w-1 rounded-full bg-white/40 transition-colors group-hover/trim:bg-white/80" />
      </div>
    </div>
  );
}
