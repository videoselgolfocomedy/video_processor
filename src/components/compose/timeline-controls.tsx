'use client';

import { Play, Pause, Undo2, Redo2, Save, ZoomIn, ZoomOut, Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { useComposeStore } from '@/stores/compose-store';
import { formatDuration } from '@/lib/utils';

interface TimelineControlsProps {
  onSave: () => void;
  saving: boolean;
}

export function TimelineControls({ onSave, saving }: TimelineControlsProps) {
  const currentTimeMs = useComposeStore((s) => s.currentTimeMs);
  const durationMs = useComposeStore((s) => s.durationMs);
  const isPlaying = useComposeStore((s) => s.isPlaying);
  const setIsPlaying = useComposeStore((s) => s.setIsPlaying);
  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const setZoom = useComposeStore((s) => s.setZoom);
  const undo = useComposeStore((s) => s.undo);
  const redo = useComposeStore((s) => s.redo);
  const undoStack = useComposeStore((s) => s.undoStack);
  const redoStack = useComposeStore((s) => s.redoStack);
  const dirty = useComposeStore((s) => s.dirty);
  const selectedClipId = useComposeStore((s) => s.selectedClipId);
  const clips = useComposeStore((s) => s.clips);
  const splitClipAtPlayhead = useComposeStore((s) => s.splitClipAtPlayhead);

  // Check if split is possible
  const selectedClip = selectedClipId ? clips.find((c) => c.id === selectedClipId) : null;
  const canSplit = selectedClip
    ? currentTimeMs > selectedClip.timelineStartMs && currentTimeMs < selectedClip.timelineEndMs
    : false;

  // Zoom slider: map 0-100 to 0.01-1 logarithmically
  const zoomToSlider = (z: number) => Math.round(Math.log(z / 0.01) / Math.log(1 / 0.01) * 100);
  const sliderToZoom = (v: number) => 0.01 * Math.pow(1 / 0.01, v / 100);

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5">
      {/* Play/Pause */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => setIsPlaying(!isPlaying)}
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>

      {/* Time display */}
      <span className="font-mono text-xs text-foreground min-w-[100px]">
        {formatDuration(currentTimeMs)} / {formatDuration(durationMs)}
      </span>

      <div className="flex-1" />

      {/* Zoom controls */}
      <ZoomOut className="h-3 w-3 text-muted-foreground" />
      <Slider
        value={[zoomToSlider(zoomLevel)]}
        onValueChange={([v]) => setZoom(sliderToZoom(v))}
        min={0}
        max={100}
        step={1}
        className="w-24"
      />
      <ZoomIn className="h-3 w-3 text-muted-foreground" />

      <div className="mx-2 h-4 w-px bg-border" />

      {/* Split */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={splitClipAtPlayhead}
        disabled={!canSplit}
        title="Split clip at playhead (S)"
      >
        <Scissors className="h-3.5 w-3.5" />
      </Button>

      {/* Undo/Redo */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={undo}
        disabled={undoStack.length === 0}
        title="Undo (Ctrl+Z)"
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={redo}
        disabled={redoStack.length === 0}
        title="Redo (Ctrl+Y)"
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>

      <div className="mx-2 h-4 w-px bg-border" />

      {/* Save */}
      <Button
        variant={dirty ? 'default' : 'ghost'}
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={onSave}
        disabled={saving}
        title="Save (Ctrl+S)"
      >
        <Save className="h-3.5 w-3.5" />
        {saving ? 'Saving...' : dirty ? 'Save' : 'Saved'}
      </Button>
    </div>
  );
}
