'use client';

import { useCallback, useState, useEffect, useMemo } from 'react';
import { useComposeStore } from '@/stores/compose-store';
import { ComposePreview } from './compose-preview';
import { ComposeSubtitleEditor } from './compose-subtitle-editor';
import { ClipProperties } from './clip-properties';
import { ComposeOverlayTemplatesBar } from './compose-overlay-template-controls';
import { SubtitleSelectionStyleBar } from '@/components/subtitles/subtitle-selection-style-bar';
import { MultiTrackTimeline } from './multi-track-timeline';
import { SubtitleStyleEditor } from '@/components/subtitles/subtitle-style-editor';
import { useCustomPresets } from '@/hooks/use-custom-presets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Scissors } from 'lucide-react';
import { splitLongSegments } from '@/lib/subtitle-utils';
import type { SubtitleStyle } from '@/types/project';

interface ComposeLayoutProps {
  projectId: string;
  videoSrc?: string;
  audioSrc?: string;
  subtitleStyle: SubtitleStyle;
}

export function ComposeLayout({
  projectId,
  videoSrc,
  audioSrc,
}: ComposeLayoutProps) {
  const [saving, setSaving] = useState(false);
  const { customPresets, savePreset, deletePreset } = useCustomPresets(projectId);

  const getCompositionState = useComposeStore((s) => s.getCompositionState);
  const subtitleSegments = useComposeStore((s) => s.subtitleSegments);
  const markClean = useComposeStore((s) => s.markClean);
  const selectedClipIds = useComposeStore((s) => s.selectedClipIds);
  const selectedSubtitleIds = useComposeStore((s) => s.selectedSubtitleIds);
  const styleSelectedSubtitles = useComposeStore((s) => s.styleSelectedSubtitles);
  const clips = useComposeStore((s) => s.clips);
  const storeSubtitleStyle = useComposeStore((s) => s.subtitleStyle);
  const subtitleStylePreset = useComposeStore((s) => s.subtitleStylePreset);
  const subtitleConstraints = useComposeStore((s) => s.subtitleConstraints);
  const setSubtitleStyle = useComposeStore((s) => s.setSubtitleStyle);
  const setSubtitlePreset = useComposeStore((s) => s.setSubtitlePreset);
  const setSubtitleConstraints = useComposeStore((s) => s.setSubtitleConstraints);
  const regenerateSubtitles = useComposeStore((s) => s.regenerateSubtitles);
  const versions = useComposeStore((s) => s.versions);

  // Determine what the first selected clip is (for right panel context)
  const firstSelectedClip = useMemo(() => {
    if (selectedClipIds.length === 0) return null;
    return clips.find((c) => c.id === selectedClipIds[0]) ?? null;
  }, [selectedClipIds, clips]);

  // Right panel mode: derived from selection
  const panelMode = useMemo(() => {
    if (firstSelectedClip) {
      if (firstSelectedClip.type === 'text') return 'text-clip' as const;
      if (firstSelectedClip.type === 'image' || firstSelectedClip.type === 'gif') return 'image-clip' as const;
      return 'clip-properties' as const;
    }
    return 'subtitles' as const;
  }, [firstSelectedClip]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const compositionState = getCompositionState();
      await fetch(`/api/projects/${projectId}/compose`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...compositionState,
          subtitleStyle: storeSubtitleStyle,
          subtitleStylePreset,
          subtitleConstraints,
          versions,
        }),
      });

      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcription: { segments: subtitleSegments },
        }),
      });

      markClean();
    } catch (err) {
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }, [projectId, getCompositionState, subtitleSegments, markClean, storeSubtitleStyle, subtitleStylePreset, subtitleConstraints, versions]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const store = useComposeStore.getState();

      // Space: Play/Pause
      if (e.key === ' ') {
        e.preventDefault();
        store.setIsPlaying(!store.isPlaying);
        return;
      }

      // Delete/Backspace: delete selected (Shift = ripple delete)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (e.shiftKey) {
          store.rippleDeleteSelected();
        } else {
          store.deleteSelected();
        }
        return;
      }

      // Ctrl+Z: undo, Ctrl+Shift+Z: redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) { store.redo(); } else { store.undo(); }
        return;
      }

      // Ctrl+Y: redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        store.redo();
        return;
      }

      // Ctrl+S: save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
        return;
      }

      // Ctrl/Cmd+C: copy selected clips
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (store.selectedClipIds.length > 0) {
          e.preventDefault();
          store.copySelectedClips();
        }
        return;
      }

      // Ctrl/Cmd+V: paste clips at playhead
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (store.canPasteClips()) {
          e.preventDefault();
          store.pasteClips();
        }
        return;
      }

      // S: split selected clip, Shift+S: split all tracks
      if (e.key === 's' && !e.ctrlKey && !e.metaKey) {
        store.splitClipAtPlayhead();
        return;
      }
      if (e.key === 'S' && !e.ctrlKey && !e.metaKey) {
        store.splitAllAtPlayhead();
        return;
      }

      // Q: trim in to playhead
      if (e.key === 'q' || e.key === 'Q') {
        if (store.selectedClipIds.length === 1) {
          const clip = store.clips.find((c) => c.id === store.selectedClipIds[0]);
          if (clip && store.currentTimeMs > clip.timelineStartMs && store.currentTimeMs < clip.timelineEndMs) {
            store.saveSnapshot();
            store.trimClip(clip.id, 'in', store.currentTimeMs);
          }
        }
        return;
      }

      // W: trim out to playhead
      if (e.key === 'w' || e.key === 'W') {
        if (store.selectedClipIds.length === 1) {
          const clip = store.clips.find((c) => c.id === store.selectedClipIds[0]);
          if (clip && store.currentTimeMs > clip.timelineStartMs && store.currentTimeMs < clip.timelineEndMs) {
            store.saveSnapshot();
            store.trimClip(clip.id, 'out', store.currentTimeMs);
          }
        }
        return;
      }

      // G: collapse gap at playhead
      if (e.key === 'g' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        store.collapseGapAtPlayhead();
        return;
      }

      // Shift+G: close gap for selected
      if (e.key === 'G' && !e.ctrlKey && !e.metaKey) {
        store.closeGapForSelected();
        return;
      }

      // Arrow keys: seek (Shift = fine 100ms, normal = 1s)
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const step = e.shiftKey ? 100 : 1000;
        store.setCurrentTime(Math.max(0, store.currentTimeMs - step));
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 100 : 1000;
        store.setCurrentTime(Math.min(store.durationMs, store.currentTimeMs + step));
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  // Constraint violations
  const violations = subtitleSegments.filter(
    (s) => s.text.length > subtitleConstraints.maxCharsPerBlock || (s.endMs - s.startMs) > subtitleConstraints.maxDurationMs
  ).length;

  const handleAutoSplit = useCallback(() => {
    const { maxCharsPerBlock, maxDurationMs } = subtitleConstraints;
    const split = splitLongSegments(subtitleSegments, maxCharsPerBlock, maxDurationMs);
    // Use store's setSubtitleSegments to avoid undo complexity
    useComposeStore.getState().saveSnapshot();
    useComposeStore.getState().setSubtitleSegments(split);
  }, [subtitleConstraints, subtitleSegments]);

  return (
    <div className="flex h-full flex-col">
      {/* Row 1: Full-width Preview (compact) */}
      <div className="flex-shrink-0 flex-grow-0 overflow-hidden" style={{ height: '30%', minHeight: 160 }}>
        <ComposePreview
          projectId={projectId}
          videoSrc={videoSrc}
          audioSrc={audioSrc}
          subtitleStyle={storeSubtitleStyle}
        />
      </div>

      {/* Row 2: Subtitle Editor (2/3) + Format/Props Panel (1/3) */}
      <div className="flex min-h-0 border-t border-border" style={{ flex: '1 1 0%' }}>
        {/* Subtitle text editor with auto-scroll */}
        <div className="w-2/3 min-w-0 border-r border-border overflow-hidden">
          <ComposeSubtitleEditor />
        </div>

        {/* Right Panel: context-sensitive (format / clip props) */}
        <div className="w-1/3 flex-shrink-0 bg-card overflow-auto flex flex-col">
          {/* Overlay-template library bar — save/apply text overlay templates
              (shared global library with reels). Always visible. */}
          <div className="flex items-center justify-between gap-1 px-2 py-1 border-b border-border bg-muted/10">
            <span className="text-[10px] text-muted-foreground">Overlays texto:</span>
            <ComposeOverlayTemplatesBar />
          </div>

          {(panelMode === 'clip-properties' || panelMode === 'text-clip' || panelMode === 'image-clip') && firstSelectedClip && (
            <div className="flex-1 overflow-auto">
              <ClipProperties />
            </div>
          )}

          {panelMode === 'subtitles' && (
            <div className="flex-1 overflow-auto">
              {/* Per-selection style bar — color/size/bold for selected subtitles */}
              {selectedSubtitleIds.length > 0 && (
                <div className="p-3 border-b border-border">
                  <SubtitleSelectionStyleBar
                    count={selectedSubtitleIds.length}
                    onApply={(update) => styleSelectedSubtitles(update)}
                  />
                </div>
              )}
              {/* Subtitle position quick controls */}
              <div className="p-3 border-b border-border">
                <h3 className="text-xs font-medium mb-2">Subtitle Position</h3>
                <div className="flex gap-1 mb-2">
                  {(['top', 'center', 'bottom'] as const).map((pos) => (
                    <Button
                      key={pos}
                      variant={storeSubtitleStyle.position === pos ? 'default' : 'outline'}
                      size="sm"
                      className="flex-1 text-[10px] h-7"
                      onClick={() => setSubtitleStyle({ ...storeSubtitleStyle, position: pos })}
                    >
                      {pos}
                    </Button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-muted-foreground whitespace-nowrap">Margin</label>
                  <input
                    type="range"
                    min={0}
                    max={400}
                    step={5}
                    value={storeSubtitleStyle.marginBottom}
                    onChange={(e) => setSubtitleStyle({ ...storeSubtitleStyle, marginBottom: parseInt(e.target.value) })}
                    className="flex-1 h-1.5 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
                  />
                  <span className="text-[10px] text-muted-foreground w-8 text-right">{storeSubtitleStyle.marginBottom}px</span>
                </div>
              </div>

              {/* Subtitle Style Editor */}
              <div className="p-3 border-b border-border">
                <SubtitleStyleEditor
                  style={storeSubtitleStyle}
                  activePreset={subtitleStylePreset}
                  onChange={(style) => setSubtitleStyle(style)}
                  onPresetChange={(presetId, style) => setSubtitlePreset(presetId, style)}
                  customPresets={customPresets}
                  onSaveCustomPreset={savePreset}
                  onDeleteCustomPreset={deletePreset}
                />
              </div>

              {/* Constraints */}
              <div className="p-3">
                <h3 className="text-xs font-medium mb-2">Constraints</h3>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-[10px] text-muted-foreground mb-1">Max chars</label>
                    <Input
                      type="number" min={15} max={100}
                      value={subtitleConstraints.maxCharsPerBlock}
                      onChange={(e) => setSubtitleConstraints({
                        ...subtitleConstraints,
                        maxCharsPerBlock: parseInt(e.target.value) || 80,
                      })}
                      className="h-7 text-xs"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-[10px] text-muted-foreground mb-1">Max ms</label>
                    <Input
                      type="number" min={1000} max={15000} step={500}
                      value={subtitleConstraints.maxDurationMs}
                      onChange={(e) => setSubtitleConstraints({
                        ...subtitleConstraints,
                        maxDurationMs: parseInt(e.target.value) || 7000,
                      })}
                      className="h-7 text-xs"
                    />
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <Button
                    size="sm" variant="outline" className="text-xs"
                    onClick={regenerateSubtitles}
                  >
                    <RefreshCw className="mr-1 h-3 w-3" /> Regenerate
                  </Button>
                  {violations > 0 && (
                    <Button size="sm" variant="outline" className="text-xs" onClick={handleAutoSplit}>
                      <Scissors className="mr-1 h-3 w-3" /> Auto-split ({violations})
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Row 3: Timeline */}
      <div className="flex-shrink-0">
        <MultiTrackTimeline onSave={handleSave} saving={saving} />
      </div>
    </div>
  );
}
