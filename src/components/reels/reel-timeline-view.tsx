'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useReelStore } from '@/stores/reel-store';
import { OverlayTemplatesBar, SaveOverlayAsTemplateButton } from './overlay-template-controls';
import { ReelVideoPlayer } from './reel-video-player';
import { ReelSubtitleBox } from './reel-subtitle-box';
import { ReelTimeline } from './reel-timeline';
import { SubtitleStyleEditor } from '@/components/subtitles/subtitle-style-editor';
import { useCustomPresets } from '@/hooks/use-custom-presets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Scissors, Trash2, Bold, Frame } from 'lucide-react';
import { splitLongSegments } from '@/lib/subtitle-utils';
import { formatTimestamp } from '@/lib/utils';
import { getReelVideoElement } from './reel-video-ref';
import type { SubtitleStyle, SubtitleWord } from '@/types/project';

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

      const currentReel = useReelStore.getState().reels.find((r) => r.id === reelId);
      const crop = currentReel?.cropRegion ?? reel.cropRegion;

      const cropPixH = srcH * crop.scale;
      const cropPixW = cropPixH * (9 / 16);
      const sx = crop.centerX * srcW - cropPixW / 2;
      const sy = crop.centerY * srcH - cropPixH / 2;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        video,
        Math.max(0, sx), Math.max(0, sy), cropPixW, cropPixH,
        0, 0, canvas.width, canvas.height
      );

      if (isPlaying) {
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
      <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border sticky top-0 bg-card z-10">
        Subtitles ({reel.subtitleSegments.length})
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
    const { maxCharsPerBlock, maxDurationMs } = reel.subtitleConstraints;
    const split = splitLongSegments(reel.subtitleSegments, maxCharsPerBlock, maxDurationMs);
    updateReel(reelId, { subtitleSegments: split });
  }, [reel, reelId, updateReel]);

  if (!reel) return null;

  const constraints = reel.subtitleConstraints;
  const violations = reel.subtitleSegments.filter(
    (s) => s.text.length > constraints.maxCharsPerBlock || (s.endMs - s.startMs) > constraints.maxDurationMs
  ).length;

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

const FONT_FAMILIES = [
  // Display / condensed faces — both bundled in fonts/ for FFmpeg ASS render
  // and loaded via Google Fonts in layout.tsx for browser preview.
  'Bebas Neue', 'Anton',
  'Inter', 'Arial', 'Helvetica Neue', 'Helvetica', 'Georgia', 'Times New Roman',
  'Courier New', 'Verdana', 'Impact', 'Comic Sans MS',
  'Trebuchet MS', 'Palatino', 'Garamond', 'Bookman',
  'Futura', 'Gill Sans', 'Lucida Grande', 'Lucida Console',
  'Optima', 'Avenir', 'Avenir Next', 'Didot',
  'American Typewriter', 'Rockwell', 'Copperplate',
  'Menlo', 'Monaco', 'SF Pro Display', 'SF Pro Text',
  'Baskerville', 'Cochin', 'Hoefler Text',
];

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
        <SaveOverlayAsTemplateButton clip={clip} />
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
  const firstSelectedId = useReelStore((s) => s.selectedClipIds[0] ?? null);
  const updateClip = useReelStore((s) => s.updateClip);

  const clip = reel?.composition.clips.find((c) => c.id === firstSelectedId);
  if (!clip || clip.type !== 'video') return null;

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

  const row = (label: string, value: string, min: number, max: number, step: number, sliderVal: number, onChange: (v: number) => void) => (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-12">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={sliderVal}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
      <span className="text-[10px] text-foreground w-12 text-right font-mono">{value}</span>
    </div>
  );

  return (
    <div className="overflow-y-auto p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-purple-400">Motion (zoom / posición / ángulo)</h3>
        <button
          className="text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => updateClip(reelId, clip.id, { transform: { scale: 1, x: 0, y: 0, rotation: 0 } })}
          title="Reset motion"
        >
          Reset
        </button>
      </div>
      {row('Zoom', `${Math.round((t.scale ?? 1) * 100)}%`, 10, 400, 1, Math.round((t.scale ?? 1) * 100), (v) => patch({ scale: v / 100 }))}
      {row('Pos X', `${Math.round((t.x ?? 0) * 100)}%`, -100, 100, 1, Math.round((t.x ?? 0) * 100), (v) => patch({ x: v / 100 }))}
      {row('Pos Y', `${Math.round((t.y ?? 0) * 100)}%`, -100, 100, 1, Math.round((t.y ?? 0) * 100), (v) => patch({ y: v / 100 }))}
      {row('Ángulo', `${(t.rotation ?? 0).toFixed(1)}°`, -150, 150, 1, Math.round((t.rotation ?? 0) * 10), (v) => patch({ rotation: v / 10 }))}
      <p className="text-[9px] text-muted-foreground italic leading-tight">
        Tip: para enderezar un plano torcido, gira el ángulo y sube un poco el zoom para que no aparezcan esquinas negras. Para valores distintos por momento, divide el clip (S).
      </p>
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

  if (!reel) return null;

  const firstSelectedId = selectedClipIds[0] ?? null;
  const selectedClip = firstSelectedId
    ? reel.composition.clips.find((c) => c.id === firstSelectedId)
    : null;
  const showTextPanel = selectedClip?.type === 'text';
  const showImagePanel = selectedClip?.type === 'image' || selectedClip?.type === 'gif';
  const showVideoPanel = selectedClip?.type === 'video';

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

      {/* Top row: preview + timeline */}
      <div className="flex min-h-0" style={{ height: '50%' }}>
        {/* Canvas preview */}
        <div className="w-[180px] flex-shrink-0 border-r border-border p-2 flex items-center justify-center overflow-hidden">
          <TimelineCanvasPreview reelId={reelId} />
        </div>
        {/* Timeline */}
        <div className="flex-1 min-w-0 flex flex-col">
          <ReelTimeline reelId={reelId} />
        </div>
      </div>

      {/* Bottom row: subtitles (50%) | right panel (50%) */}
      <div className="flex flex-1 min-h-0 border-t border-border">
        {/* Left: subtitle list */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-border">
          <SubtitleListEditor reelId={reelId} />
        </div>

        {/* Right: clip config OR subtitle style */}
        <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
          {showTextPanel ? (
            <TextClipConfigPanel reelId={reelId} />
          ) : showImagePanel ? (
            <ImageClipConfigPanel reelId={reelId} />
          ) : showVideoPanel ? (
            <VideoClipMotionPanel reelId={reelId} />
          ) : (
            <>
              <div className="p-3 border-b border-border">
                <SubtitleStylePreview style={reel.subtitleStyle} />
              </div>
              <SubtitleConfigPanel reelId={reelId} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
