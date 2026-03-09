'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useReelStore } from '@/stores/reel-store';
import type { SubtitleSegment } from '@/types/project';

interface ReelTimelineSubtitleBarProps {
  reelId: string;
  segments: SubtitleSegment[];
}

export function ReelTimelineSubtitleBar({ reelId, segments }: ReelTimelineSubtitleBarProps) {
  const zoomLevel = useReelStore((s) => s.zoomLevel);
  const scrollOffsetMs = useReelStore((s) => s.scrollOffsetMs);
  const selectedSubtitleId = useReelStore((s) => s.selectedSubtitleId);
  const selectSubtitle = useReelStore((s) => s.selectSubtitle);
  const updateReelSubtitleSegment = useReelStore((s) => s.updateReelSubtitleSegment);
  const setCurrentTime = useReelStore((s) => s.setCurrentTime);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [trimming, setTrimming] = useState<{ segId: string; edge: 'start' | 'end' } | null>(null);
  const trimOrigin = useRef({ mouseX: 0, origMs: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback((segId: string, text: string) => {
    setEditingId(segId);
    setEditText(text);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const commitEdit = useCallback(() => {
    if (editingId && editText.trim()) {
      updateReelSubtitleSegment(reelId, editingId, { text: editText.trim() });
    }
    setEditingId(null);
  }, [editingId, editText, reelId, updateReelSubtitleSegment]);

  const handleTrimMouseDown = useCallback(
    (e: React.MouseEvent, segId: string, edge: 'start' | 'end', origMs: number) => {
      e.preventDefault();
      e.stopPropagation();
      useReelStore.getState().saveSnapshot();
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
        updateReelSubtitleSegment(reelId, trimming.segId, { startMs: newMs });
      } else {
        updateReelSubtitleSegment(reelId, trimming.segId, { endMs: newMs });
      }
    };

    const handleMouseUp = () => setTrimming(null);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [trimming, zoomLevel, reelId, updateReelSubtitleSegment]);

  return (
    <>
      {segments.map((seg) => {
        const leftPx = (seg.startMs - scrollOffsetMs) * zoomLevel;
        const widthPx = (seg.endMs - seg.startMs) * zoomLevel;
        const isEditing = editingId === seg.id;
        const isSelected = selectedSubtitleId === seg.id;

        return (
          <div
            key={seg.id}
            className={cn(
              'absolute top-1 bottom-1 rounded bg-yellow-600/70 border border-yellow-400/50',
              'flex items-center overflow-hidden select-none',
              isEditing && 'ring-1 ring-yellow-300',
              isSelected && 'ring-2 ring-white/60'
            )}
            style={{ left: leftPx, width: Math.max(4, widthPx) }}
            onClick={(e) => {
              e.stopPropagation();
              selectSubtitle(seg.id);
              useReelStore.getState().selectClip(null);
              setCurrentTime(seg.startMs);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startEdit(seg.id, seg.text);
            }}
          >
            {/* Trim start handle */}
            <div
              className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-10 group/trim"
              onMouseDown={(e) => handleTrimMouseDown(e, seg.id, 'start', seg.startMs)}
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
              className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-10 group/trim"
              onMouseDown={(e) => handleTrimMouseDown(e, seg.id, 'end', seg.endMs)}
            >
              <div className="absolute right-0.5 top-1 bottom-1 w-1 rounded-full bg-yellow-300/40 transition-colors group-hover/trim:bg-yellow-300/80" />
            </div>
          </div>
        );
      })}
    </>
  );
}
