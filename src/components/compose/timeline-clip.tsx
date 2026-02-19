'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import { Film, ImageIcon, Music } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useComposeStore } from '@/stores/compose-store';
import type { CompositionClip } from '@/types/project';

interface TimelineClipProps {
  clip: CompositionClip;
  trackLocked: boolean;
}

type DragMode = 'move' | 'trim-in' | 'trim-out' | null;

export function TimelineClip({ clip, trackLocked }: TimelineClipProps) {
  const clipRef = useRef<HTMLDivElement>(null);
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const dragOrigin = useRef({ mouseX: 0, startMs: 0, endMs: 0, sourceInMs: 0, sourceOutMs: 0 });

  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const selectedClipId = useComposeStore((s) => s.selectedClipId);
  const selectClip = useComposeStore((s) => s.selectClip);
  const moveClip = useComposeStore((s) => s.moveClip);
  const trimClip = useComposeStore((s) => s.trimClip);
  const pushUndo = useComposeStore((s) => s.pushUndo);

  const isSelected = selectedClipId === clip.id;
  const leftPx = (clip.timelineStartMs - scrollOffsetMs) * zoomLevel;
  const widthPx = (clip.timelineEndMs - clip.timelineStartMs) * zoomLevel;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      if (trackLocked) return;
      e.preventDefault();
      e.stopPropagation();
      selectClip(clip.id);

      pushUndo();

      dragOrigin.current = {
        mouseX: e.clientX,
        startMs: clip.timelineStartMs,
        endMs: clip.timelineEndMs,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
      };
      setDragMode(mode);
    },
    [clip, trackLocked, selectClip, pushUndo]
  );

  useEffect(() => {
    if (!dragMode) return;

    const SNAP_THRESHOLD_MS = 200;

    const getSnapTargets = (): number[] => {
      const store = useComposeStore.getState();
      const targets: number[] = [store.currentTimeMs]; // snap to playhead
      for (const c of store.clips) {
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
        // Use whichever edge snapped (prefer start)
        const finalStart = snappedStart !== rawStart ? snappedStart
          : snappedEnd !== rawStart + duration ? snappedEnd - duration
          : rawStart;
        moveClip(clip.id, finalStart);
      } else if (dragMode === 'trim-in') {
        const rawStart = Math.max(0, dragOrigin.current.startMs + deltaMs);
        trimClip(clip.id, 'in', snap(rawStart));
      } else if (dragMode === 'trim-out') {
        const rawEnd = Math.max(0, dragOrigin.current.endMs + deltaMs);
        trimClip(clip.id, 'out', snap(rawEnd));
      }
    };

    const handleMouseUp = () => setDragMode(null);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragMode, clip.id, zoomLevel, moveClip, trimClip]);

  const icon =
    clip.type === 'video' ? (
      <Film className="h-3 w-3 flex-shrink-0" />
    ) : clip.type === 'image' ? (
      <ImageIcon className="h-3 w-3 flex-shrink-0" />
    ) : (
      <Music className="h-3 w-3 flex-shrink-0" />
    );

  const clipColor =
    clip.type === 'video'
      ? clip.mode === 'overlay'
        ? 'bg-purple-600/80 border-purple-400'
        : 'bg-blue-600/80 border-blue-400'
      : clip.type === 'image'
        ? 'bg-teal-600/80 border-teal-400'
        : 'bg-green-600/80 border-green-400';

  return (
    <div
      ref={clipRef}
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
      }}
    >
      {/* Trim-in handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/20 z-10"
        onMouseDown={(e) => handleMouseDown(e, 'trim-in')}
      />

      {/* Content */}
      <div className="flex items-center gap-1 min-w-0 pointer-events-none">
        {icon}
        <span className="text-[9px] text-white/90 truncate">{clip.originalName}</span>
      </div>

      {/* Trim-out handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/20 z-10"
        onMouseDown={(e) => handleMouseDown(e, 'trim-out')}
      />
    </div>
  );
}
