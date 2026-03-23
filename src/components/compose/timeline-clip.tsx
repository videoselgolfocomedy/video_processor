'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import { Film, ImageIcon, Music, Type } from 'lucide-react';
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
  const [editingText, setEditingText] = useState(false);
  const [textValue, setTextValue] = useState(clip.textContent ?? '');
  const textInputRef = useRef<HTMLInputElement>(null);
  const dragOrigin = useRef<{ mouseX: number; startMs: number; endMs: number; sourceInMs: number; sourceOutMs: number; _prevDelta?: number }>({
    mouseX: 0, startMs: 0, endMs: 0, sourceInMs: 0, sourceOutMs: 0,
  });

  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const selectedClipIds = useComposeStore((s) => s.selectedClipIds);
  const selectClip = useComposeStore((s) => s.selectClip);
  const moveClip = useComposeStore((s) => s.moveClip);
  const moveSelectedClips = useComposeStore((s) => s.moveSelectedClips);
  const trimClip = useComposeStore((s) => s.trimClip);
  const updateClip = useComposeStore((s) => s.updateClip);

  const isSelected = selectedClipIds.includes(clip.id);
  const isMultiSelected = selectedClipIds.length > 1;
  const leftPx = (clip.timelineStartMs - scrollOffsetMs) * zoomLevel;
  const widthPx = (clip.timelineEndMs - clip.timelineStartMs) * zoomLevel;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      useComposeStore.getState().saveSnapshot();

      const addToSelection = e.shiftKey || e.metaKey || e.ctrlKey;
      if (mode === 'move' && isSelected && isMultiSelected) {
        // Keep group selection for dragging
      } else {
        selectClip(clip.id, addToSelection);
      }
      useComposeStore.getState().selectSubtitle(null);

      dragOrigin.current = {
        mouseX: e.clientX,
        startMs: clip.timelineStartMs,
        endMs: clip.timelineEndMs,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
      };
      setDragMode(mode);
    },
    [clip, selectClip, isSelected, isMultiSelected]
  );

  useEffect(() => {
    if (!dragMode) return;

    const SNAP_THRESHOLD_MS = 200;

    const getSnapTargets = (): number[] => {
      const store = useComposeStore.getState();
      const targets: number[] = [store.currentTimeMs];
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
        const store = useComposeStore.getState();
        if (store.selectedClipIds.length > 1 && store.selectedClipIds.includes(clip.id)) {
          moveSelectedClips(deltaMs - (dragOrigin.current._prevDelta ?? 0));
          dragOrigin.current._prevDelta = deltaMs;
        } else {
          const rawStart = Math.max(0, dragOrigin.current.startMs + deltaMs);
          const duration = dragOrigin.current.endMs - dragOrigin.current.startMs;
          const snappedStart = snap(rawStart);
          const snappedEnd = snap(rawStart + duration);
          const finalStart = snappedStart !== rawStart ? snappedStart
            : snappedEnd !== rawStart + duration ? snappedEnd - duration
              : rawStart;
          moveClip(clip.id, finalStart);
        }
      } else if (dragMode === 'trim-in') {
        const rawStart = Math.max(0, dragOrigin.current.startMs + deltaMs);
        trimClip(clip.id, 'in', snap(rawStart));
      } else if (dragMode === 'trim-out') {
        const rawEnd = Math.max(0, dragOrigin.current.endMs + deltaMs);
        trimClip(clip.id, 'out', snap(rawEnd));
      }
    };

    const handleMouseUp = () => {
      dragOrigin.current._prevDelta = undefined;
      setDragMode(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragMode, clip.id, zoomLevel, moveClip, moveSelectedClips, trimClip]);

  const isTextClip = clip.type === 'text';
  const hasSourceTrim = clip.type === 'video' || clip.type === 'audio';

  const handleDoubleClick = useCallback(() => {
    if (isTextClip) {
      setTextValue(clip.textContent ?? '');
      setEditingText(true);
      setTimeout(() => textInputRef.current?.focus(), 0);
    }
  }, [isTextClip, clip.textContent]);

  const handleTextConfirm = useCallback(() => {
    updateClip(clip.id, { textContent: textValue });
    setEditingText(false);
  }, [updateClip, clip.id, textValue]);

  const icon = clip.type === 'video'
    ? <Film className="h-3 w-3 flex-shrink-0" />
    : clip.type === 'audio'
      ? <Music className="h-3 w-3 flex-shrink-0" />
      : clip.type === 'image' || clip.type === 'gif'
        ? <ImageIcon className="h-3 w-3 flex-shrink-0" />
        : <Type className="h-3 w-3 flex-shrink-0" />;

  const clipColor = clip.type === 'video'
    ? clip.mode === 'overlay'
      ? 'bg-purple-600/80 border-purple-400'
      : 'bg-blue-600/80 border-blue-400'
    : clip.type === 'audio'
      ? 'bg-green-600/80 border-green-400'
      : clip.type === 'image' || clip.type === 'gif'
        ? 'bg-purple-600/80 border-purple-400'
        : 'bg-orange-600/80 border-orange-400';

  const displayLabel = isTextClip
    ? (clip.textContent || 'Text')
    : clip.originalName;

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
      onDoubleClick={handleDoubleClick}
    >
      {/* Trim-in handle */}
      {hasSourceTrim && (
        <div
          className="absolute left-0 top-0 bottom-0 w-3 cursor-ew-resize z-10 group/trim"
          onMouseDown={(e) => handleMouseDown(e, 'trim-in')}
        >
          <div className="absolute left-0.5 top-1 bottom-1 w-1 rounded-full bg-white/40 transition-colors group-hover/trim:bg-white/80" />
        </div>
      )}

      {/* Content */}
      <div className="flex items-center gap-1 min-w-0 pointer-events-none">
        {icon}
        {editingText ? (
          <input
            ref={textInputRef}
            className="text-[9px] text-white bg-transparent border-b border-white/50 outline-none min-w-[40px] pointer-events-auto"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onBlur={handleTextConfirm}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') handleTextConfirm();
              if (e.key === 'Escape') setEditingText(false);
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-[9px] text-white/90 truncate">{displayLabel}</span>
        )}
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
