'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useReelStore } from '@/stores/reel-store';
import { OverlayTemplatesBar, SaveOverlayAsTemplateButton, ApplyOverlayTemplateButton } from './overlay-template-controls';
import { ReelVideoPlayer } from './reel-video-player';
import { ClipGainPanel } from '@/components/shared/clip-gain-panel';
import { ReelSubtitleBox } from './reel-subtitle-box';
import { ReelTimeline } from './reel-timeline';
import { EditorSplit } from '@/components/shared/editor-split';
import { SubtitleStyleEditor } from '@/components/subtitles/subtitle-style-editor';
import { ReelMixPanels } from './reel-mix-panels';
import { CropKeyframesPanel } from './crop-keyframes-panel';
import { useCustomPresets } from '@/hooks/use-custom-presets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Scissors, Trash2, Bold, Frame, RemoveFormatting } from 'lucide-react';
import { splitSegmentsWithConstraints, segmentViolates, REEL_DEFAULT_MAX_WORDS } from '@/lib/subtitle-utils';
import { formatTimestamp } from '@/lib/utils';
import { getReelVideoElement } from './reel-video-ref';
import { getActiveReelTransform, drawTransformedCrop, drawActiveOverlayVideos, hasActiveOverlayVideo } from '@/lib/reel-transform';
import { cropAtTime } from '@/lib/crop-keyframes';
import { SubtitleSelectionStyleBar } from '@/components/subtitles/subtitle-selection-style-bar';
import { CanvasBackgroundPicker } from '@/components/shared/canvas-background-picker';
import { ExportAudioClipButton } from '@/components/audio/export-audio-clip-button';
import { copyMotionTransform, getMotionTransform, hasMotionTransform } from '@/lib/motion-clipboard';
import { FONT_FAMILIES } from '@/config/fonts';
import type { SubtitleStyle, SubtitleWord, CompositionClip, SubtitleSplitMode } from '@/types/project';

interface ReelTimelineViewProps {
  reelId: string;
  videoSrc?: string;
  audioSrc?: string;
  audioOffsetMs?: number;
}

/* ── Text overlay rendering on canvas ──────────────────────────────── */

/**
 * Maps the `textAlign` we store on each clip to the corresponding CSS value
 * for the preview and a self-anchored block (relative to the bounding box).
 * The box itself is always centred on overlayPosition (x, y), so the only
 * thing that changes here is how glyphs sit inside that fixed box.
 */
function cssTextAlign(align?: 'left' | 'center' | 'right'): 'left' | 'center' | 'right' {
  return align ?? 'center';
}

function TextOverlayPreview({ reelId, canvasWidth, canvasHeight }: {
  reelId: string;
  canvasWidth: number;
  canvasHeight: number;
}) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const selectedClipIds = useReelStore((s) => s.selectedClipIds);
  const updateClip = useReelStore((s) => s.updateClip);
  const selectClip = useReelStore((s) => s.selectClip);

  if (!reel || canvasWidth <= 0) return null;

  // Find text clips that are visible at current time
  const textClips = reel.composition.clips.filter(
    (c) => c.type === 'text' && currentTimeMs >= c.timelineStartMs && currentTimeMs <= c.timelineEndMs
  );

  if (textClips.length === 0) return null;

  const scale = canvasWidth / 1080;

  return (
    <>
      {textClips.map((clip) => {
        const ts = clip.textStyle ?? {
          fontSize: 48,
          fontFamily: 'Inter',
          fontWeight: 400,
          color: '#ffffff',
          backgroundColor: undefined,
        };
        const pos = clip.overlayPosition ?? { x: 0.5, y: 0.5, width: 0.8 };
        const align = cssTextAlign(ts.textAlign);
        const boxWidthPx = pos.width * canvasWidth;
        const isSelected = selectedClipIds.includes(clip.id);

        // Drag handlers — let the user reposition the box by clicking and
        // dragging in the preview. Cursor pixel deltas are converted to
        // fractional deltas using canvasWidth/Height, so updates are
        // resolution-independent.
        const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          selectClip(clip.id);
          const startClientX = e.clientX;
          const startClientY = e.clientY;
          const startPos = { x: pos.x, y: pos.y };
          const target = e.currentTarget;
          target.setPointerCapture(e.pointerId);

          const onMove = (ev: PointerEvent) => {
            const dxFrac = (ev.clientX - startClientX) / Math.max(1, canvasWidth);
            const dyFrac = (ev.clientY - startClientY) / Math.max(1, canvasHeight);
            const newX = Math.max(0, Math.min(1, startPos.x + dxFrac));
            const newY = Math.max(0, Math.min(1, startPos.y + dyFrac));
            updateClip(reelId, clip.id, {
              overlayPosition: { ...pos, x: newX, y: newY },
            });
          };
          const onUp = () => {
            target.removeEventListener('pointermove', onMove);
            target.removeEventListener('pointerup', onUp);
            target.removeEventListener('pointercancel', onUp);
            try { target.releasePointerCapture(e.pointerId); } catch { /* */ }
          };
          target.addEventListener('pointermove', onMove);
          target.addEventListener('pointerup', onUp);
          target.addEventListener('pointercancel', onUp);
        };

        return (
          // Outer box: fixed width = pos.width × canvas; centred on (x, y).
          // Drawing this as a separate element makes the bounding box explicit
          // and matches what the export will produce (libass treats the same
          // rectangle as its wrap frame). It's also the drag handle.
          <div
            key={clip.id}
            className="absolute"
            onPointerDown={handlePointerDown}
            style={{
              left: `${pos.x * 100}%`,
              top: `${pos.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: boxWidthPx,
              // Faint dashed border on every overlay so the user always sees
              // the box. The currently-selected overlay shows a stronger
              // border so it stands out — this matches the "cajita" the user
              // asked for so alignment is obvious at a glance.
              border: isSelected
                ? '1px dashed rgba(255,200,80,0.9)'
                : '1px dashed rgba(255,255,255,0.25)',
              zIndex: 15,
              cursor: 'move',
              touchAction: 'none', // prevent browser gesture handling on touch
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
          >
            {/* Tiny crosshair at the (x, y) anchor — only when selected.
                Reinforces that x,y refers to the BOX CENTRE, not a corner. */}
            {isSelected && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'rgba(255,200,80,0.95)',
                  transform: 'translate(-50%, -50%)',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                }}
              />
            )}
            {/* Debug label: shows the actual pos.y the preview is rendering
                with. If this doesn't match the value in the panel, the store
                has drifted from disk; if it matches but the visible position
                seems off, the canvas dims aren't what we think. */}
            <div
              style={{
                position: 'absolute',
                top: -14,
                left: 0,
                fontFamily: 'monospace',
                fontSize: 9,
                color: isSelected ? 'rgba(255,200,80,0.95)' : 'rgba(255,255,255,0.5)',
                background: 'rgba(0,0,0,0.6)',
                padding: '0 3px',
                borderRadius: 2,
                whiteSpace: 'nowrap',
              }}
            >
              y={pos.y.toFixed(2)} x={pos.x.toFixed(2)} w={pos.width.toFixed(2)}
            </div>
            {/* Text itself */}
            <div
              style={{
                width: '100%',
                fontFamily: `${ts.fontFamily}, sans-serif`,
                fontSize: ts.fontSize * scale,
                fontWeight: ts.fontWeight,
                color: ts.color,
                backgroundColor: ts.backgroundColor ?? undefined,
                padding: ts.backgroundColor ? `${2 * scale}px ${4 * scale}px` : undefined,
                borderRadius: ts.backgroundColor ? 2 : undefined,
                textAlign: align,
                whiteSpace: 'pre-wrap',
                // break-word lets the box clip when a single word is too long
                // for pos.width — matches libass's WrapStyle behaviour in the
                // export and avoids the silent overflow we had with
                // word-break:normal.
                wordBreak: 'normal',
                overflowWrap: 'break-word',
                lineHeight: ts.lineHeight ?? 1.2,
                textShadow: ts.shadowColor
                  ? `${(ts.shadowX ?? 0) * scale}px ${(ts.shadowY ?? 0) * scale}px ${(ts.shadowBlur ?? 0) * scale}px ${ts.shadowColor}`
                  : undefined,
              }}
            >
              {clip.textContent || ''}
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── Image/GIF overlay rendering on canvas ────────────────────────── */

function ImageOverlayPreview({ reelId }: { reelId: string }) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);

  if (!reel || !projectId) return null;

  const imageClips = reel.composition.clips.filter(
    (c) =>
      (c.type === 'image' || c.type === 'gif') &&
      currentTimeMs >= c.timelineStartMs &&
      currentTimeMs <= c.timelineEndMs
  );

  if (imageClips.length === 0) return null;

  return (
    <>
      {imageClips.map((clip) => {
        const pos = clip.overlayPosition ?? { x: 0.5, y: 0.5, width: 0.8 };
        return (
          <img
            key={clip.id}
            src={`/api/projects/${projectId}/reels/file?name=${encodeURIComponent(clip.fileName)}`}
            alt={clip.originalName}
            className="absolute pointer-events-none"
            style={{
              left: `${pos.x * 100}%`,
              top: `${pos.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              maxWidth: `${pos.width * 100}%`,
              maxHeight: '100%',
              objectFit: 'contain',
              opacity: clip.opacity ?? 1,
              zIndex: 14,
            }}
          />
        );
      })}
    </>
  );
}

