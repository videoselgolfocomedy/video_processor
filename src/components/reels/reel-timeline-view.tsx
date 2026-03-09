'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { useReelStore } from '@/stores/reel-store';
import { ReelVideoPlayer } from './reel-video-player';
import { ReelSubtitleBox } from './reel-subtitle-box';
import { ReelTimeline } from './reel-timeline';
import { SubtitleStyleEditor } from '@/components/subtitles/subtitle-style-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Scissors, Trash2 } from 'lucide-react';
import { splitLongSegments } from '@/lib/subtitle-utils';
import { formatTimestamp } from '@/lib/utils';
import { getReelVideoElement } from './reel-video-ref';
import type { SubtitleStyle } from '@/types/project';

interface ReelTimelineViewProps {
  reelId: string;
  videoSrc?: string;
  audioSrc?: string;
}

/* ── Small 9:16 canvas preview ──────────────────────────────────────── */

function TimelineCanvasPreview({ reelId }: { reelId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const [canvasDims, setCanvasDims] = useState({ width: 0, height: 0 });

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
          <ReelSubtitleBox
            reelId={reelId}
            canvasWidth={canvasDims.width}
            canvasHeight={canvasDims.height}
          />
        )}
      </div>
    </div>
  );
}

/* ── Subtitle list editor ───────────────────────────────────────────── */

function SubtitleListEditor({ reelId }: { reelId: string }) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const updateReelSubtitleSegment = useReelStore((s) => s.updateReelSubtitleSegment);
  const deleteSubtitleSegment = useReelStore((s) => s.deleteSubtitleSegment);
  const selectedSubtitleId = useReelStore((s) => s.selectedSubtitleId);
  const selectSubtitle = useReelStore((s) => s.selectSubtitle);
  const setCurrentTime = useReelStore((s) => s.setCurrentTime);

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
          const isSelected = selectedSubtitleId === seg.id;

          return (
            <div
              key={seg.id}
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
                onChange={(e) => updateReelSubtitleSegment(reelId, seg.id, { text: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    // Shift+Enter or just Enter both insert newline (textarea default)
                    // Don't propagate to prevent other shortcuts
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
          >
            <RefreshCw className="mr-1 h-3 w-3" /> Regen
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

/* ── Main timeline view layout ──────────────────────────────────────── */
/*
  ┌──────────────────────────────────────────────────────────────┐
  │  [preview 9:16]  │  Timeline tracks                          │
  │  (180px wide)    │  controls + ruler + tracks + playhead     │
  ├──────────────────┴──────────────────────────────────────────┤
  │  Subtitles (50%)     │  Style preview + settings (50%)      │
  └──────────────────────┴──────────────────────────────────────┘
*/

export function ReelTimelineView({ reelId, videoSrc, audioSrc }: ReelTimelineViewProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  if (!reel) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Hidden video player for canvas capture */}
      <div className="w-0 h-0 overflow-hidden">
        <ReelVideoPlayer reelId={reelId} videoSrc={videoSrc} audioSrc={audioSrc} />
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

      {/* Bottom row: subtitles (50%) | style preview + settings (50%) */}
      <div className="flex flex-1 min-h-0 border-t border-border">
        {/* Left: subtitle list */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-border">
          <SubtitleListEditor reelId={reelId} />
        </div>

        {/* Right: style preview + settings */}
        <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
          <div className="p-3 border-b border-border">
            <SubtitleStylePreview style={reel.subtitleStyle} />
          </div>
          <SubtitleConfigPanel reelId={reelId} />
        </div>
      </div>
    </div>
  );
}
