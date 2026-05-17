'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Play, Pause, Scissors, ArrowLeft, ZoomIn, ZoomOut,
  Trash2, ChevronsLeftRight, XCircle, ArrowLeftToLine,
  Shrink, SkipBack, SkipForward, ChevronLeft, ChevronRight,
  Gauge, RefreshCw, ListRestart, Undo2, Redo2, Plus, SplitSquareVertical,
  Bookmark, History, RotateCcw, ChevronsLeft,
  Film, Music, ImageIcon, Type, Layers,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { useReelStore, getReelEffectiveDurationMs } from '@/stores/reel-store';

/* ── Editable timecode ──────────────────────────────────────────────── */

function formatTimeCode(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function parseTimeCode(str: string): number | null {
  // Accept formats: MM:SS.d, MM:SS, SS.d, SS
  const trimmed = str.trim();

  // MM:SS or MM:SS.d
  const colonMatch = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (colonMatch) {
    const mins = parseInt(colonMatch[1]);
    const secs = parseFloat(colonMatch[2]);
    if (isNaN(mins) || isNaN(secs) || secs >= 60) return null;
    return (mins * 60 + secs) * 1000;
  }

  // Just seconds: SS or SS.d
  const num = parseFloat(trimmed);
  if (!isNaN(num) && num >= 0) return num * 1000;

  return null;
}

function EditableTimeCode({
  ms,
  onChange,
  className,
}: {
  ms: number;
  onChange: (ms: number) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = useCallback(() => {
    setEditValue(formatTimeCode(ms));
    setEditing(true);
  }, [ms]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const handleConfirm = () => {
    const parsed = parseTimeCode(editValue);
    if (parsed !== null) {
      onChange(parsed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`bg-muted/50 border border-primary rounded px-1 text-xs font-mono outline-none text-center ${className ?? ''}`}
        style={{ width: '5.5em' }}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleConfirm}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleConfirm();
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className={`font-mono text-xs cursor-text hover:bg-muted/40 rounded px-0.5 ${className ?? ''}`}
      onClick={handleStartEdit}
      title="Click to edit time"
    >
      {formatTimeCode(ms)}
    </span>
  );
}

/* ── Speed selector ─────────────────────────────────────────────────── */

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function SpeedSelector() {
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleSetSpeed = (s: number) => {
    setSpeed(s);
    setOpen(false);
    // Apply to video/audio elements
    const video = document.querySelector('video');
    const audio = document.querySelector('audio');
    if (video) video.playbackRate = s;
    if (audio) audio.playbackRate = s;
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [open]);

  return (
    <div className="relative">
      <Button
        ref={btnRef}
        variant="ghost"
        size="sm"
        className="h-7 px-1.5 text-[10px] font-mono gap-0.5"
        onClick={() => setOpen(!open)}
        title="Playback speed"
      >
        <Gauge className="h-3 w-3" />
        {speed}x
      </Button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 bg-popover border border-border rounded-md shadow-md py-1 min-w-[60px] z-50">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`block w-full px-3 py-1 text-xs text-left hover:bg-muted ${
                s === speed ? 'text-primary font-medium' : 'text-foreground'
              }`}
              onClick={() => handleSetSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main controls bar ──────────────────────────────────────────────── */

interface ReelTimelineControlsProps {
  reelId: string;
}

export function ReelTimelineControls({ reelId }: ReelTimelineControlsProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const isPlaying = useReelStore((s) => s.isPlaying);
  const setIsPlaying = useReelStore((s) => s.setIsPlaying);
  const setCurrentTime = useReelStore((s) => s.setCurrentTime);
  const zoomLevel = useReelStore((s) => s.zoomLevel);
  const setZoom = useReelStore((s) => s.setZoom);
  const setPhase = useReelStore((s) => s.setPhase);
  const selectedClipIds = useReelStore((s) => s.selectedClipIds);
  const selectedSubtitleIds = useReelStore((s) => s.selectedSubtitleIds);
  const splitClipAtPlayhead = useReelStore((s) => s.splitClipAtPlayhead);
  const splitAllAtPlayhead = useReelStore((s) => s.splitAllAtPlayhead);
  const splitSubtitleAtPlayhead = useReelStore((s) => s.splitSubtitleAtPlayhead);
  const addSubtitleSegment = useReelStore((s) => s.addSubtitleSegment);
  const deleteSelected = useReelStore((s) => s.deleteSelected);
  const rippleDeleteSelected = useReelStore((s) => s.rippleDeleteSelected);
  const collapseGapAtPlayhead = useReelStore((s) => s.collapseGapAtPlayhead);
  const closeGapForSelected = useReelStore((s) => s.closeGapForSelected);
  const clearTimeline = useReelStore((s) => s.clearTimeline);
  const syncSubtitlesToClips = useReelStore((s) => s.syncSubtitlesToClips);
  const resetTimeline = useReelStore((s) => s.resetTimeline);
  const undo = useReelStore((s) => s.undo);
  const redo = useReelStore((s) => s.redo);
  const hasUndo = useReelStore((s) => s.undoStack.length > 0);
  const hasRedo = useReelStore((s) => s.redoStack.length > 0);
  const saveVersion = useReelStore((s) => s.saveVersion);
  const restoreVersion = useReelStore((s) => s.restoreVersion);
  const deleteVersion = useReelStore((s) => s.deleteVersion);
  const versions = reel?.versions ?? [];
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const versionBtnRef = useRef<HTMLButtonElement>(null);

  const addTrack = useReelStore((s) => s.addTrack);
  const [addTrackOpen, setAddTrackOpen] = useState(false);
  const addTrackRef = useRef<HTMLDivElement>(null);

  // Effective playable duration after timeline edits — shrinks when the user
  // cuts content from the tail. Was `reel.endMs - reel.startMs` (source
  // window) which never updated after edits, so the timecode display read
  // 42.3 s for a reel whose actual content ends at 37.5 s.
  const reelDurationMs = getReelEffectiveDurationMs(reel);

  const canSplit = reel
    ? reel.composition.clips.some((c) => currentTimeMs > c.timelineStartMs && currentTimeMs < c.timelineEndMs)
    : false;

  const canSplitAll = canSplit;

  const canSplitSub = reel
    ? reel.subtitleSegments.some((s) => currentTimeMs > s.startMs && currentTimeMs < s.endMs)
    : false;

  const hasSelection = selectedClipIds.length > 0 || selectedSubtitleIds.length > 0;
  const hasClipSelection = selectedClipIds.length > 0;
  const hasClips = reel ? reel.composition.clips.length > 0 : false;

  const zoomToSlider = (z: number) => Math.round(Math.log(z / 0.01) / Math.log(1 / 0.01) * 100);
  const sliderToZoom = (v: number) => 0.01 * Math.pow(1 / 0.01, v / 100);

  // Close add track menu on outside click
  useEffect(() => {
    if (!addTrackOpen) return;
    const handler = (e: MouseEvent) => {
      if (addTrackRef.current && !addTrackRef.current.contains(e.target as Node)) {
        setAddTrackOpen(false);
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [addTrackOpen]);

  // Close version menu on outside click
  useEffect(() => {
    if (!versionMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (versionBtnRef.current && !versionBtnRef.current.contains(e.target as Node)) {
        setVersionMenuOpen(false);
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [versionMenuOpen]);

  // Navigation helpers
  const goToStart = () => setCurrentTime(0);
  const goToEnd = () => setCurrentTime(reelDurationMs);
  const framePrev = () => setCurrentTime(Math.max(0, currentTimeMs - 100)); // ~3 frames at 30fps
  const frameNext = () => setCurrentTime(Math.min(reelDurationMs, currentTimeMs + 100));

  return (
    <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-1">
      {/* ── Transport ── */}
      {/* Go to start */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={goToStart}
        title="Go to start"
      >
        <SkipBack className="h-3.5 w-3.5" />
      </Button>

      {/* Frame back */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={framePrev}
        title="Step back 0.1s (Shift+←)"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>

      {/* Play / Pause */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={() => setIsPlaying(!isPlaying)}
        title="Play/Pause (Space)"
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>

      {/* Frame forward */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={frameNext}
        title="Step forward 0.1s (Shift+→)"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>

      {/* Go to end */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={goToEnd}
        title="Go to end"
      >
        <SkipForward className="h-3.5 w-3.5" />
      </Button>

      {/* ── Editable timecode ── */}
      <div className="flex items-center gap-0 text-xs text-foreground min-w-[120px]">
        <EditableTimeCode
          ms={currentTimeMs}
          onChange={(ms) => setCurrentTime(Math.max(0, Math.min(reelDurationMs, ms)))}
        />
        <span className="text-muted-foreground mx-0.5">/</span>
        <span className="font-mono text-muted-foreground">{formatTimeCode(reelDurationMs)}</span>
      </div>

      {/* Speed */}
      <SpeedSelector />

      <div className="mx-0.5 h-4 w-px bg-border" />

      {/* ── Undo/Redo ── */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={() => undo(reelId)}
        disabled={!hasUndo}
        title="Undo (Ctrl+Z)"
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={() => redo(reelId)}
        disabled={!hasRedo}
        title="Redo (Ctrl+Shift+Z)"
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>

      {/* ── Versions ── */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-emerald-400 hover:text-emerald-300"
        onClick={() => {
          const label = window.prompt('Version label:', `v${versions.length + 1}`);
          if (label) saveVersion(reelId, label);
        }}
        title="Save current state as version"
      >
        <Bookmark className="h-3.5 w-3.5" />
      </Button>
      <div className="relative">
        <Button
          ref={versionBtnRef}
          variant="ghost" size="sm" className="h-7 px-1.5 text-[10px] gap-0.5"
          onClick={() => setVersionMenuOpen(!versionMenuOpen)}
          disabled={versions.length === 0}
          title="Version history"
        >
          <History className="h-3.5 w-3.5" />
          {versions.length > 0 && <span>{versions.length}</span>}
        </Button>
        {versionMenuOpen && versions.length > 0 && (
          <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded-md shadow-lg py-1 min-w-[200px] z-50 max-h-[300px] overflow-y-auto">
            {versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-xs group"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{v.label}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString()} &middot; {v.clips.length} clips &middot; {v.subtitleSegments.length} subs
                  </div>
                </div>
                <Button
                  variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Restore version "${v.label}"? Current state will be saved to undo.`)) {
                      restoreVersion(reelId, v.id);
                      setVersionMenuOpen(false);
                    }
                  }}
                  title="Restore this version"
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-400 opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteVersion(reelId, v.id);
                  }}
                  title="Delete this version"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mx-0.5 h-4 w-px bg-border" />

      {/* ── Edit tools ── */}
      {/* Split selected */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={() => splitClipAtPlayhead(reelId)}
        disabled={!canSplit}
        title="Split selected (S)"
      >
        <Scissors className="h-3.5 w-3.5" />
      </Button>

      {/* Split all */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0"
        onClick={() => splitAllAtPlayhead(reelId)}
        disabled={!canSplitAll}
        title="Split all tracks (Shift+S)"
      >
        <ChevronsLeftRight className="h-3.5 w-3.5" />
      </Button>

      <div className="mx-0.5 h-4 w-px bg-border" />

      {/* Delete selected */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
        onClick={() => deleteSelected(reelId)}
        disabled={!hasSelection}
        title="Delete selected (Del)"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>

      {/* Ripple delete */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-orange-400 hover:text-orange-300"
        onClick={() => rippleDeleteSelected(reelId)}
        disabled={!hasClipSelection}
        title="Delete + close gap (Shift+Del)"
      >
        <ArrowLeftToLine className="h-3.5 w-3.5" />
      </Button>

      {/* Collapse gap at playhead */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-sky-400 hover:text-sky-300"
        onClick={() => collapseGapAtPlayhead(reelId)}
        disabled={!hasClips}
        title="Close gap at playhead (G)"
      >
        <Shrink className="h-3.5 w-3.5" />
      </Button>

      {/* Close gap for selected clips */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-sky-400 hover:text-sky-300"
        onClick={() => closeGapForSelected(reelId)}
        disabled={!hasClipSelection}
        title="Close gap for selected clips (Shift+G)"
      >
        <ChevronsLeft className="h-3.5 w-3.5" />
      </Button>

      {/* Clear all */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
        onClick={() => {
          if (window.confirm('Clear all clips from the timeline?')) {
            clearTimeline(reelId);
          }
        }}
        disabled={!hasClips}
        title="Clear all clips"
      >
        <XCircle className="h-3.5 w-3.5" />
      </Button>

      <div className="mx-0.5 h-4 w-px bg-border" />

      {/* ── Subtitle tools ── */}
      {/* Split subtitle at playhead */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-yellow-400 hover:text-yellow-300"
        onClick={() => splitSubtitleAtPlayhead(reelId)}
        disabled={!canSplitSub}
        title="Split subtitle at playhead"
      >
        <SplitSquareVertical className="h-3.5 w-3.5" />
      </Button>

      {/* Add subtitle at playhead */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-yellow-400 hover:text-yellow-300"
        onClick={() => addSubtitleSegment(reelId)}
        title="Add subtitle at playhead"
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>

      {/* Sync subtitles to match current clips */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-yellow-400 hover:text-yellow-300"
        onClick={() => syncSubtitlesToClips(reelId)}
        disabled={!hasClips}
        title="Sync subtitles to clips (remove subs in gaps)"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>

      {/* Reset timeline — clear clips + regenerate subtitles */}
      <Button
        variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
        onClick={() => {
          if (window.confirm('Reset timeline? Clips will be cleared and subtitles regenerated.')) {
            resetTimeline(reelId);
          }
        }}
        title="Reset timeline (clear clips + regen subtitles)"
      >
        <ListRestart className="h-3.5 w-3.5" />
      </Button>

      <div className="mx-0.5 h-4 w-px bg-border" />

      {/* ── Add Track ── */}
      <div className="relative" ref={addTrackRef}>
        <Button
          variant="ghost" size="sm" className="h-7 px-1.5 text-[10px] gap-0.5 text-purple-400 hover:text-purple-300"
          onClick={() => setAddTrackOpen(!addTrackOpen)}
          title="Add track"
        >
          <Layers className="h-3.5 w-3.5" />
          <Plus className="h-2.5 w-2.5" />
        </Button>
        {addTrackOpen && (
          <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded-md shadow-lg py-1 min-w-[140px] z-50">
            {[
              { type: 'video' as const, label: 'Video', icon: Film, color: 'text-blue-400' },
              { type: 'audio' as const, label: 'Audio', icon: Music, color: 'text-green-400' },
              { type: 'image' as const, label: 'Image/Photo', icon: ImageIcon, color: 'text-purple-400' },
              { type: 'text' as const, label: 'Text Overlay', icon: Type, color: 'text-orange-400' },
            ].map(({ type, label, icon: Icon, color }) => (
              <button
                key={type}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted text-left"
                onClick={() => {
                  addTrack(reelId, type, label);
                  setAddTrackOpen(false);
                }}
              >
                <Icon className={`h-3.5 w-3.5 ${color}`} />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* ── Zoom ── */}
      <ZoomOut className="h-3 w-3 text-muted-foreground" />
      <Slider
        value={[zoomToSlider(zoomLevel)]}
        onValueChange={([v]) => setZoom(sliderToZoom(v))}
        min={0} max={100} step={1}
        className="w-20"
      />
      <ZoomIn className="h-3 w-3 text-muted-foreground" />

      <div className="mx-0.5 h-4 w-px bg-border" />

      <Button
        variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs"
        onClick={() => setPhase('setup')}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Setup
      </Button>
    </div>
  );
}
