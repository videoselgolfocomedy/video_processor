'use client';

import { useCallback, useRef, useEffect, useState } from 'react';
import { useReelStore } from '@/stores/reel-store';
import { getReelVideoElement } from './reel-video-ref';
import { getActiveReelTransform, applyCanvasTransform, drawActiveOverlayVideos, hasActiveOverlayVideo } from '@/lib/reel-transform';
import { ReelSubtitleBox } from './reel-subtitle-box';
import { SubtitleStyleEditor } from '@/components/subtitles/subtitle-style-editor';
import { useCustomPresets } from '@/hooks/use-custom-presets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Scissors } from 'lucide-react';
import { splitLongSegments } from '@/lib/subtitle-utils';
import type { SubtitleStyle } from '@/types/project';

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

      // Read fresh crop from store in case it changed
      const currentReel = useReelStore.getState().reels.find((r) => r.id === reelId);
      const crop = currentReel?.cropRegion ?? reel.cropRegion;

      const cropPixH = srcH * crop.scale;
      const cropPixW = cropPixH * (9 / 16);
      const sx = crop.centerX * srcW - cropPixW / 2;
      const sy = crop.centerY * srcH - cropPixH / 2;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Black backdrop so a rotated/zoomed-out frame shows black in the gaps
      // (matches the export, which overlays the clip on a black canvas).
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Apply per-clip motion transform (zoom/position/rotation) inherited from
      // compose, so the 9:16 preview matches the export.
      const activeT = getActiveReelTransform(reelId);
      const applied = applyCanvasTransform(ctx, canvas.width, canvas.height, activeT);
      ctx.drawImage(
        video,
        Math.max(0, sx), Math.max(0, sy), cropPixW, cropPixH,
        0, 0, canvas.width, canvas.height
      );
      if (applied) ctx.setTransform(1, 0, 0, 1, 0, 0);

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
    const { maxCharsPerBlock, maxDurationMs } = reel.subtitleConstraints;
    const split = splitLongSegments(reel.subtitleSegments, maxCharsPerBlock, maxDurationMs);
    updateReel(reelId, { subtitleSegments: split });
  }, [reel, reelId, updateReel]);

  if (!reel) return null;

  const constraints = reel.subtitleConstraints;
  const style = reel.subtitleStyle;
  const violations = reel.subtitleSegments.filter(
    (s) => s.text.length > constraints.maxCharsPerBlock || (s.endMs - s.startMs) > constraints.maxDurationMs
  ).length;

  return (
    <div className="flex flex-col h-full">
      {/* Canvas preview - sticky */}
      <div className="sticky top-0 z-10 bg-background p-3 border-b border-border">
        <CropPreviewCanvas reelId={reelId} />
      </div>

      {/* Controls - scrollable */}
      <div className="overflow-y-auto p-3 space-y-4">
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
          <div className="flex gap-2 mt-2">
            <Button
              size="sm" variant="outline" className="text-xs"
              onClick={() => regenerateReelSubtitles(reelId)}
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
    </div>
  );
}