/* ── Instagram safe-zone overlay ─────────────────────────────────────── */

/**
 * Reference dimensions for Instagram Reels safe zones (1080×1920 base).
 * Numbers from the official IG Creator hub guidelines (2024 update):
 *  - Top UI (header / username / follow): occupies ~250 px from the top.
 *  - Bottom UI (caption, audio strip, like/comment/share buttons, progress
 *    bar): occupies ~530 px from the bottom.
 *  - Profile-grid crop: 1080×1350 (4:5) centred → vertical visible band
 *    spans y = (1920−1350)/2 = 285 to y = 1635.
 *
 * Expressed as fractions of canvas height so they scale to any preview size.
 */
const IG_TOP_UI_FRAC = 250 / 1920;        // ≈ 0.130
const IG_BOTTOM_UI_FRAC = 530 / 1920;     // ≈ 0.276
const IG_GRID_CROP_TOP = 285 / 1920;      // ≈ 0.148
const IG_GRID_CROP_BOTTOM = 1635 / 1920;  // ≈ 0.852

function InstagramSafeZones({ width, height }: { width: number; height: number }) {
  if (width <= 0 || height <= 0) return null;
  const gridTop = IG_GRID_CROP_TOP * height;
  const gridBottom = IG_GRID_CROP_BOTTOM * height;
  const topUiBottom = IG_TOP_UI_FRAC * height;
  const bottomUiTop = (1 - IG_BOTTOM_UI_FRAC) * height;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ width, height }}
    >
      {/* Profile grid crop (4:5 centred) — dashed outline */}
      <div
        className="absolute border-2 border-dashed border-pink-400/80"
        style={{
          left: 0,
          top: gridTop,
          width,
          height: gridBottom - gridTop,
        }}
      />
      {/* Top UI shaded region */}
      <div
        className="absolute bg-red-500/15 border-b border-red-500/40"
        style={{ left: 0, top: 0, width, height: topUiBottom }}
      />
      {/* Bottom UI shaded region */}
      <div
        className="absolute bg-red-500/15 border-t border-red-500/40"
        style={{ left: 0, top: bottomUiTop, width, height: height - bottomUiTop }}
      />
      {/* Labels */}
      <div
        className="absolute text-[9px] font-mono text-red-300/90 px-1 py-0.5 bg-black/40 rounded"
        style={{ left: 4, top: 4 }}
      >
        IG header
      </div>
      <div
        className="absolute text-[9px] font-mono text-red-300/90 px-1 py-0.5 bg-black/40 rounded"
        style={{ left: 4, top: bottomUiTop + 2 }}
      >
        IG footer (caption/audio/buttons)
      </div>
      <div
        className="absolute text-[9px] font-mono text-pink-300/90 px-1 py-0.5 bg-black/40 rounded"
        style={{ left: 4, top: gridTop + 4 }}
      >
        Grid 4:5 (1080×1350)
      </div>
    </div>
  );
}

/* ── Small 9:16 canvas preview ──────────────────────────────────────── */

/**
 * Returns the load state of the display fonts the text overlays use.
 *
 * The families list is JOINED into a stable string for the effect's
 * dependency array — otherwise every render passes a NEW array reference
 * (`['Anton', ...]` literal in the call site), the effect re-fires, calls
 * setState, triggers another render, and so on. The infinite loop freezes
 * the page: the user reported "Edit Reel button does nothing" and that's
 * the React main thread being pegged at 100% re-rendering.
 */
function useFontLoadStatus(families: string[]): Record<string, 'loading' | 'loaded' | 'unavailable'> {
  const familiesKey = families.join('|');
  const [status, setStatus] = useState<Record<string, 'loading' | 'loaded' | 'unavailable'>>(() => {
    const init: Record<string, 'loading' | 'loaded' | 'unavailable'> = {};
    for (const f of families) init[f] = 'loading';
    return init;
  });

  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    const list = familiesKey.split('|');
    let cancelled = false;

    const update = async () => {
      const next: Record<string, 'loading' | 'loaded' | 'unavailable'> = {};
      for (const f of list) {
        const test = `16px "${f}"`;
        try {
          await document.fonts.load(test);
          next[f] = document.fonts.check(test) ? 'loaded' : 'unavailable';
        } catch {
          next[f] = 'unavailable';
        }
      }
      if (!cancelled) setStatus(next);
    };

    update();
    // No `loadingdone` listener: it can re-fire when our own `load()` calls
    // resolve, which would loop us back through update() → setState → render
    // → effect. One-shot check at mount is enough.
    return () => { cancelled = true; };
  }, [familiesKey]);

  return status;
}

