'use client';

import { useState, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { useComposeStore } from '@/stores/compose-store';
import { formatDuration } from '@/lib/utils';

export function ClipProperties() {
  const selectedClipIds = useComposeStore((s) => s.selectedClipIds);
  const clips = useComposeStore((s) => s.clips);
  const updateClip = useComposeStore((s) => s.updateClip);
  const removeClip = useComposeStore((s) => s.removeClip);
  const saveSnapshot = useComposeStore((s) => s.saveSnapshot);

  const clip = selectedClipIds.length > 0 ? clips.find((c) => c.id === selectedClipIds[0]) : null;

  const [editingText, setEditingText] = useState(false);
  const [textValue, setTextValue] = useState('');

  const handleStartEditText = useCallback(() => {
    if (clip?.textContent !== undefined) {
      setTextValue(clip.textContent || '');
      setEditingText(true);
    }
  }, [clip]);

  const handleConfirmText = useCallback(() => {
    if (clip) {
      updateClip(clip.id, { textContent: textValue });
    }
    setEditingText(false);
  }, [clip, textValue, updateClip]);

  if (!clip) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Select a clip to edit properties
      </div>
    );
  }

  const duration = clip.timelineEndMs - clip.timelineStartMs;
  const isTextClip = clip.type === 'text';
  const isImageClip = clip.type === 'image' || clip.type === 'gif';

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground truncate">
          {isTextClip ? (clip.textContent || 'Text') : clip.originalName}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400"
          onClick={() => removeClip(clip.id)}
          title="Delete clip"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Multi-select info */}
      {selectedClipIds.length > 1 && (
        <div className="text-[10px] text-muted-foreground bg-muted/30 rounded px-2 py-1">
          {selectedClipIds.length} clips selected
        </div>
      )}

      {/* Timing info */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
        <span className="text-muted-foreground">Start</span>
        <span className="text-foreground font-mono">{formatDuration(clip.timelineStartMs)}</span>
        <span className="text-muted-foreground">End</span>
        <span className="text-foreground font-mono">{formatDuration(clip.timelineEndMs)}</span>
        <span className="text-muted-foreground">Duration</span>
        <span className="text-foreground font-mono">{formatDuration(duration)}</span>
      </div>

      {/* Text content for text clips */}
      {isTextClip && (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground">Text Content</label>
          {editingText ? (
            <Input
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onBlur={handleConfirmText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmText();
                if (e.key === 'Escape') setEditingText(false);
              }}
              className="h-7 text-xs"
              autoFocus
            />
          ) : (
            <div
              className="rounded border border-border px-2 py-1 text-xs cursor-text hover:bg-muted/30 min-h-[28px]"
              onClick={handleStartEditText}
            >
              {clip.textContent || <span className="text-muted-foreground italic">Click to add text</span>}
            </div>
          )}
        </div>
      )}

      {/* Text style for text clips */}
      {isTextClip && (
        <div className="space-y-2">
          <label className="text-[10px] text-muted-foreground">Text Style</label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] text-muted-foreground mb-0.5">Font Size</label>
              <Input
                type="number" min={8} max={200}
                value={clip.textStyle?.fontSize ?? 48}
                onChange={(e) => {
                  updateClip(clip.id, {
                    textStyle: { ...clip.textStyle!, fontSize: parseInt(e.target.value) || 48 },
                  });
                }}
                className="h-6 text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] text-muted-foreground mb-0.5">Color</label>
              <input
                type="color"
                value={clip.textStyle?.color ?? '#FFFFFF'}
                onChange={(e) => {
                  updateClip(clip.id, {
                    textStyle: { ...clip.textStyle!, color: e.target.value },
                  });
                }}
                className="h-6 w-full rounded border border-border cursor-pointer"
              />
            </div>
          </div>
        </div>
      )}

      {/* Overlay position for image/gif/text clips */}
      {(isImageClip || isTextClip) && (
        <div className="space-y-2">
          <label className="text-[10px] text-muted-foreground">Position & Size</label>
          {(['x', 'y', 'width'] as const).map((prop) => (
            <div key={prop} className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-10 capitalize">{prop}</span>
              <Slider
                value={[Math.round((clip.overlayPosition?.[prop] ?? (prop === 'width' ? 0.8 : 0.5)) * 100)]}
                onValueChange={([v]) => {
                  updateClip(clip.id, {
                    overlayPosition: {
                      x: clip.overlayPosition?.x ?? 0.5,
                      y: clip.overlayPosition?.y ?? 0.5,
                      width: clip.overlayPosition?.width ?? 0.8,
                      [prop]: v / 100,
                    },
                  });
                }}
                min={0} max={100} step={1}
                className="flex-1"
              />
              <span className="text-[10px] text-foreground w-8 text-right font-mono">
                {Math.round((clip.overlayPosition?.[prop] ?? (prop === 'width' ? 0.8 : 0.5)) * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Mode selector for video/image clips */}
      {clip.type !== 'audio' && clip.type !== 'text' && (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground">Mode</label>
          <div className="flex gap-1">
            {(['cutaway', 'overlay'] as const).map((mode) => (
              <button
                key={mode}
                className={`flex-1 rounded px-2 py-1 text-[10px] capitalize border ${
                  clip.mode === mode
                    ? 'bg-primary/20 border-primary text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => {
                  saveSnapshot();
                  updateClip(clip.id, {
                    mode,
                    overlay:
                      mode === 'overlay' && !clip.overlay
                        ? { x: 0.6, y: 0.6, width: 0.35, height: 0.35 }
                        : clip.overlay,
                  });
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Overlay position for video overlay mode */}
      {clip.type !== 'audio' && clip.type !== 'text' && clip.mode === 'overlay' && clip.overlay && (
        <div className="space-y-2">
          <label className="text-[10px] text-muted-foreground">Overlay Position</label>
          {(['x', 'y', 'width', 'height'] as const).map((prop) => (
            <div key={prop} className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-10 capitalize">{prop}</span>
              <Slider
                value={[Math.round((clip.overlay?.[prop] ?? 0) * 100)]}
                onValueChange={([v]) => {
                  updateClip(clip.id, {
                    overlay: { ...clip.overlay!, [prop]: v / 100 },
                  });
                }}
                min={0} max={100} step={1}
                className="flex-1"
              />
              <span className="text-[10px] text-foreground w-8 text-right font-mono">
                {Math.round((clip.overlay?.[prop] ?? 0) * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Opacity for video/image */}
      {clip.type !== 'audio' && (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground">Opacity</label>
          <div className="flex items-center gap-2">
            <Slider
              value={[Math.round((clip.opacity ?? 1) * 100)]}
              onValueChange={([v]) => updateClip(clip.id, { opacity: v / 100 })}
              min={0} max={100} step={1}
              className="flex-1"
            />
            <span className="text-[10px] text-foreground w-8 text-right font-mono">
              {Math.round((clip.opacity ?? 1) * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* Volume for audio clips */}
      {clip.type === 'audio' && (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground">Volume</label>
          <div className="flex items-center gap-2">
            <Slider
              value={[Math.round((clip.volume ?? 1) * 100)]}
              onValueChange={([v]) => updateClip(clip.id, { volume: v / 100 })}
              min={0} max={200} step={1}
              className="flex-1"
            />
            <span className="text-[10px] text-foreground w-8 text-right font-mono">
              {Math.round((clip.volume ?? 1) * 100)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
