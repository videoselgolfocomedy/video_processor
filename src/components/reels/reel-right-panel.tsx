'use client';

import { useCallback, useRef, useEffect, useState } from 'react';
import { useReelStore } from '@/stores/reel-store';
import { getReelVideoElement } from './reel-video-ref';
import { getActiveReelTransform, drawTransformedCrop, drawActiveOverlayVideos, hasActiveOverlayVideo } from '@/lib/reel-transform';
import { cropAtTime } from '@/lib/crop-keyframes';
import { ReelSubtitleBox } from './reel-subtitle-box';
import { SubtitleStyleEditor } from '@/components/subtitles/subtitle-style-editor';
import { useCustomPresets } from '@/hooks/use-custom-presets';
import { ReelMixPanels } from './reel-mix-panels';
import { CropKeyframesPanel } from './crop-keyframes-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Scissors, RemoveFormatting } from 'lucide-react';
import { splitSegmentsWithConstraints, segmentViolates, REEL_DEFAULT_MAX_WORDS } from '@/lib/subtitle-utils';
import type { SubtitleStyle, SubtitleSplitMode } from '@/types/project';

interface ReelRightPanelProps {
  reelId: string;
  projectId: string;
}

// Canvas-based 9:16 preview — captures frames from the shared video element
function CropPreviewCanvas({ reelId }: { reelId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const [canvasDims, setCanvasDims] = useState({ width: 0, height: 0 });

  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const sourceResolution = useReelStore((s) => s.sourceResolution);
  const isPlaying = useReelStore((s) => s.isPlaying);

  // Measure actual rendered canvas dimensions
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasDims({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !reel) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const srcW = sourceResolution?.width ?? 1920;
    const srcH = sourceResolution?.height ?? 1080;
    let pendingDraw = false;

    const draw = () => {
      pendingDraw = false;
      const video = getReelVideoElement();
      if (!video || video.readyState < 2) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      // Read fresh crop from store — interpolated at the playhead when crop
      // keyframes exist (animated encuadre).
      const rs = useReelStore.getState();
      const currentReel = rs.reels.find((r) => r.id === reelId);
      const crop = currentReel
        ? cropAtTime(currentReel.cropRegion, currentReel.cropKeyframes, rs.currentTimeMs)
        : reel.cropRegion;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Backdrop so a rotated/zoomed-out frame shows the chosen canvas color
      // in the gaps (matches the export and the timeline-phase preview).
      ctx.fillStyle = currentReel?.composition.backgroundColor ?? '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // WYSIWYG: transform the source frame FIRST, then sample the crop window
      // from the transformed image — same order as the setup-view selector
      // (drawn over the CSS-transformed video) and the FFmpeg export.
      const activeT = getActiveReelTransform(reelId);
      drawTransformedCrop(ctx, video, canvas.width, canvas.height, srcW, srcH, crop, activeT);

      // Draw PiP (secondary-track) video overlays on top, in output space.
      drawActiveOverlayVideos(ctx, canvas.width, canvas.height, reelId);

      // Subtitle text is now rendered by ReelSubtitleBox overlay, no need to draw on canvas

      // Keep redrawing while playing OR while a PiP overlay is on screen (so its
      // frames refresh even when the main timeline is paused).
      if (isPlaying || hasActiveOverlayVideo(reelId)) {
        animRef.current = requestAnimationFrame(draw);
      }
    };

    draw();

    // Redraw on store changes when paused (throttled via rAF)
    const unsub = useReelStore.subscribe(() => {
      if (!isPlaying && !pendingDraw) {
        pendingDraw = true;
        cancelAnimationFrame(animRef.current);
        animRef.current = requestAnimationFrame(draw);
      }
    });

    return () => {
      cancelAnimationFrame(animRef.current);
      unsub();
    };
  }, [reel, sourceResolution, isPlaying, reelId]);

  return (
    <div ref={wrapperRef} className="relative w-full" style={{ aspectRatio: '9/16' }}>
      <canvas
        ref={canvasRef}
        width={270}
        height={480}
        className="w-full h-full rounded bg-black"
        style={{ aspectRatio: '9/16' }}
      />
      {canvasDims.width > 0 && (
        <ReelSubtitleBox
          reelId={reelId}
          canvasWidth={canvasDims.width}
          canvasHeight={canvasDims.height}
        />
      )}
    </div>
  );
}