function TimelineCanvasPreview({ reelId }: { reelId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const [canvasDims, setCanvasDims] = useState({ width: 0, height: 0 });
  const fontStatus = useFontLoadStatus(['Anton', 'Bebas Neue', 'Oswald']);
  // Persist the safe-zone toggle across reloads (per-user preference).
  const [showSafeZones, setShowSafeZones] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('reel-show-safe-zones') === '1';
  });
  const toggleSafeZones = useCallback(() => {
    setShowSafeZones((v) => {
      const next = !v;
      try { window.localStorage.setItem('reel-show-safe-zones', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const sourceResolution = useReelStore((s) => s.sourceResolution);
  const isPlaying = useReelStore((s) => s.isPlaying);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const availW = entry.contentRect.width;
        const availH = entry.contentRect.height;
        // Fit 9:16 within available space
        const fitByWidth = { width: availW, height: availW * (16 / 9) };
        const fitByHeight = { width: availH * (9 / 16), height: availH };
        // Use whichever fits
        if (fitByWidth.height <= availH) {
          setCanvasDims(fitByWidth);
        } else {
          setCanvasDims(fitByHeight);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !reel || canvasDims.width <= 0) return;
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

      const rs = useReelStore.getState();
      const currentReel = rs.reels.find((r) => r.id === reelId);
      const crop = currentReel
        ? cropAtTime(currentReel.cropRegion, currentReel.cropKeyframes, rs.currentTimeMs)
        : reel.cropRegion;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = currentReel?.composition.backgroundColor ?? '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // WYSIWYG: transform the source frame FIRST, then sample the crop window
      // (see drawTransformedCrop) — matches the crop selector and the export.
      const activeT = getActiveReelTransform(reelId);
      drawTransformedCrop(ctx, video, canvas.width, canvas.height, srcW, srcH, crop, activeT);

      // Draw PiP (secondary-track) video overlays on top, in output space.
      drawActiveOverlayVideos(ctx, canvas.width, canvas.height, reelId);

      if (isPlaying || hasActiveOverlayVideo(reelId)) {
        animRef.current = requestAnimationFrame(draw);
      }
    };

    draw();

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
  }, [reel, sourceResolution, isPlaying, reelId, canvasDims]);

  return (
    <div
      ref={wrapperRef}
      className="relative w-full h-full flex items-center justify-center"
    >
      <div className="relative flex-shrink-0" style={{ width: canvasDims.width, height: canvasDims.height }}>
        <canvas
          ref={canvasRef}
          width={Math.round(canvasDims.width * 2) || 180}
          height={Math.round(canvasDims.height * 2) || 320}
          className="w-full h-full rounded bg-black"
        />
        {canvasDims.width > 0 && (
          <>
            <ImageOverlayPreview reelId={reelId} />
            <TextOverlayPreview
              reelId={reelId}
              canvasWidth={canvasDims.width}
              canvasHeight={canvasDims.height}
            />
            <ReelSubtitleBox
              reelId={reelId}
              canvasWidth={canvasDims.width}
              canvasHeight={canvasDims.height}
            />
            {showSafeZones && (
              <InstagramSafeZones width={canvasDims.width} height={canvasDims.height} />
            )}
            {/* Safe-zones toggle — small floating button in the corner so it
                doesn't take space in the toolbar. Preview-only: never affects
                the FFmpeg export. */}
            <button
              type="button"
              onClick={toggleSafeZones}
              className={`absolute top-1 right-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                showSafeZones
                  ? 'bg-pink-500/30 text-pink-200 border border-pink-400/60'
                  : 'bg-black/40 text-muted-foreground hover:text-foreground border border-transparent'
              }`}
              title={showSafeZones ? 'Hide Instagram safe zones' : 'Show Instagram safe zones (grid 4:5 + UI overlays)'}
            >
              <Frame className="h-2.5 w-2.5" />
              IG
            </button>
            {/* Font-load indicator. If any expected display font isn't loaded
                in the browser, the preview is rendering with a fallback like
                sans-serif — which is much wider than Anton/Bebas Neue and
                produces a real visual mismatch versus the libass export.
                This badge makes that state visible at a glance: ✓ all loaded,
                ✗ at least one missing. */}
            {(() => {
              const states = Object.values(fontStatus);
              const anyMissing = states.some((s) => s === 'unavailable');
              const stillLoading = states.some((s) => s === 'loading');
              const color = anyMissing
                ? 'bg-red-500/40 text-red-100 border-red-400/70'
                : stillLoading
                  ? 'bg-yellow-500/30 text-yellow-100 border-yellow-400/60'
                  : 'bg-green-500/30 text-green-200 border-green-400/60';
              const labelChar = anyMissing ? '✗' : stillLoading ? '…' : '✓';
              const detail = Object.entries(fontStatus)
                .map(([f, s]) => `${f}: ${s}`).join(' · ');
              return (
                <div
                  className={`absolute top-1 left-1 px-1.5 py-0.5 rounded text-[9px] font-mono border ${color}`}
                  title={`Display fonts: ${detail}. If any is "unavailable" the preview is using a fallback and will look wider than the export.`}
                >
                  Anton {labelChar}
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Word style editor (per-word formatting) ──────────────────────── */

function WordStyleEditor({
  reelId,
  segId,
  seg,
}: {
  reelId: string;
  segId: string;
  seg: { text: string; startMs: number; endMs: number; words?: SubtitleWord[] };
}) {
  const [selectedWordIndices, setSelectedWordIndices] = useState<Set<number>>(new Set());
  const updateReelSubtitleSegment = useReelStore((s) => s.updateReelSubtitleSegment);

  // Derive display words from seg.text (source of truth)
  const textWords = seg.text.split(/\s+/).filter(Boolean);
  const sourceWords = seg.words ?? [];

  // Build merged words: use seg.text words for display, map style/timing from words[]
  const mergedWords: SubtitleWord[] = textWords.map((tw, i) => {
    if (i < sourceWords.length) {
      // Same index: use timing/style from source, text from edited
      return { ...sourceWords[i], text: tw };
    }
    // New word added: distribute timing evenly
    const segDur = seg.endMs - seg.startMs;
    const wordDur = textWords.length > 0 ? segDur / textWords.length : segDur;
    return {
      text: tw,
      startMs: seg.startMs + Math.round(i * wordDur),
      endMs: seg.startMs + Math.round((i + 1) * wordDur),
    };
  });

  const handleWordClick = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      setSelectedWordIndices((prev) => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
    } else {
      setSelectedWordIndices((prev) =>
        prev.size === 1 && prev.has(idx) ? new Set() : new Set([idx])
      );
    }
  };

  const selectedMerged = Array.from(selectedWordIndices).map((i) => mergedWords[i]).filter(Boolean);
  const currentColor = selectedMerged.length > 0 ? (selectedMerged[0].style?.color ?? '') : '';
  const currentSize = selectedMerged.length > 0 ? (selectedMerged[0].style?.fontSize ?? '') : '';
  const currentBold = selectedMerged.length > 0 && selectedMerged.every((w) => (w.style?.fontWeight ?? 400) >= 700);

  const applyStyle = (update: Partial<NonNullable<SubtitleWord['style']>>) => {
    if (selectedWordIndices.size === 0) return;
    const updated = mergedWords.map((w, i) => {
      if (!selectedWordIndices.has(i)) return w;
      const newStyle = { ...w.style, ...update };
      // Remove keys that are empty/undefined
      if (!newStyle.color) delete newStyle.color;
      if (!newStyle.fontSize) delete newStyle.fontSize;
      if (newStyle.fontWeight === undefined) delete newStyle.fontWeight;
      const hasKeys = Object.keys(newStyle).length > 0;
      return { ...w, style: hasKeys ? newStyle : undefined };
    });
    updateReelSubtitleSegment(reelId, segId, { words: updated });
  };

  return (
    <div className="px-3 py-1.5 space-y-1.5">
      {/* Word chips */}
      <div className="flex flex-wrap gap-1">
        {mergedWords.map((word, idx) => {
          const isSelected = selectedWordIndices.has(idx);
          const hasStyle = !!word.style;
          return (
            <button
              key={idx}
              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                isSelected
                  ? 'border-primary bg-primary/20 text-primary'
                  : 'border-border bg-muted/30 text-foreground hover:bg-muted/50'
              }`}
              onClick={(e) => handleWordClick(idx, e)}
            >
              {word.text}
              {hasStyle && (
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full ml-0.5 align-middle"
                  style={{ backgroundColor: word.style?.color ?? '#888' }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Style controls (only when words selected) */}
      {selectedWordIndices.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {/* Color */}
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            Color
            <input
              type="color"
              className="w-5 h-5 rounded cursor-pointer border-0 p-0"
              value={currentColor || '#ffffff'}
              onChange={(e) => applyStyle({ color: e.target.value })}
            />
            {currentColor && (
              <button
                className="text-[9px] text-muted-foreground hover:text-foreground"
                onClick={() => applyStyle({ color: undefined })}
                title="Reset color"
              >
                x
              </button>
            )}
          </label>

          {/* Size */}
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            Size
            <input
              type="range"
              min={16}
              max={300}
              step={1}
              value={Number(currentSize) || 60}
              onChange={(e) => applyStyle({ fontSize: parseInt(e.target.value) })}
              className="w-16 h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
            <span className="w-6 text-right">{currentSize || '-'}</span>
            {currentSize && (
              <button
                className="text-[9px] text-muted-foreground hover:text-foreground"
                onClick={() => applyStyle({ fontSize: undefined })}
                title="Reset size"
              >
                x
              </button>
            )}
          </label>

          {/* Bold toggle */}
          <button
            className={`p-1 rounded border text-[10px] ${
              currentBold ? 'border-primary bg-primary/20 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => applyStyle({ fontWeight: currentBold ? undefined : 700 })}
            title="Toggle bold"
          >
            <Bold className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Subtitle list editor ───────────────────────────────────────────── */

function SubtitleListEditor({ reelId }: { reelId: string }) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const updateReelSubtitleSegment = useReelStore((s) => s.updateReelSubtitleSegment);
  const stripReelSubtitlePunctuation = useReelStore((s) => s.stripReelSubtitlePunctuation);
  const deleteSubtitleSegment = useReelStore((s) => s.deleteSubtitleSegment);
  const selectedSubtitleIds = useReelStore((s) => s.selectedSubtitleIds);
  const selectSubtitle = useReelStore((s) => s.selectSubtitle);
  const setCurrentTime = useReelStore((s) => s.setCurrentTime);

  // When text is manually edited, sync the words array
  const handleTextChange = useCallback(
    (segId: string, newText: string) => {
      const seg = reel?.subtitleSegments.find((s) => s.id === segId);
      if (!seg) {
        updateReelSubtitleSegment(reelId, segId, { text: newText });
        return;
      }

      if (!seg.words || seg.words.length === 0) {
        updateReelSubtitleSegment(reelId, segId, { text: newText });
        return;
      }

      // Split new text into words
      const newWords = newText.split(/\s+/).filter(Boolean);
      const oldWords = seg.words;

      if (newWords.length === oldWords.length) {
        // Same word count: update text of each word, preserve timing & style
        const updatedWords = oldWords.map((w, i) => ({
          ...w,
          text: newWords[i],
        }));
        updateReelSubtitleSegment(reelId, segId, { text: newText, words: updatedWords });
      } else {
        // Word count changed: redistribute timing evenly, preserve styles for first N
        const segDur = seg.endMs - seg.startMs;
        const wordDur = newWords.length > 0 ? segDur / newWords.length : segDur;
        const updatedWords = newWords.map((text, i) => ({
          text,
          startMs: seg.startMs + Math.round(i * wordDur),
          endMs: seg.startMs + Math.round((i + 1) * wordDur),
          style: i < oldWords.length ? oldWords[i].style : undefined,
        }));
        updateReelSubtitleSegment(reelId, segId, { text: newText, words: updatedWords });
      }
    },
    [reel, reelId, updateReelSubtitleSegment]
  );

  if (!reel) return null;

  const constraints = reel.subtitleConstraints;
  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border sticky top-0 bg-card z-10 flex items-center justify-between">
        <span>Subtitles ({reel.subtitleSegments.length})</span>
        <button
          className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
          onClick={() => stripReelSubtitlePunctuation(reelId)}
          title="Eliminar la puntuación final (.,;:) de todos los bloques"
        >
          <RemoveFormatting className="h-3 w-3" />
          Strip .,
        </button>
      </div>
      <div className="divide-y divide-border">
        {reel.subtitleSegments.map((seg) => {
          const tooLong = seg.text.length > constraints.maxCharsPerBlock;
          const tooSlow = (seg.endMs - seg.startMs) > constraints.maxDurationMs;
          const isSelected = selectedSubtitleIds.includes(seg.id);

          return (
            <div key={seg.id}>
              <div
                className={`flex items-start gap-2 px-3 py-1 text-xs cursor-pointer hover:bg-muted/30 ${
                  isSelected ? 'bg-yellow-500/10' : ''
                } ${tooLong || tooSlow ? 'bg-yellow-950/10' : ''}`}
                onClick={() => {
                  selectSubtitle(seg.id);
                  setCurrentTime(seg.startMs);
                }}
              >
                <span className="text-[10px] text-muted-foreground whitespace-nowrap tabular-nums w-24 flex-shrink-0 self-start pt-0.5">
                  {formatTimestamp(seg.startMs)} - {formatTimestamp(seg.endMs)}
                </span>
                <textarea
                  className="flex-1 bg-transparent text-xs outline-none min-w-0 resize-none overflow-hidden"
                  value={seg.text}
                  rows={Math.max(1, seg.text.split('\n').length)}
                  // Grow with soft wraps too (the column is 30 % of the top half).
                  style={{ fieldSizing: 'content' } as React.CSSProperties}
                  onChange={(e) => handleTextChange(seg.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.stopPropagation();
                    }
                  }}
                />
                {tooLong && <span className="text-[9px] text-yellow-500 flex-shrink-0 self-start pt-0.5">{seg.text.length}ch</span>}
                <button
                  className="p-0.5 text-muted-foreground hover:text-red-400 flex-shrink-0 self-start pt-0.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSubtitleSegment(reelId, seg.id);
                  }}
                  title="Delete subtitle"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              {/* Word style editor for selected subtitle */}
              {isSelected && seg.text.trim().length > 0 && (
                <WordStyleEditor reelId={reelId} segId={seg.id} seg={seg} />
              )}
            </div>
          );
        })}
        {reel.subtitleSegments.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No subtitles. Use &quot;Regenerate&quot; in the style panel.
          </p>
        )}
      </div>
    </div>
  );
}

/* ── Subtitle style preview (zoomed) ───────────────────────────────── */

const PREVIEW_BG_COLORS = ['#111111', '#333333', '#666666', '#999999', '#cccccc', '#ffffff', '#1a3a1a', '#3a1a1a', '#1a1a3a'];

function SubtitleStylePreview({ style }: { style: SubtitleStyle }) {
  const sampleText = 'SAMPLE TEXT\nPreview';
  const scale = 0.4;
  const [bgColor, setBgColor] = useState('#111111');

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-xs font-medium">Preview</h3>
        <div className="flex gap-0.5">
          {PREVIEW_BG_COLORS.slice(0, 6).map((c) => (
            <button
              key={c}
              className={`w-3.5 h-3.5 rounded-sm border ${bgColor === c ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
              style={{ background: c }}
              onClick={() => setBgColor(c)}
              title={c}
            />
          ))}
        </div>
      </div>
      <div
        className="relative rounded border border-border overflow-hidden"
        style={{
          background: bgColor,
          height: 120,
          display: 'flex',
          alignItems: style.position === 'top' ? 'flex-start' : style.position === 'center' ? 'center' : 'flex-end',
          justifyContent: 'center',
          padding: `${Math.round(style.marginBottom * scale * 0.3)}px 8px`,
        }}
      >
        <span
          style={{
            fontFamily: style.fontFamily,
            fontSize: Math.round(style.fontSize * scale),
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            color: style.color,
            textTransform: style.textTransform as React.CSSProperties['textTransform'],
            textAlign: 'center',
            maxWidth: Math.round(style.maxWidth * scale),
            whiteSpace: 'pre-wrap',
            WebkitTextStroke: style.strokeWidth > 0 ? `${Math.round(style.strokeWidth * scale)}px ${style.strokeColor}` : undefined,
            textShadow: style.shadowBlur > 0
              ? `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${Math.round(style.shadowBlur * scale)}px rgba(0,0,0,0.8)`
              : undefined,
            backgroundColor: style.backgroundColor !== 'transparent' ? style.backgroundColor : undefined,
            padding: style.backgroundPadding > 0 ? `${Math.round(style.backgroundPadding * scale)}px` : undefined,
            borderRadius: style.backgroundPadding > 0 ? '4px' : undefined,
          }}
        >
          {sampleText}
        </span>
      </div>
    </div>
  );
}

/* ── Style / constraints panel (no fixed width — fills container) ──── */

function SubtitleConfigPanel({ reelId }: { reelId: string }) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const setReelSubtitleStyle = useReelStore((s) => s.setReelSubtitleStyle);
  const setReelSubtitlePreset = useReelStore((s) => s.setReelSubtitlePreset);
  const setReelSubtitleConstraints = useReelStore((s) => s.setReelSubtitleConstraints);
  const regenerateReelSubtitles = useReelStore((s) => s.regenerateReelSubtitles);
  const syncReelSubtitlesFromBase = useReelStore((s) => s.syncReelSubtitlesFromBase);
  const updateReel = useReelStore((s) => s.updateReel);
  const params = useParams();
  const projectId = params.id as string;
  const { customPresets, savePreset, deletePreset } = useCustomPresets(projectId);

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
  const violations = reel.subtitleSegments.filter((s) => segmentViolates(s, constraints)).length;

  return (
    <div className="overflow-y-auto p-3 space-y-3">
      {/* Quick position */}
      <div>
        <h3 className="text-xs font-medium mb-1.5">Position</h3>
        <div className="flex gap-1 mb-1.5">
          {(['top', 'center', 'bottom'] as const).map((pos) => (
            <Button
              key={pos}
              variant={reel.subtitleStyle.position === pos ? 'default' : 'outline'}
              size="sm"
              className="flex-1 text-[10px] h-6"
              onClick={() => handleStyleChange({ ...reel.subtitleStyle, position: pos })}
            >
              {pos}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-muted-foreground whitespace-nowrap">Margin</label>
          <input
            type="range" min={0} max={400} step={5}
            value={reel.subtitleStyle.marginBottom}
            onChange={(e) => handleStyleChange({ ...reel.subtitleStyle, marginBottom: parseInt(e.target.value) })}
            className="flex-1 h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          />
          <span className="text-[10px] text-muted-foreground w-7 text-right">{reel.subtitleStyle.marginBottom}</span>
        </div>
      </div>

      {/* Style editor */}
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
        <h3 className="text-xs font-medium mb-1.5">Constraints</h3>
        {/* Modo de troceo: clásico por caracteres, o picado por frases (≤ N palabras) */}
        <div className="mb-1.5">
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
          <div className="mb-1.5">
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
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-[10px] text-muted-foreground mb-0.5">Max chars</label>
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
            <label className="block text-[10px] text-muted-foreground mb-0.5">Max ms</label>
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
        <div className="flex gap-2 mt-1.5">
          <Button
            size="sm" variant="outline" className="text-xs h-7"
            onClick={() => regenerateReelSubtitles(reelId)}
            title="Re-derive from the reel's own subtitleSegments + clip boundaries (preserves text edits)"
          >
            <RefreshCw className="mr-1 h-3 w-3" /> Regen
          </Button>
          <Button
            size="sm" variant="outline" className="text-xs h-7 text-amber-300 border-amber-700/40"
            onClick={() => {
              const ok = window.confirm(
                'Reemplazar los subtítulos de este reel con los actuales de la transcripción.\n\n' +
                'Esto BORRA cualquier edición que hayas hecho a los subs en este reel ' +
                '(Delete + Close Gap, cambios de texto, etc.). Úsalo solo si el reel ' +
                'tiene un snapshot antiguo desincronizado con la transcripción actual.\n\n' +
                '¿Continuar?'
              );
              if (ok) syncReelSubtitlesFromBase(reelId);
            }}
            title="Replace this reel's subs with whatever the transcription currently has for the reel's time range. Destroys per-reel edits."
          >
            <RefreshCw className="mr-1 h-3 w-3" /> Sync from transcript
          </Button>
          {violations > 0 && (
            <Button size="sm" variant="outline" className="text-xs h-7" onClick={handleAutoSplit}>
              <Scissors className="mr-1 h-3 w-3" /> Split ({violations})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Text clip config panel ─────────────────────────────────────────── */

function TextClipConfigPanel({ reelId }: { reelId: string }) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const firstSelectedId = useReelStore((s) => s.selectedClipIds[0] ?? null);
  const updateClip = useReelStore((s) => s.updateClip);

  const clip = reel?.composition.clips.find((c) => c.id === firstSelectedId);
  if (!clip || clip.type !== 'text') return null;

  const ts = clip.textStyle ?? {
    fontSize: 48,
    fontFamily: 'Inter',
    fontWeight: 400,
    color: '#ffffff',
    backgroundColor: undefined,
    lineHeight: 1.2,
    shadowColor: undefined,
    shadowBlur: 0,
    shadowX: 0,
    shadowY: 0,
  };

  const pos = clip.overlayPosition ?? { x: 0.5, y: 0.5, width: 0.8 };

  const updateTextStyle = (updates: Partial<NonNullable<typeof clip.textStyle>>) => {
    updateClip(reelId, clip.id, {
      textStyle: { ...ts, ...updates },
    });
  };

  const updateOverlayPos = (updates: Partial<NonNullable<typeof clip.overlayPosition>>) => {
    updateClip(reelId, clip.id, {
      overlayPosition: { ...pos, ...updates },
    });
  };

  return (
    <div className="overflow-y-auto p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-orange-400">Text Overlay</h3>
        <div className="flex items-center gap-1">
          <ApplyOverlayTemplateButton reelId={reelId} clip={clip} />
          <SaveOverlayAsTemplateButton clip={clip} />
        </div>
      </div>

      {/* Text content */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">Content</label>
        <textarea
          className="w-full bg-muted/30 border border-border rounded px-2 py-1 text-xs outline-none resize-none"
          value={clip.textContent ?? ''}
          rows={3}
          onChange={(e) => updateClip(reelId, clip.id, { textContent: e.target.value })}
          placeholder="Enter text..."
        />
      </div>

      {/* Font family */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">Font</label>
        <select
          className="w-full bg-muted/30 border border-border rounded px-2 py-1 text-xs outline-none"
          value={ts.fontFamily}
          onChange={(e) => updateTextStyle({ fontFamily: e.target.value })}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      {/* Font size */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">
          Size: {ts.fontSize}px
        </label>
        <input
          type="range" min={12} max={300} step={1}
          value={ts.fontSize}
          onChange={(e) => updateTextStyle({ fontSize: parseInt(e.target.value) })}
          className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
        />
      </div>

      {/* Font weight */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">
          Weight: {ts.fontWeight}
        </label>
        <input
          type="range" min={100} max={900} step={100}
          value={ts.fontWeight}
          onChange={(e) => updateTextStyle({ fontWeight: parseInt(e.target.value) })}
          className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
        />
      </div>

      {/* Colors */}
      <div className="flex gap-3">
        <div>
          <label className="block text-[10px] text-muted-foreground mb-0.5">Color</label>
          <input
            type="color"
            className="w-8 h-8 rounded cursor-pointer border border-border p-0"
            value={ts.color}
            onChange={(e) => updateTextStyle({ color: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[10px] text-muted-foreground mb-0.5">Background</label>
          <div className="flex items-center gap-1">
            <input
              type="color"
              className="w-8 h-8 rounded cursor-pointer border border-border p-0"
              value={ts.backgroundColor ?? '#000000'}
              onChange={(e) => updateTextStyle({ backgroundColor: e.target.value })}
            />
            {ts.backgroundColor && (
              <button
                className="text-[9px] text-muted-foreground hover:text-foreground"
                onClick={() => updateTextStyle({ backgroundColor: undefined })}
                title="Remove background"
              >
                x
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Text alignment inside the bounding box */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">
          Alignment <span className="text-muted-foreground/60">(within box)</span>
        </label>
        <div className="grid grid-cols-3 gap-1">
          {(['left', 'center', 'right'] as const).map((opt) => {
            const active = (ts.textAlign ?? 'center') === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => updateTextStyle({ textAlign: opt })}
                className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                  active
                    ? 'border-orange-400/60 bg-orange-500/15 text-orange-300'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
                title={`Align ${opt}`}
              >
                {opt[0].toUpperCase() + opt.slice(1)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Line Height */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">
          Line Height: {(ts.lineHeight ?? 1.2).toFixed(1)}
        </label>
        <input
          type="range" min={0.8} max={3.0} step={0.1}
          value={ts.lineHeight ?? 1.2}
          onChange={(e) => updateTextStyle({ lineHeight: parseFloat(e.target.value) })}
          className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
        />
      </div>

      {/* Shadow */}
      <div>
        <h4 className="text-[10px] text-muted-foreground mb-1">Shadow</h4>
        <div className="flex items-center gap-2 mb-1.5">
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">Color</label>
            <div className="flex items-center gap-1">
              <input
                type="color"
                className="w-8 h-8 rounded cursor-pointer border border-border p-0"
                value={ts.shadowColor ?? '#000000'}
                onChange={(e) => updateTextStyle({ shadowColor: e.target.value })}
              />
              {ts.shadowColor && (
                <button
                  className="text-[9px] text-muted-foreground hover:text-foreground"
                  onClick={() => updateTextStyle({ shadowColor: undefined, shadowBlur: 0, shadowX: 0, shadowY: 0 })}
                  title="Remove shadow"
                >
                  x
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              Blur: {ts.shadowBlur ?? 0}
            </label>
            <input
              type="range" min={0} max={20} step={1}
              value={ts.shadowBlur ?? 0}
              onChange={(e) => updateTextStyle({ shadowBlur: parseInt(e.target.value), shadowColor: ts.shadowColor || '#000000' })}
              className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              X: {ts.shadowX ?? 0}
            </label>
            <input
              type="range" min={-10} max={10} step={1}
              value={ts.shadowX ?? 0}
              onChange={(e) => updateTextStyle({ shadowX: parseInt(e.target.value), shadowColor: ts.shadowColor || '#000000' })}
              className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              Y: {ts.shadowY ?? 0}
            </label>
            <input
              type="range" min={-10} max={10} step={1}
              value={ts.shadowY ?? 0}
              onChange={(e) => updateTextStyle({ shadowY: parseInt(e.target.value), shadowColor: ts.shadowColor || '#000000' })}
              className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
        </div>
      </div>

      {/* Position */}
      <div>
        <h4 className="text-[10px] text-muted-foreground mb-1">Position</h4>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              X: {Math.round(pos.x * 100)}%
            </label>
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round(pos.x * 100)}
              onChange={(e) => updateOverlayPos({ x: parseInt(e.target.value) / 100 })}
              className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              Y: {Math.round(pos.y * 100)}%
            </label>
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round(pos.y * 100)}
              onChange={(e) => updateOverlayPos({ y: parseInt(e.target.value) / 100 })}
              className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-muted-foreground mb-0.5">
            Width: {Math.round(pos.width * 100)}%
          </label>
          <input
            type="range" min={10} max={100} step={1}
            value={Math.round(pos.width * 100)}
            onChange={(e) => updateOverlayPos({ width: parseInt(e.target.value) / 100 })}
            className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          />
        </div>
      </div>

      {/* Preview — mirrors the canvas overlay so what you tweak here matches
          exactly what's drawn over the video and what the export produces. */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">Preview</label>
        <div
          className="relative rounded border border-border overflow-hidden bg-black"
          style={{ height: 80 }}
        >
          <div
            style={{
              position: 'absolute',
              left: `${pos.x * 100}%`,
              top: `${pos.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              // The mini preview width tracks pos.width so the box visually
              // represents the real frame the text lives in.
              width: `${pos.width * 100}%`,
              border: '1px dashed rgba(255,200,80,0.7)',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                width: '100%',
                fontFamily: ts.fontFamily,
                fontSize: Math.min(24, ts.fontSize * 0.3),
                fontWeight: ts.fontWeight,
                color: ts.color,
                backgroundColor: ts.backgroundColor ?? undefined,
                padding: ts.backgroundColor ? '2px 4px' : undefined,
                borderRadius: ts.backgroundColor ? 2 : undefined,
                textAlign: cssTextAlign(ts.textAlign),
                whiteSpace: 'pre-wrap',
                wordBreak: 'normal',
                overflowWrap: 'break-word',
                lineHeight: ts.lineHeight ?? 1.2,
                textShadow: ts.shadowColor
                  ? `${ts.shadowX ?? 0}px ${ts.shadowY ?? 0}px ${ts.shadowBlur ?? 0}px ${ts.shadowColor}`
                  : undefined,
              }}
            >
              {clip.textContent || 'Text'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Image/GIF clip config panel ────────────────────────────────────── */

// Motion (zoom / position / rotation) panel for a selected video clip on the
// reel timeline — mirrors the compose ClipProperties motion section so reels
// can zoom/reframe/straighten per cut, applied by renderReelVideo via
// clip.transform.
function VideoClipMotionPanel({ reelId }: { reelId: string }) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  // Rounded in the selector: only used as a display-reference for "Zoom
  // final" (which clip instant to read transform×crop from), so the raw
  // per-rAF-tick value (60/s during playback) would otherwise re-render this
  // whole motion panel every frame for no visible benefit.
  const playheadMs = useReelStore((s) => Math.round(s.currentTimeMs / 50) * 50);
  const selectedClipIds = useReelStore((s) => s.selectedClipIds);
  const firstSelectedId = selectedClipIds[0] ?? null;
  const updateClip = useReelStore((s) => s.updateClip);
  const [canPasteMotion, setCanPasteMotion] = useState(() => hasMotionTransform());

  const clip = reel?.composition.clips.find((c) => c.id === firstSelectedId);
  if (!clip || clip.type !== 'video') return null;

  // A video clip on any track other than the main rv1 is a PiP overlay.
  const isOverlayVideo = clip.trackId !== 'rv1';
  const ov = clip.overlayPosition ?? { x: 0.5, y: 0.5, width: 0.4 };
  const patchOverlay = (updates: Partial<{ x: number; y: number; width: number }>) => {
    updateClip(reelId, clip.id, { overlayPosition: { ...ov, ...updates } });
  };

  const t = clip.transform ?? { scale: 1, x: 0, y: 0, rotation: 0 };
  const patch = (updates: Partial<{ scale: number; x: number; y: number; rotation: number }>) => {
    updateClip(reelId, clip.id, {
      transform: {
        scale: t.scale ?? 1,
        x: t.x ?? 0,
        y: t.y ?? 0,
        rotation: t.rotation ?? 0,
        ...updates,
      },
    });
  };

  const handleCopyMotion = () => {
    copyMotionTransform(t);
    setCanPasteMotion(true);
  };
  const handlePasteMotion = () => {
    const copied = getMotionTransform();
    if (!copied || !reel) return;
    // Applies to every selected clip (not just this one) so a multi-select
    // paste gives them all the same zoom/position/angle in one go.
    const targets = selectedClipIds.length > 0 ? selectedClipIds : [clip.id];
    for (const id of targets) {
      const target = reel.composition.clips.find((c) => c.id === id);
      if (!target || target.type === 'audio' || target.type === 'text') continue;
      updateClip(reelId, id, { transform: { ...copied } });
    }
  };

  // Label + slider + editable number input, all in the SAME natural unit
  // (percent, degrees) — typing a value works exactly like dragging.
  const row = (label: string, unit: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void) => (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-12">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="w-14 h-5 rounded border border-border bg-background px-1 text-right font-mono text-[10px]"
      />
      <span className="w-3 text-[9px] text-muted-foreground">{unit}</span>
    </div>
  );

  return (
    <div className="overflow-y-auto p-3 space-y-3">
      {/* PiP overlay position/size — only for secondary-track video clips */}
      {isOverlayVideo && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-cyan-400">Overlay (PiP) — recuadro sobre el vídeo principal</h3>
          {row('Pos X', '%', 0, 100, 1, Math.round(ov.x * 100), (v) => patchOverlay({ x: v / 100 }))}
          {row('Pos Y', '%', 0, 100, 1, Math.round(ov.y * 100), (v) => patchOverlay({ y: v / 100 }))}
          {row('Tamaño', '%', 5, 100, 1, Math.round(ov.width * 100), (v) => patchOverlay({ width: v / 100 }))}
          {row('Opacidad', '%', 0, 100, 1, Math.round((clip.opacity ?? 1) * 100), (v) => updateClip(reelId, clip.id, { opacity: v / 100 }))}
          <p className="text-[9px] text-muted-foreground italic leading-tight">
            Este vídeo se superpone en un recuadro sobre el principal durante su tramo. Pos = centro del recuadro.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-purple-400">Motion (zoom / posición / ángulo)</h3>
        <div className="flex items-center gap-1.5">
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={handleCopyMotion}
            title="Copiar zoom/posición/ángulo de este clip"
          >
            Copiar
          </button>
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            onClick={handlePasteMotion}
            disabled={!canPasteMotion}
            title="Pegar en el/los clip(s) seleccionado(s)"
          >
            Pegar
          </button>
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => updateClip(reelId, clip.id, { transform: { scale: 1, x: 0, y: 0, rotation: 0 } })}
            title="Reset motion"
          >
            Reset
          </button>
        </div>
      </div>
      {row('Zoom', '%', 10, 400, 1, Math.round((t.scale ?? 1) * 100), (v) => patch({ scale: v / 100 }))}
      {row('Pos X', '%', -100, 100, 1, Math.round((t.x ?? 0) * 100), (v) => patch({ x: v / 100 }))}
      {row('Pos Y', '%', -100, 100, 1, Math.round((t.y ?? 0) * 100), (v) => patch({ y: v / 100 }))}
      {row('Ángulo', '°', -180, 180, 0.1, Math.round((t.rotation ?? 0) * 10) / 10, (v) => patch({ rotation: v }))}

      {/* The clip's Motion zoom is NOT what the viewer sees: the 9:16 crop
          window multiplies it (transform runs in 16:9 source space, the crop
          is taken afterwards — see the WYSIWYG branch in ffmpeg-wrapper). With
          an animated crop the same Motion value looks different at every
          moment, which made "give this shot the same zoom as the first one"
          guesswork. So we surface the PRODUCT and let it be typed directly. */}
      {!isOverlayVideo && reel && (() => {
        const inClip = (ms: number) => ms >= clip.timelineStartMs && ms < clip.timelineEndMs;
        const refMs = inClip(playheadMs) ? playheadMs : clip.timelineStartMs;
        const cropHere = cropAtTime(reel.cropRegion, reel.cropKeyframes, refMs);
        const cropZoom = 1 / cropHere.scale;                       // ×1 … ×3.16
        const finalPct = Math.round((t.scale ?? 1) * cropZoom * 100);
        // Does the framing move WITHIN this shot? Then "the" final zoom is a range.
        const zAt = (ms: number) => (t.scale ?? 1) / cropAtTime(reel.cropRegion, reel.cropKeyframes, ms).scale;
        // Sample the ends AND every keyframe inside the shot — comparing only
        // the endpoints misses a keyframe that bumps the zoom in the middle.
        const samples = [
          clip.timelineStartMs,
          Math.max(clip.timelineStartMs, clip.timelineEndMs - 1),
          ...(reel.cropKeyframes ?? [])
            .filter((k) => k.timeMs > clip.timelineStartMs && k.timeMs < clip.timelineEndMs)
            .map((k) => k.timeMs),
        ].map(zAt);
        const zStart = samples[0];
        const zEnd = samples[1];
        const animatedInClip = Math.max(...samples) - Math.min(...samples) > 0.01;
        return (
          <div className="space-y-1 rounded border border-purple-500/30 bg-purple-500/5 p-1.5">
            {row('Zoom final', '%', 10, Math.round(400 * cropZoom), 1, finalPct, (v) =>
              patch({ scale: Math.min(4, Math.max(0.1, v / 100 / cropZoom)) })
            )}
            <p className="text-[9px] leading-tight text-muted-foreground">
              Lo que se ve = <span className="font-mono">Zoom del plano × encuadre</span>
              {' '}(<span className="font-mono">{Math.round((t.scale ?? 1) * 100)}% × {cropZoom.toFixed(2)}</span>).
              {animatedInClip
                ? <> El encuadre se <strong>mueve dentro de este plano</strong>: el zoom final va de{' '}
                    {Math.round(Math.min(...samples) * 100)}% a {Math.round(Math.max(...samples) * 100)}%
                    {' '}(entra en {Math.round(zStart * 100)}%, sale en {Math.round(zEnd * 100)}%).</>
                : <> Ajusta <strong>Zoom final</strong> para igualar planos sin hacer cuentas.</>}
            </p>
            {animatedInClip && (
              <button
                className="text-[9px] text-purple-300 hover:text-purple-200 underline"
                title="Escribe un keyframe de encuadre al principio y al final del plano con el encuadre de su primer fotograma"
                onClick={() => useReelStore.getState()
                  .freezeCropInRange(reelId, clip.timelineStartMs, clip.timelineEndMs)}
              >
                Congelar el encuadre dentro de este plano
              </button>
            )}
          </div>
        );
      })()}

      <p className="text-[9px] text-muted-foreground italic leading-tight">
        Tip: para enderezar un plano torcido, gira el ángulo y sube un poco el zoom para que no aparezcan esquinas negras. Para valores distintos por momento, divide el clip (S).
      </p>

      {/* Transition into the NEXT adjacent clip on this track (export via
          FFmpeg xfade with handle pre-roll; the live preview shows a cut). */}
      {(() => {
        const nextAdjacent = (reel?.composition.clips ?? []).find(
          (c) => c.id !== clip.id && c.trackId === clip.trackId && c.type === 'video' &&
            Math.abs(c.timelineStartMs - clip.timelineEndMs) < 50
        );
        if (!nextAdjacent) return null;
        const trans = clip.transitionAfter;
        return (
          <div className="space-y-2 border-t border-border pt-2">
            <h3 className="text-xs font-medium text-purple-400">Transición al siguiente clip</h3>
            <select
              className="w-full h-6 rounded border border-border bg-background px-1 text-[10px] outline-none"
              value={trans?.type ?? 'none'}
              onChange={(e) => {
                const v = e.target.value;
                updateClip(reelId, clip.id, {
                  transitionAfter: v === 'none'
                    ? undefined
                    : { type: v as NonNullable<CompositionClip['transitionAfter']>['type'], durationMs: trans?.durationMs ?? 500 },
                });
              }}
            >
              <option value="none">Ninguna (corte)</option>
              <option value="dissolve">Disolver (dissolve)</option>
              <option value="wipe">Barrido (wipe)</option>
              <option value="slide">Desplazamiento (slide)</option>
              <option value="zoom">Zoom</option>
            </select>
            {trans && row('Duración', 'ms', 100, 2000, 50, trans.durationMs, (v) =>
              updateClip(reelId, clip.id, { transitionAfter: { ...trans, durationMs: Math.round(v) } })
            )}
            {trans && (
              <p className="text-[9px] text-muted-foreground italic leading-tight">
                Se renderiza en el export (el preview muestra un corte). Usa material previo al punto de entrada del clip siguiente, así la duración total no cambia.
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// Audio clip config: lower the intensity (volume) and define a fade-in ramp.
// Mostly aimed at extra-audio layers (pasted / copied clips on ra2+), but works
// for any audio clip. Applied live by ReelExtraAudio and on export by
// renderReelVideo (volume + afade=t=in).
function AudioClipConfigPanel({ reelId }: { reelId: string }) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const playheadMs = useReelStore((s) => s.currentTimeMs);
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const firstSelectedId = useReelStore((s) => s.selectedClipIds[0] ?? null);
  const updateClip = useReelStore((s) => s.updateClip);

  const clip = reel?.composition.clips.find((c) => c.id === firstSelectedId);
  if (!clip || clip.type !== 'audio') return null;

  // Volume/fade only apply to the EXTRA audio layers (ra2+). The main ra1 track
  // is the gated muxed/separate audio; for it we only offer the WAV export.
  const isExtra = clip.trackId !== 'ra1';
  const clipDurMs = Math.max(0, clip.timelineEndMs - clip.timelineStartMs);
  const volPct = Math.round((clip.volume ?? 1) * 100);
  const fadeMs = clip.fadeInMs ?? 0;
  const curve = clip.fadeInCurve ?? 'linear';

  const row = (label: string, value: string, min: number, max: number, step: number, sliderVal: number, onChange: (v: number) => void) => (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-16">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={sliderVal}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
      <span className="text-[10px] text-foreground w-12 text-right font-mono">{value}</span>
    </div>
  );

  return (
    <div className="overflow-y-auto p-3 space-y-3">
      <h3 className="text-xs font-medium text-green-400">Audio — {clip.originalName}</h3>

      {isExtra && (
        <>
          {/* Intensity / volume (0–200%, 1.0 = original — same range as Compose;
              above 100% the live preview amplifies through Web Audio and the
              export applies the exact gain) */}
          {row('Intensidad', `${volPct}%`, 0, 200, 1, volPct, (v) => updateClip(reelId, clip.id, { volume: v / 100 }))}

          {/* Fade-in duration — capped at the clip's own length */}
          {(() => {
            const fadeMax = Math.min(10000, Math.max(200, clipDurMs));
            return row(
              'Fade-in',
              fadeMs >= 1000 ? `${(fadeMs / 1000).toFixed(1)}s` : `${fadeMs}ms`,
              0,
              fadeMax,
              50,
              Math.min(fadeMs, fadeMax),
              (v) => updateClip(reelId, clip.id, { fadeInMs: Math.round(v) })
            );
          })()}

          {/* Fade-in curve */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-16">Curva</span>
            <select
              className="flex-1 h-6 rounded border border-border bg-background px-1 text-[10px] outline-none disabled:opacity-50"
              value={curve}
              disabled={fadeMs === 0}
              onChange={(e) => updateClip(reelId, clip.id, { fadeInCurve: e.target.value as NonNullable<CompositionClip['fadeInCurve']> })}
              title="Forma de la curva de fundido de entrada"
            >
              <option value="linear">Lineal</option>
              <option value="exponential">Exponencial (suave al inicio)</option>
              <option value="logarithmic">Logarítmica (sube rápido)</option>
              <option value="quarter-sine">Cuarto de seno (muy suave)</option>
            </select>
            {fadeMs > 0 && (
              <button
                className="text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => updateClip(reelId, clip.id, { fadeInMs: 0 })}
                title="Quitar fundido"
              >
                x
              </button>
            )}
          </div>

          <p className="text-[9px] text-muted-foreground italic leading-tight">
            Capa de audio extra: se suma al audio principal. Baja la intensidad para que quede de fondo y usa el fade-in para que entre suave.
          </p>
        </>
      )}

      {/* Volume zones — every audio clip, main track included. */}
      <div className="border-t border-border pt-2">
        <ClipGainPanel
          clip={clip}
          playheadMs={playheadMs}
          projectId={projectId}
          onChange={(regions) => {
            useReelStore.getState().saveSnapshot();
            updateClip(reelId, clip.id, { gainRegions: regions });
          }}
        />
      </div>

      {/* Export this clip's audio as WAV for external editing (Audacity, etc.) */}
      {clip.fileName && (
        <div className="border-t border-border pt-2">
          <ExportAudioClipButton
            projectId={projectId}
            fileName={clip.fileName}
            sourceInMs={clip.sourceInMs}
            sourceOutMs={clip.sourceOutMs}
            downloadName={clip.originalName?.replace(/\.[^.]+$/, '') || 'audio'}
          />
        </div>
      )}
    </div>
  );
}

function ImageClipConfigPanel({ reelId }: { reelId: string }) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const firstSelectedId = useReelStore((s) => s.selectedClipIds[0] ?? null);
  const updateClip = useReelStore((s) => s.updateClip);

  const clip = reel?.composition.clips.find((c) => c.id === firstSelectedId);
  if (!clip || (clip.type !== 'image' && clip.type !== 'gif')) return null;

  const pos = clip.overlayPosition ?? { x: 0.5, y: 0.5, width: 0.8 };
  const opacity = clip.opacity ?? 1;

  const updateOverlayPos = (updates: Partial<{ x: number; y: number; width: number }>) => {
    updateClip(reelId, clip.id, {
      overlayPosition: { ...pos, ...updates },
    });
  };

  return (
    <div className="overflow-y-auto p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-purple-400">Image Overlay</h3>
        <SaveOverlayAsTemplateButton clip={clip} />
      </div>

      {/* Thumbnail preview with position indicator */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">Preview</label>
        <div
          className="relative rounded border border-border overflow-hidden bg-black"
          style={{ height: 120, aspectRatio: '9/16', margin: '0 auto' }}
        >
          {projectId && (
            <img
              src={`/api/projects/${projectId}/reels/file?name=${encodeURIComponent(clip.fileName)}`}
              alt={clip.originalName}
              style={{
                position: 'absolute',
                left: `${pos.x * 100}%`,
                top: `${pos.y * 100}%`,
                transform: 'translate(-50%, -50%)',
                maxWidth: `${pos.width * 100}%`,
                maxHeight: '100%',
                objectFit: 'contain',
                opacity,
              }}
            />
          )}
        </div>
      </div>

      {/* Position */}
      <div>
        <h4 className="text-[10px] text-muted-foreground mb-1">Position</h4>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              X: {Math.round(pos.x * 100)}%
            </label>
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round(pos.x * 100)}
              onChange={(e) => updateOverlayPos({ x: parseInt(e.target.value) / 100 })}
              className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              Y: {Math.round(pos.y * 100)}%
            </label>
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round(pos.y * 100)}
              onChange={(e) => updateOverlayPos({ y: parseInt(e.target.value) / 100 })}
              className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
        </div>
      </div>

      {/* Width */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">
          Width: {Math.round(pos.width * 100)}%
        </label>
        <input
          type="range" min={10} max={100} step={1}
          value={Math.round(pos.width * 100)}
          onChange={(e) => updateOverlayPos({ width: parseInt(e.target.value) / 100 })}
          className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
        />
      </div>

      {/* Opacity */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">
          Opacity: {Math.round(opacity * 100)}%
        </label>
        <input
          type="range" min={0} max={100} step={1}
          value={Math.round(opacity * 100)}
          onChange={(e) => updateClip(reelId, clip.id, { opacity: parseInt(e.target.value) / 100 })}
          className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
        />
      </div>

      {/* File info */}
      <div className="text-[10px] text-muted-foreground">
        <span>{clip.originalName}</span>
      </div>
    </div>
  );
}

/* ── Main timeline view layout ──────────────────────────────────────── */
/*
  ┌──────────────────────────────────────────────────────────────┐
  │  [preview 9:16]  │  Timeline tracks                          │
  │  (180px wide)    │  controls + ruler + tracks + playhead     │
  ├──────────────────┴──────────────────────────────────────────┤
  │  Subtitles (50%)     │  Style preview + settings (50%)      │
  └──────────────────────┴──────────────────────────────────────┘
*/

export function ReelTimelineView({ reelId, videoSrc, audioSrc, audioOffsetMs }: ReelTimelineViewProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const selectedClipIds = useReelStore((s) => s.selectedClipIds);
  const setReelBackgroundColor = useReelStore((s) => s.setReelBackgroundColor);

  if (!reel) return null;

  const firstSelectedId = selectedClipIds[0] ?? null;
  const selectedClip = firstSelectedId
    ? reel.composition.clips.find((c) => c.id === firstSelectedId)
    : null;
  const showTextPanel = selectedClip?.type === 'text';
  const showImagePanel = selectedClip?.type === 'image' || selectedClip?.type === 'gif';
  const showVideoPanel = selectedClip?.type === 'video';
  // Audio panel shows for any audio clip (export-as-WAV works for all); the
  // volume/fade controls inside are limited to the EXTRA layers (ra2+).
  const showAudioPanel = selectedClip?.type === 'audio';

  return (
    <div className="flex h-full flex-col">
      {/* Hidden video player for canvas capture */}
      <div className="w-0 h-0 overflow-hidden">
        <ReelVideoPlayer reelId={reelId} videoSrc={videoSrc} audioSrc={audioSrc} audioOffsetMs={audioOffsetMs} />
      </div>

      {/* Overlay-template library bar (save reel's overlays / apply templates) */}
      <div className="relative">
        <OverlayTemplatesBar reelId={reelId} />
      </div>

      {/* Screen split in two halves (draggable): TOP = subtitles | preview |
          properties, BOTTOM = the whole timeline — same layout as Compose. */}
      <EditorSplit
        storageKey="reel-split-top-pct"
        top={(
          <div className="flex h-full min-h-0">
            {/* Left: subtitle list */}
            <div className="w-[30%] min-w-[240px] flex-shrink-0 flex flex-col border-r border-border overflow-hidden">
              <SubtitleListEditor reelId={reelId} />
            </div>

            {/* Middle: canvas preview of the 9:16 result */}
            <div className="flex-1 min-w-0 flex flex-col items-center p-2 overflow-hidden">
              <div className="flex w-full justify-center pb-1">
                <CanvasBackgroundPicker
                  value={reel.composition.backgroundColor ?? '#000000'}
                  onChange={(color) => setReelBackgroundColor(reelId, color)}
                />
              </div>
              <div className="flex flex-1 min-h-0 w-full items-center justify-center">
                <TimelineCanvasPreview reelId={reelId} />
              </div>
            </div>

            {/* Right: clip config OR subtitle style.
                ORDER MATTERS: the selected clip's properties go FIRST. The framing
                and mix accordions below are tall (a long keyframe list alone fills
                the column), and with them on top the Motion controls fell off the
                bottom at 100% browser zoom — the user had to zoom the browser out
                to 60% to reach them. */}
            <div className="w-[30%] min-w-[300px] flex-shrink-0 flex flex-col overflow-y-auto border-l border-border">
              {showTextPanel ? (
                <TextClipConfigPanel reelId={reelId} />
              ) : showImagePanel ? (
                <ImageClipConfigPanel reelId={reelId} />
              ) : showVideoPanel ? (
                <VideoClipMotionPanel reelId={reelId} />
              ) : showAudioPanel ? (
                <AudioClipConfigPanel reelId={reelId} />
              ) : null}

              {/* Mesa ducking + ambient boost + animated crop — same tools as the
                  setup phase, reachable while editing the timeline. Collapsed
                  while a clip is selected so its properties stay in view. */}
              <div className="p-2 space-y-2 border-y border-border">
                <CropKeyframesPanel reelId={reelId} collapsed={!!selectedClip} />
                <ReelMixPanels reelId={reelId} />
              </div>

              {!selectedClip && (
                <>
                  {selectedClipIds.length === 0 && reel.subtitleSegments.length > 0 && (
                    <ReelSubtitleSelectionStyle reelId={reelId} />
                  )}
                  <div className="p-3 border-b border-border">
                    <SubtitleStylePreview style={reel.subtitleStyle} />
                  </div>
                  <SubtitleConfigPanel reelId={reelId} />
                </>
              )}
            </div>
          </div>
        )}
        bottom={<ReelTimeline reelId={reelId} />}
      />
    </div>
  );
}

/** Wires the shared selection-style bar to the reel store. Renders nothing
 *  when no subtitles are selected. */
function ReelSubtitleSelectionStyle({ reelId }: { reelId: string }) {
  const selectedSubtitleIds = useReelStore((s) => s.selectedSubtitleIds);
  const styleSelected = useReelStore((s) => s.styleSelectedReelSubtitles);
  if (selectedSubtitleIds.length === 0) return null;
  return (
    <div className="p-3 border-b border-border">
      <SubtitleSelectionStyleBar
        count={selectedSubtitleIds.length}
        onApply={(update) => styleSelected(reelId, update)}
      />
    </div>
  );
}
