'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useComposeStore } from '@/stores/compose-store';

type DragMode = 'move' | 'trim-start' | 'trim-end' | null;

export function TimelineSubtitleTrack() {
  const segments = useComposeStore((s) => s.subtitleSegments);
  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const selectedSubtitleIds = useComposeStore((s) => s.selectedSubtitleIds);
  const selectSubtitle = useComposeStore((s) => s.selectSubtitle);
  const selectClip = useComposeStore((s) => s.selectClip);
  const updateSubtitleSegment = useComposeStore((s) => s.updateSubtitleSegment);
  const moveSelectedSubtitles = useComposeStore((s) => s.moveSelectedSubtitles);
  const setCurrentTime = useComposeStore((s) => s.setCurrentTime);
  const saveSnapshot = useComposeStore((s) => s.saveSnapshot);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const didDrag = useRef(false);
  const dragOrigin = useRef({ mouseX: 0, origMs: 0, segId: '', prevDelta: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback((segId: string, text: string) => {
    setEditingId(segId);
    setEditText(text);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const commitEdit = useCallback(() => {
    if (editingId && editText.trim()) {
      updateSubtitleSegment(editingId, { text: editText.trim() });
    }
    setEditingId(null);
  }, [editingId, editText, updateSubtitleSegment]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, segId: string, mode: DragMode, origMs: number) => {
      e.preventDefault();
      e.stopPropagation();

      const isAlreadySelected = selectedSubtitleIds.includes(segId);

      if (mode !== 'move') {
        if (!isAlreadySelected) {
          selectSubtitle(segId);
          selectClip(null);
        }
      }

      saveSnapshot();
      dragOrigin.current = { mouseX: e.clientX, origMs, segId, prevDelta: 0 };
      didDrag.current = false;
      setDragMode(mode);
    },
    [selectedSubtitleIds, selectSubtitle, selectClip, saveSnapshot]
  );

  useEffect(() => {
    if (!dragMode) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaMs = (e.clientX - dragOrigin.current.mouseX) / zoomLevel;

      if (!didDrag.current && Math.abs(e.clientX - dragOrigin.current.mouseX) < 3) return;

      if (!didDrag.current) {
        didDrag.current = true;
        const segId = dragOrigin.current.segId;
        const currentIds = useComposeStore.getState().selectedSubtitleIds;
        if (!currentIds.includes(segId)) {
          selectSubtitle(segId);
          selectClip(null);
        }
      }

      if (dragMode === 'move') {
        const incrementalDelta = deltaMs - dragOrigin.current.prevDelta;
        dragOrigin.current.prevDelta = deltaMs;
        moveSelectedSubtitles(incrementalDelta);
      } else if (dragMode === 'trim-start') {
        const newMs = Math.max(0, dragOrigin.current.origMs + deltaMs);
        updateSubtitleSegment(dragOrigin.current.segId, { startMs: newMs });
      } else if (dragMode === 'trim-end') {
        const newMs = Math.max(0, dragOrigin.current.origMs + deltaMs);
        updateSubtitleSegment(dragOrigin.current.segId, { endMs: newMs });
      }
    };

    const handleMouseUp = () => {
      if (!didDrag.current && dragMode === 'move') {
        const segId = dragOrigin.current.segId;
        selectSubtitle(segId, true);
        selectClip(null);
        const seg = segments.find((s) => s.id === segId);
        if (seg) setCurrentTime(seg.startMs);
      }
      setDragMode(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragMode, zoomLevel, segments, updateSubtitleSegment, moveSelectedSubtitles, setCurrentTime, selectSubtitle, selectClip]);

  return (
    <>
      {segments.map((seg) => {
        const leftPx = (seg.startMs - scrollOffsetMs) * zoomLevel;
        const widthPx = (seg.endMs - seg.startMs) * zoomLevel;
        const isEditing = editingId === seg.id;
        const isSelected = selectedSubtitleIds.includes(seg.id);

        return (
          <div
            key={seg.id}
            className={cn(
              'absolute top-1 bottom-1 rounded bg-yellow-600/70 border border-yellow-400/50',
              'flex items-center overflow-hidden select-none',
              isEditing && 'ring-1 ring-yellow-300',
              isSelected && 'ring-2 ring-white/60'
            )}
            style={{
              left: leftPx,
              width: Math.max(4, widthPx),
              cursor: dragMode === 'move' ? 'grabbing' : 'grab',
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startEdit(seg.id, seg.text);
            }}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).dataset.trimHandle) return;
              handleMouseDown(e, seg.id, 'move', seg.startMs);
            }}
          >
            {/* Trim start handle */}
            <div
              data-trim-handle="start"
              className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-10 group/trim"
              onMouseDown={(e) => handleMouseDown(e, seg.id, 'trim-start', seg.startMs)}
            >
              <div className="absolute left-0.5 top-1 bottom-1 w-1 rounded-full bg-yellow-300/40 transition-colors group-hover/trim:bg-yellow-300/80" />
            </div>

            {/* Content */}
            {isEditing ? (
              <input
                ref={inputRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit();
                  if (e.key === 'Escape') setEditingId(null);
                  e.stopPropagation();
                }}
                className="w-full bg-transparent text-[8px] text-white px-1 outline-none"
              />
            ) : (
              <span className="text-[8px] text-white/90 truncate px-1 pointer-events-none">
                {seg.text}
              </span>
            )}

            {/* Trim end handle */}
            <div
              data-trim-handle="end"
              className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-10 group/trim"
              onMouseDown={(e) => handleMouseDown(e, seg.id, 'trim-end', seg.endMs)}
            >
              <div className="absolute right-0.5 top-1 bottom-1 w-1 rounded-full bg-yellow-300/40 transition-colors group-hover/trim:bg-yellow-300/80" />
            </div>
          </div>
        );
      })}
    </>
  );
}
