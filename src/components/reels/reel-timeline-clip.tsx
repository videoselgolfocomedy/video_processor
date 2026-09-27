'use client';

import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { ClipWaveform } from '@/components/parts/clip-waveform';
import { useAudioRegions } from '@/components/parts/audio-regions-context';
import { stemKindOfTrack, stemOriginalOf } from '@/lib/audio-stems';
import { rowDeltaForDy } from '@/lib/track-heights';
import { clipFitsTrack } from '@/lib/track-compat';
import { ClipGainBands } from '@/components/shared/clip-gain-bands';
import { Film, Music, ImageIcon, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReelStore } from '@/stores/reel-store';
import { useProjectStore } from '@/stores/project-store';
import type { CompositionClip } from '@/types/project';

interface ReelTimelineClipProps {
  reelId: string;
  clip: CompositionClip;
  trackLocked: boolean;
}

type DragMode = 'move' | 'trim-in' | 'trim-out' | null;


export function ReelTimelineClip({ reelId, clip, trackLocked }: ReelTimelineClipProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [editingText, setEditingText] = useState(false);
  const [textValue, setTextValue] = useState(clip.textContent ?? '');
  const textInputRef = useRef<HTMLInputElement>(null);
  const dragOrigin = useRef<{ mouseX: number; mouseY: number; startMs: number; endMs: number; sourceInMs: number; sourceOutMs: number; _prevDelta?: number }>({ mouseX: 0, mouseY: 0, startMs: 0, endMs: 0, sourceInMs: 0, sourceOutMs: 0 });
  // Pending cross-track drop target, resolved live and committed on mouse-up.
  const dragTrackTargetRef = useRef<string | null>(null);

  const zoomLevel = useReelStore((s) => s.zoomLevel);
  const stemKind = stemKindOfTrack(clip.trackId);
  // Original signal behind the processed stem (Sync & Mix's gray reference).
  const project = useProjectStore((s) => s.currentProject);
  const viewportWidthPx = useReelStore((s) => s.viewportWidthPx);
  const behind = useMemo(() => (stemKind && project ? stemOriginalOf(project, clip.fileName) : null), [stemKind, project, clip.fileName]);
  const regions = useAudioRegions();
  const plan = stemKind === 'ambient' && regions ? regions.ambientPlanForFile(clip.fileName) : null;
  const scrollOffsetMs = useReelStore((s) => s.scrollOffsetMs);
  const selectedClipIds = useReelStore((s) => s.selectedClipIds);
  const selectClip = useReelStore((s) => s.selectClip);
  const moveClip = useReelStore((s) => s.moveClip);
  const moveClipToTrack = useReelStore((s) => s.moveClipToTrack);
  const moveSelectedClips = useReelStore((s) => s.moveSelectedClips);
  const trimClip = useReelStore((s) => s.trimClip);

  const isSelected = selectedClipIds.includes(clip.id);
  const isMultiSelected = selectedClipIds.length > 1;
  const leftPx = (clip.timelineStartMs - scrollOffsetMs) * zoomLevel;
  const widthPx = (clip.timelineEndMs - clip.timelineStartMs) * zoomLevel;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      // All interactions allowed on all tracks
      e.preventDefault();
      e.stopPropagation();
      useReelStore.getState().saveSnapshot();

      // Selecting a clip makes its track the active paste target.
      useReelStore.getState().setActiveTrackId(clip.trackId);

      const addToSelection = e.shiftKey || e.metaKey || e.ctrlKey;
      // For move mode: if this clip is already in multi-selection, keep selection
      if (mode === 'move' && isSelected && isMultiSelected) {
        // Don't change selection, just start dragging the group
      } else {
        selectClip(clip.id, addToSelection);
      }
      useReelStore.getState().selectSubtitle(null);

      dragOrigin.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        startMs: clip.timelineStartMs,
        endMs: clip.timelineEndMs,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
      };
      dragTrackTargetRef.current = null;
      setDragMode(mode);
    },
    [clip, selectClip, isSelected, isMultiSelected]
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
        const store = useReelStore.getState();
        if (store.selectedClipIds.length > 1 && store.selectedClipIds.includes(clip.id)) {
          // Multi-drag: move all selected clips by deltaMs
          moveSelectedClips(reelId, deltaMs - (dragOrigin.current._prevDelta ?? 0));
          dragOrigin.current._prevDelta = deltaMs;
        } else {
          const rawStart = Math.max(0, dragOrigin.current.startMs + deltaMs);
          const duration = dragOrigin.current.endMs - dragOrigin.current.startMs;
          const snappedStart = snap(rawStart);
          const snappedEnd = snap(rawStart + duration);
          const finalStart = snappedStart !== rawStart ? snappedStart
            : snappedEnd !== rawStart + duration ? snappedEnd - duration
              : rawStart;
          moveClip(reelId, clip.id, finalStart);

          // Cross-track drag: resolve which compatible track the cursor is over.
          // We keep the clip on its original track while dragging (the track
          // body clips overflow) and only commit the track change on mouse-up;
          // here we just highlight the prospective target.
          const tracks = store.reels.find((r) => r.id === reelId)?.composition.tracks ?? [];
          const startIdx = tracks.findIndex((t) => t.id === clip.trackId);
          const rowDelta = rowDeltaForDy(tracks, startIdx, e.clientY - dragOrigin.current.mouseY);
          let target: string | null = null;
          if (startIdx >= 0 && rowDelta !== 0) {
            const targetIdx = Math.max(0, Math.min(tracks.length - 1, startIdx + rowDelta));
            const tt = tracks[targetIdx];
            if (tt && tt.id !== clip.trackId && !tt.locked && clipFitsTrack(clip.type, tt.type)) {
              target = tt.id;
            }
          }
          dragTrackTargetRef.current = target;
          if (store.dragTargetTrackId !== target) store.setDragTargetTrackId(target);
        }
      } else if (dragMode === 'trim-in') {
        const rawStart = Math.max(0, dragOrigin.current.startMs + deltaMs);
        trimClip(reelId, clip.id, 'in', snap(rawStart));
      } else if (dragMode === 'trim-out') {
        const rawEnd = Math.max(0, dragOrigin.current.endMs + deltaMs);
        trimClip(reelId, clip.id, 'out', snap(rawEnd));
      }
    };

    const handleMouseUp = () => {
      dragOrigin.current._prevDelta = undefined;
      // Commit a pending cross-track move (resolved during the drag).
      const target = dragTrackTargetRef.current;
      if (target) {
        const store = useReelStore.getState();
        const fresh = store.reels
          .find((r) => r.id === reelId)
          ?.composition.clips.find((c) => c.id === clip.id);
        if (fresh && fresh.trackId !== target) {
          moveClipToTrack(reelId, clip.id, target, fresh.timelineStartMs);
        }
      }
      dragTrackTargetRef.current = null;
      useReelStore.getState().setDragTargetTrackId(null);
      setDragMode(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragMode, clip.id, clip.trackId, clip.type, reelId, zoomLevel, moveClip, moveClipToTrack, moveSelectedClips, trimClip]);

  const updateClip = useReelStore((s) => s.updateClip);

  const icon = clip.type === 'video'
    ? <Film className="h-3 w-3 flex-shrink-0" />
    : clip.type === 'audio'
      ? <Music className="h-3 w-3 flex-shrink-0" />
      : clip.type === 'image' || clip.type === 'gif'
        ? <ImageIcon className="h-3 w-3 flex-shrink-0" />
        : <Type className="h-3 w-3 flex-shrink-0" />;

  const clipColor = clip.type === 'video'
    ? 'bg-blue-600/80 border-blue-400'
    : clip.type === 'audio'
      ? (stemKind === 'board'
          ? 'bg-emerald-950/75 border-emerald-500/70'
          : stemKind === 'ambient'
            ? 'bg-sky-950/75 border-sky-500/70'
            : 'bg-green-900/75 border-green-500/70')
      : clip.type === 'image' || clip.type === 'gif'
        ? 'bg-purple-600/80 border-purple-400'
        : 'bg-orange-600/80 border-orange-400';
  const waveColor = stemKind === 'board' ? 'rgba(52,211,153,0.85)' : stemKind === 'ambient' ? 'rgba(56,189,248,0.85)' : 'rgba(134,239,172,0.8)';

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
    updateClip(reelId, clip.id, { textContent: textValue });
    setEditingText(false);
  }, [updateClip, reelId, clip.id, textValue]);

  const displayLabel = isTextClip
    ? (clip.textContent || 'Text')
    : clip.originalName;

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
      onDoubleClick={handleDoubleClick}
    >
      {/* The audio itself, drawn like the Sync & Mix rows (scaled by the clip volume) */}
      {clip.type === 'audio' && (
        <>
          <ClipWaveform fileName={clip.fileName} sourceInMs={clip.sourceInMs} sourceOutMs={clip.sourceOutMs} leftPx={leftPx} widthPx={widthPx} viewportWidthPx={viewportWidthPx} color={waveColor} gain={clip.volume ?? 1} behind={behind} plan={plan} />
          <ClipGainBands clip={clip} zoomLevel={zoomLevel} />
        </>
      )}
      {/* Trim-in handle (only for source-based clips) */}
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
          <span className={cn('text-[9px] text-white/90 truncate', clip.type === 'audio' && 'rounded bg-black/45 px-1')}>{displayLabel}</span>
        )}
      </div>

      {/* Trim-out handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize z-10 group/trim"
        onMouseDown={(e) => handleMouseDown(e, hasSourceTrim ? 'trim-out' : 'trim-out')}
      >
        <div className="absolute right-0.5 top-1 bottom-1 w-1 rounded-full bg-white/40 transition-colors group-hover/trim:bg-white/80" />
      </div>
    </div>
  );
}
