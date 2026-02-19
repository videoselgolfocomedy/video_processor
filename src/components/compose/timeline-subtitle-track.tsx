'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useComposeStore } from '@/stores/compose-store';

export function TimelineSubtitleTrack() {
  const segments = useComposeStore((s) => s.subtitleSegments);
  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const updateSubtitleSegment = useComposeStore((s) => s.updateSubtitleSegment);
  const setCurrentTime = useComposeStore((s) => s.setCurrentTime);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [trimming, setTrimming] = useState<{ segId: string; edge: 'start' | 'end' } | null>(null);
  const trimOrigin = useRef({ mouseX: 0, origMs: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  // Handle inline text editing
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

  // Handle trim dragging
  const handleTrimMouseDown = useCallback(
    (e: React.MouseEvent, segId: string, edge: 'start' | 'end', origMs: number) => {
      e.preventDefault();
      e.stopPropagation();
      trimOrigin.current = { mouseX: e.clientX, origMs };
      setTrimming({ segId, edge });
    },
    []
  );

  useEffect(() => {
    if (!trimming) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaMs = (e.clientX - trimOrigin.current.mouseX) / zoomLevel;
      const newMs = Math.max(0, trimOrigin.current.origMs + deltaMs);
      if (trimming.edge === 'start') {
        updateSubtitleSegment(trimming.segId, { startMs: newMs });
      } else {
        updateSubtitleSegment(trimming.segId, { endMs: newMs });
      }
    };

    const handleMouseUp = () => setTrimming(null);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [trimming, zoomLevel, updateSubtitleSegment]);

  return (
    <>
      {segments.map((seg) => {
        const leftPx = (seg.startMs - scrollOffsetMs) * zoomLevel;
        const widthPx = (seg.endMs - seg.startMs) * zoomLevel;
        const isEditing = editingId === seg.id;

        return (
          <div
            key={seg.id}
            className={cn(
              'absolute top-1 bottom-1 rounded bg-yellow-600/70 border border-yellow-400/50',
              'flex items-center overflow-hidden select-none',
              isEditing && 'ring-1 ring-yellow-300'
            )}
            style={{ left: leftPx, width: Math.max(4, widthPx) }}
            onClick={(e) => {
              e.stopPropagation();
              setCurrentTime(seg.startMs);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startEdit(seg.id, seg.text);
            }}
          >
            {/* Trim start handle */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-yellow-300/30 z-10"
              onMouseDown={(e) => handleTrimMouseDown(e, seg.id, 'start', seg.startMs)}
            />

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
              className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-yellow-300/30 z-10"
              onMouseDown={(e) => handleTrimMouseDown(e, seg.id, 'end', seg.endMs)}
            />
          </div>
        );
      })}
    </>
  );
}
