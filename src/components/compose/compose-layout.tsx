'use client';

import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { useComposeStore } from '@/stores/compose-store';
import { useProjectStore } from '@/stores/project-store';
import { BoardDuckingPanel } from '@/components/audio/board-ducking-panel';
import { PartsMixPanels } from '@/components/parts/parts-mix-panels';
import { remixWithDucking, parseMixParams } from '@/lib/remix-ducking';
import { useToast } from '@/hooks/use-toast';
import { ComposePreview } from './compose-preview';
import { ComposeSubtitleEditor } from './compose-subtitle-editor';
import { ClipProperties } from './clip-properties';
import { ComposeOverlayTemplatesBar } from './compose-overlay-template-controls';
import { SubtitleSelectionStyleBar } from '@/components/subtitles/subtitle-selection-style-bar';
import { MultiTrackTimeline } from './multi-track-timeline';
import { EditorSplit } from '@/components/shared/editor-split';
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
  const { toast } = useToast();
  const currentProject = useProjectStore((s) => s.currentProject);
  const fetchProject = useProjectStore((s) => s.fetchProject);
  // Refs to the ducking/boost <details> so they can auto-collapse after a
  // re-mix — leaving them expanded squeezed the properties panel below.
  const duckDetailsRef = useRef<HTMLDetailsElement>(null);
  const boostDetailsRef = useRef<HTMLDetailsElement>(null);

  // Board (mesa) ducking from Compose — single-pair only (selected mix wav exists).
  const boardSource = currentProject?.sources.find((s) => s.role === 'board');
  const selectedAudioName = currentProject?.sync.selectedAudioPath;
  const duckReady = !!(boardSource && selectedAudioName && currentProject);
  // Board-stem time = mix-wav time + board atrim (max(0, alignmentOffset+manualAdjust)).
  // mix-wav time = a1.sourceInMs + (playhead - a1.timelineStartMs) (a1.sourceInMs bakes muxedAudioOffset).
  const getEditorBoardMs = useCallback((): number | null => {
    if (!currentProject) return null;
    const manualAdjust = selectedAudioName ? (parseMixParams(selectedAudioName)?.manualAdjustMs ?? 0) : 0;
    const off = Math.max(0, (currentProject.audio.alignmentOffsetMs ?? 0) + manualAdjust);
    const st = useComposeStore.getState();
    const T = st.currentTimeMs;
    const a1 = st.clips
      .filter((c) => c.trackId === 'a1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const cur = a1.find((c) => T >= c.timelineStartMs && T < c.timelineEndMs) ?? a1[0];
    if (!cur) return null;
    const mixTime = cur.sourceInMs + (T - cur.timelineStartMs);
    return Math.max(0, mixTime + off);
  }, [currentProject, selectedAudioName]);

  // Ambient BOOST (raise the audience/laughs in marked ranges). The ambient
  // wav drives the mix with no trim, so ambient time == mix time — the mapping
  // is just the a1 clip mapping (no board-trim offset).
  const ambientFileName = (() => {
    if (!currentProject) return undefined;
    const src = (selectedAudioName ? parseMixParams(selectedAudioName)?.ambientSource : undefined) ?? 'subtracted';
    let p: string | undefined;
    if (src === 'raw') {
      const cam = currentProject.sources.find((s) => s.role === 'camera' && s.type === 'video');
      p = currentProject.audio.extractedTracks.find((t) => t.sourceFileId === cam?.id)?.path;
    } else if (src === 'cleaned') {
      p = currentProject.audio.cameraAmbientPath;
    } else {
      p = currentProject.audio.ambientPath;
    }
    return p?.split('/').pop();
  })();
  const boostReady = !!(ambientFileName && selectedAudioName && currentProject);
  const getEditorAmbientMs = useCallback((): number | null => {
    const st = useComposeStore.getState();
    const T = st.currentTimeMs;
    const a1 = st.clips
      .filter((c) => c.trackId === 'a1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const cur = a1.find((c) => T >= c.timelineStartMs && T < c.timelineEndMs) ?? a1[0];
    if (!cur) return null;
    return Math.max(0, cur.sourceInMs + (T - cur.timelineStartMs));
  }, []);

  // PARTS projects: the concat muxed's audio is baked per part (no selected
  // mix wav), so the duck/boost tools work per part instead. The a1 mapping
  // above is also the CONCAT time (parts concat sets muxedAudioOffsetMs=0).
  const isPartsProject = (currentProject?.parts?.length ?? 0) > 0 &&
    !selectedAudioName && !!currentProject?.sync.muxedVideoPath;

  const subtitleSegments = useComposeStore((s) => s.subtitleSegments);
  const markClean = useComposeStore((s) => s.markClean);
  const selectedClipIds = useComposeStore((s) => s.selectedClipIds);
  const selectedSubtitleIds = useComposeStore((s) => s.selectedSubtitleIds);
  // "Mesa y ambiente como pistas separadas" — binding for the parts mix panel.
  const composeTracks = useComposeStore((s) => s.tracks);
  const applyStemTracks = useComposeStore((s) => s.applyStemTracks);
  const removeStemTracks = useComposeStore((s) => s.removeStemTracks);
  const stemsActive = composeTracks.some((t) => t.id === 'a_mesa' || t.id === 'a_amb');
  const styleSelectedSubtitles = useComposeStore((s) => s.styleSelectedSubtitles);
  const clips = useComposeStore((s) => s.clips);
  const storeSubtitleStyle = useComposeStore((s) => s.subtitleStyle);
  const subtitleStylePreset = useComposeStore((s) => s.subtitleStylePreset);
  const subtitleConstraints = useComposeStore((s) => s.subtitleConstraints);
  const setSubtitleStyle = useComposeStore((s) => s.setSubtitleStyle);
  const setSubtitlePreset = useComposeStore((s) => s.setSubtitlePreset);
  const setSubtitleConstraints = useComposeStore((s) => s.setSubtitleConstraints);
  const regenerateSubtitles = useComposeStore((s) => s.regenerateSubtitles);

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

  // Reads the store AT CALL TIME (not the values captured by the last render):
  // the version button saves right after adding the version, and the page
  // saves on its way out — both run before React has re-rendered.
  const handleSave = useCallback(async () => {
    const st = useComposeStore.getState();
    const body = JSON.stringify({
      ...st.getCompositionState(),
      subtitleStyle: st.subtitleStyle,
      subtitleStylePreset: st.subtitleStylePreset,
      subtitleConstraints: st.subtitleConstraints,
      versions: st.versions,
    });
    const segments = st.subtitleSegments;
    setSaving(true);
    try {
      const put = await fetch(`/api/projects/${projectId}/compose`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!put.ok) throw new Error(`compose ${put.status}`);

      const patch = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcription: { segments },
        }),
      });
      if (!patch.ok) throw new Error(`transcription ${patch.status}`);

      markClean();
    } catch (err) {
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }, [projectId, markClean]);

  // Leaving Compose with unsaved work (menu click = client-side navigation, no
  // "unsaved changes" prompt) used to DROP it silently — cuts, subtitles and
  // any version just bookmarked. Save on the way out, then refresh the shared
  // project so the next page does not start from the copy fetched before.
  useEffect(() => {
    return () => {
      if (!useComposeStore.getState().dirty) return;
      void handleSave().then(() => fetchProject(projectId));
    };
  }, [handleSave, fetchProject, projectId]);

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

      // Layout-/modifier-proof letter (see the same note in reel-layout):
      // Shift uppercases e.key and macOS Option mangles it (Option+V = '√'),
      // which silently killed Cmd+Option+V (ripple insert) on a Mac.
      const letter = /^[a-zA-Z]$/.test(e.key)
        ? e.key.toLowerCase()
        : (e.code?.startsWith('Key') ? e.code.slice(3).toLowerCase() : '');

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
      if ((e.ctrlKey || e.metaKey) && letter === 'z') {
        e.preventDefault();
        if (e.shiftKey) { store.redo(); } else { store.undo(); }
        return;
      }

      // Ctrl+Y: redo
      if ((e.ctrlKey || e.metaKey) && letter === 'y') {
        e.preventDefault();
        store.redo();
        return;
      }

      // Ctrl+S: save
      if ((e.ctrlKey || e.metaKey) && letter === 's') {
        e.preventDefault();
        handleSave();
        return;
      }

      // Ctrl/Cmd+C: copy selected clips
      if ((e.ctrlKey || e.metaKey) && letter === 'c') {
        if (store.selectedClipIds.length > 0) {
          e.preventDefault();
          store.copySelectedClips();
        }
        return;
      }

      // Ctrl/Cmd+Alt+V: INSERT paste — shifts everything after the playhead
      // right and brings the copied span's subtitles along (ripple insert).
      // (Alt, not Shift: in reels Ctrl+Shift+V already means "paste at end".)
      if ((e.ctrlKey || e.metaKey) && e.altKey && letter === 'v') {
        if (store.canPasteClips()) {
          e.preventDefault();
          store.rippleInsertAtPlayhead();
        }
        return;
      }

      // Ctrl/Cmd+V: paste clips at playhead
      if ((e.ctrlKey || e.metaKey) && letter === 'v') {
        if (store.canPasteClips()) {
          e.preventDefault();
          store.pasteClips();
        }
        return;
      }

      // S: split selected clip, Shift+S: split all tracks
      if (letter === 's' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        store.splitClipAtPlayhead();
        return;
      }
      if (letter === 's' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        store.splitAllAtPlayhead();
        return;
      }

      // Q: trim in to playhead
      if (letter === 'q' && !e.ctrlKey && !e.metaKey) {
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
      if (letter === 'w' && !e.ctrlKey && !e.metaKey) {
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
      if (letter === 'g' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        store.collapseGapAtPlayhead();
        return;
      }

      // Shift+G: close gap for selected
      if (letter === 'g' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
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

  // Screen split in two halves (draggable): TOP = subtitles | preview |
  // properties, BOTTOM = the whole timeline. The old stack (preview on top,
  // then subtitles + panel, then a timeline squeezed to its natural height)
  // left the tracks unusable once mesa/ambiente became separate tracks.
  const topRow = (
    <div className="flex h-full min-h-0">
      {/* Left: subtitle text editor with auto-scroll */}
      <div className="w-[30%] min-w-[240px] flex-shrink-0 border-r border-border overflow-hidden">
        <ComposeSubtitleEditor />
      </div>

      {/* Middle: preview, fitted by height */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <ComposePreview
          projectId={projectId}
          videoSrc={videoSrc}
          audioSrc={audioSrc}
          subtitleStyle={storeSubtitleStyle}
        />
      </div>

      {/* Right: context-sensitive properties (clip / subtitles), then the
          global accordions. Single scroll column (NOT a flex-1 squeeze) so an
          expanded <details> can't collapse the panel below it to 0px. */}
      <div className="w-[30%] min-w-[300px] flex-shrink-0 border-l border-border bg-card overflow-y-auto">
        {/* Overlay-template library bar — save/apply text overlay templates
            (shared global library with reels). Always visible. */}
        <div className="flex items-center justify-between gap-1 px-2 py-1 border-b border-border bg-muted/10">
          <span className="text-[10px] text-muted-foreground">Overlays texto:</span>
          <ComposeOverlayTemplatesBar />
        </div>

        {(panelMode === 'clip-properties' || panelMode === 'text-clip' || panelMode === 'image-clip') && firstSelectedClip && (
          <div>
            <ClipProperties />
          </div>
        )}

        {panelMode === 'subtitles' && (
          <div>
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

        {/* Global accordions (mesa/ambiente tools, stems) — below whatever is selected. */}
        {/* Board (mesa) ducking — mark the "je-je"/"eehh" while watching the
            video; "Ir al playhead del vídeo" jumps the mesa waveform to the
            same moment. Applying re-mixes so only the mesa drops (ambient stays). */}
        {duckReady && (
          <details ref={duckDetailsRef} className="border-b border-border">
            <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              Atenuar mesa (je-je / ehh) en la mezcla
            </summary>
            <div className="p-2">
              <BoardDuckingPanel
                projectId={projectId}
                boardUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(boardSource!.storedName)}`}
                fillersUrl={`/api/projects/${projectId}/audio/file?name=board_fillers.json`}
                envelopeUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(boardSource!.storedName)}`}
                detectUrl={`/api/projects/${projectId}/audio/detect-fillers`}
                initialRegions={currentProject!.audio.boardDuckRegions ?? []}
                boardTrimMs={Math.max(0, currentProject!.audio.alignmentOffsetMs ?? 0)}
                applyLabel="Aplicar (re-mezclar mesa)"
                applyHint="Baja solo la mesa en las zonas activas; el ambiente queda intacto."
                getEditorBoardMs={getEditorBoardMs}
                onSave={async (regions) => {
                  try {
                    const res = await fetch(`/api/projects/${projectId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ audio: { ...currentProject!.audio, boardDuckRegions: regions } }),
                    });
                    if (!res.ok) throw new Error(`Error ${res.status}`);
                    await fetchProject(projectId);
                    return true;
                  } catch (err) {
                    toast({ title: 'No se pudo guardar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
                    return false;
                  }
                }}
                onApplied={async () => {
                  toast({ title: 'Re-mezclando mesa…', description: 'Atenuando las zonas y volviendo a mezclar.' });
                  const proj = useProjectStore.getState().currentProject;
                  if (!proj) return;
                  const r = await remixWithDucking(projectId, proj);
                  if (r.ok) {
                    await fetchProject(projectId);
                    // Collapse the panel so the properties/subtitle editor
                    // below it regains its full height (it was squeezed while
                    // this section was expanded).
                    if (duckDetailsRef.current) duckDetailsRef.current.open = false;
                    toast({ title: 'Mezcla actualizada', description: 'La mesa quedó atenuada; el ambiente intacto.' });
                  } else {
                    toast({ title: 'No se pudo re-mezclar', description: r.error, variant: 'destructive' });
                  }
                }}
              />
            </div>
          </details>
        )}

        {/* Ambient BOOST — mark ranges while watching the video where the
            audience/laughs should swell. Only the AMBIENT branch of the mix
            is raised (with fade-in/out), so the mesa voice stays clean (no
            echo) and there's no canned-laughter jump. */}
        {boostReady && (
          <details ref={boostDetailsRef} className="border-b border-border">
            <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              Subir ambiente (risas) en la mezcla
            </summary>
            <div className="p-2">
              <BoardDuckingPanel
                mode="boost"
                projectId={projectId}
                boardUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(ambientFileName!)}`}
                fillersUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(ambientFileName!)}`}
                detectUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(ambientFileName!)}`}
                initialRegions={currentProject!.audio.ambientBoostRegions ?? []}
                boardTrimMs={0}
                applyLabel="Aplicar (re-mezclar ambiente)"
                applyHint="Sube solo el ambiente (público) en las zonas, con fade — la voz de mesa queda intacta."
                getEditorBoardMs={getEditorAmbientMs}
                onSave={async (regions) => {
                  try {
                    const res = await fetch(`/api/projects/${projectId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ audio: { ...currentProject!.audio, ambientBoostRegions: regions } }),
                    });
                    if (!res.ok) throw new Error(`Error ${res.status}`);
                    await fetchProject(projectId);
                    return true;
                  } catch (err) {
                    toast({ title: 'No se pudo guardar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
                    return false;
                  }
                }}
                onApplied={async () => {
                  toast({ title: 'Re-mezclando ambiente…', description: 'Subiendo el público en las zonas y volviendo a mezclar.' });
                  const proj = useProjectStore.getState().currentProject;
                  if (!proj) return;
                  const r = await remixWithDucking(projectId, proj);
                  if (r.ok) {
                    await fetchProject(projectId);
                    if (boostDetailsRef.current) boostDetailsRef.current.open = false;
                    toast({ title: 'Mezcla actualizada', description: 'El público sube en tus zonas; la voz sigue limpia.' });
                  } else {
                    toast({ title: 'No se pudo re-mezclar', description: r.error, variant: 'destructive' });
                  }
                }}
              />
            </div>
          </details>
        )}

        {/* PARTS projects: duck/boost per part (re-mix + re-concat). */}
        {isPartsProject && (
          <div className="space-y-2 border-b border-border p-2">
            <PartsMixPanels
              getEditorConcatMs={getEditorAmbientMs}
              stems={{ active: stemsActive, apply: applyStemTracks, remove: removeStemTracks }}
            />
          </div>
        )}

      </div>
    </div>
  );

  return (
    <EditorSplit
      storageKey="compose-split-top-pct"
      top={topRow}
      bottom={<MultiTrackTimeline onSave={handleSave} saving={saving} />}
    />
  );
}