export function ReelRightPanel({ reelId, projectId }: ReelRightPanelProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const setReelSubtitleStyle = useReelStore((s) => s.setReelSubtitleStyle);
  const setReelSubtitlePreset = useReelStore((s) => s.setReelSubtitlePreset);
  const { customPresets, savePreset, deletePreset } = useCustomPresets(projectId);
  const setReelSubtitleConstraints = useReelStore((s) => s.setReelSubtitleConstraints);
  const regenerateReelSubtitles = useReelStore((s) => s.regenerateReelSubtitles);
  const stripReelSubtitlePunctuation = useReelStore((s) => s.stripReelSubtitlePunctuation);
  const updateReel = useReelStore((s) => s.updateReel);

  const handleStyleChange = useCallback(
    (style: SubtitleStyle) => setReelSubtitleStyle(reelId, style),
    [reelId, setReelSubtitleStyle]
  );

  const handlePresetChange = useCallback(
    (presetId: string, style: SubtitleStyle) => setReelSubtitlePreset(reelId, presetId, style),
    [reelId, setReelSubtitlePreset]
  );

  const handleAutoSplit = useCallback(() => {
    if (!reel) return;
    const split = splitSegmentsWithConstraints(reel.subtitleSegments, reel.subtitleConstraints);
    updateReel(reelId, { subtitleSegments: split });
  }, [reel, reelId, updateReel]);

  if (!reel) return null;

  const constraints = reel.subtitleConstraints;
  const style = reel.subtitleStyle;
  const violations = reel.subtitleSegments.filter((s) => segmentViolates(s, constraints)).length;

  return (
    <div className="flex flex-col h-full">
      {/* Canvas preview - sticky */}
      <div className="sticky top-0 z-10 bg-background p-3 border-b border-border">
        <CropPreviewCanvas reelId={reelId} />
      </div>

      {/* Controls - scrollable */}
      <div className="overflow-y-auto p-3 space-y-4">
        {/* Animated crop (subject tracking) — shared with the timeline phase. */}
        <CropKeyframesPanel reelId={reelId} />

        {/* Mesa ducking + ambient boost — shared with the timeline phase. */}
        <ReelMixPanels reelId={reelId} />

        {/* Quick subtitle position */}
        <div>
          <h3 className="text-xs font-medium mb-2">Subtitle Position</h3>
          <div className="flex gap-1 mb-2">
            {(['top', 'center', 'bottom'] as const).map((pos) => (
              <Button
                key={pos}
                variant={style.position === pos ? 'default' : 'outline'}
                size="sm"
                className="flex-1 text-[10px] h-7"
                onClick={() => handleStyleChange({ ...style, position: pos })}
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
              value={style.marginBottom}
              onChange={(e) => handleStyleChange({ ...style, marginBottom: parseInt(e.target.value) })}
              className="flex-1 h-1.5 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
            <span className="text-[10px] text-muted-foreground w-8 text-right">{style.marginBottom}px</span>
          </div>
        </div>

        {/* Subtitle Style */}
        <SubtitleStyleEditor
          style={reel.subtitleStyle}
          activePreset={reel.subtitleStylePreset}
          onChange={handleStyleChange}
          onPresetChange={handlePresetChange}
          customPresets={customPresets}
          onSaveCustomPreset={savePreset}
          onDeleteCustomPreset={deletePreset}
        />

        {/* Constraints */}
        <div>
          <h3 className="text-xs font-medium mb-2">Constraints</h3>
          {/* Modo de troceo: clásico por caracteres, o picado por frases (≤ N palabras) */}
          <div className="mb-2">
            <label className="block text-[10px] text-muted-foreground mb-0.5">Troceo</label>
            <select
              className="h-7 w-full rounded border border-border bg-background px-1 text-xs outline-none"
              value={constraints.splitMode ?? 'clasico'}
              title="Clásico: bloques por caracteres. Picado: ≤ N palabras, alineado con las frases y sin separar artículo/posesivo/preposición de lo que sigue. Remate: además, la última unidad de cada frase va sola (el golpe)."
              onChange={(e) => setReelSubtitleConstraints(reelId, {
                ...constraints,
                splitMode: e.target.value as SubtitleSplitMode,
                maxWordsPerBlock: constraints.maxWordsPerBlock ?? REEL_DEFAULT_MAX_WORDS,
              })}
            >
              <option value="clasico">Clásico (por caracteres)</option>
              <option value="picado">Picado (≤ N palabras, por frases)</option>
              <option value="remate">Picado con remate (comedia)</option>
            </select>
          </div>
          {(constraints.splitMode ?? 'clasico') !== 'clasico' && (
            <div className="mb-2">
              <label className="block text-[10px] text-muted-foreground mb-0.5">Máx. palabras por bloque</label>
              <Input
                type="number" min={1} max={8}
                value={constraints.maxWordsPerBlock ?? REEL_DEFAULT_MAX_WORDS}
                onChange={(e) => setReelSubtitleConstraints(reelId, {
                  ...constraints,
                  maxWordsPerBlock: Math.max(1, Math.min(8, parseInt(e.target.value) || REEL_DEFAULT_MAX_WORDS)),
                })}
                className="h-7 text-xs"
              />
            </div>
          )}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-[10px] text-muted-foreground mb-1">Max chars</label>
              <Input
                type="number" min={15} max={100}
                value={constraints.maxCharsPerBlock}
                onChange={(e) => setReelSubtitleConstraints(reelId, {
                  ...constraints,
                  maxCharsPerBlock: parseInt(e.target.value) || 38,
                })}
                className="h-7 text-xs"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[10px] text-muted-foreground mb-1">Max ms</label>
              <Input
                type="number" min={1000} max={15000} step={500}
                value={constraints.maxDurationMs}
                onChange={(e) => setReelSubtitleConstraints(reelId, {
                  ...constraints,
                  maxDurationMs: parseInt(e.target.value) || 5000,
                })}
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <Button
              size="sm" variant="outline" className="text-xs"
              onClick={() => regenerateReelSubtitles(reelId)}
            >
              <RefreshCw className="mr-1 h-3 w-3" /> Regenerate
            </Button>
            <Button
              size="sm" variant="outline" className="text-xs"
              onClick={() => stripReelSubtitlePunctuation(reelId)}
              title="Eliminar la puntuación final (.,;:) de todos los bloques"
            >
              <RemoveFormatting className="mr-1 h-3 w-3" /> Strip .,
            </Button>
            {violations > 0 && (
              <Button size="sm" variant="outline" className="text-xs" onClick={handleAutoSplit}>
                <Scissors className="mr-1 h-3 w-3" /> Auto-split ({violations})
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
