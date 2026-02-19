'use client';

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { useComposeStore } from '@/stores/compose-store';
import { formatDuration } from '@/lib/utils';

export function ClipProperties() {
  const selectedClipId = useComposeStore((s) => s.selectedClipId);
  const clips = useComposeStore((s) => s.clips);
  const updateClip = useComposeStore((s) => s.updateClip);
  const removeClip = useComposeStore((s) => s.removeClip);
  const pushUndo = useComposeStore((s) => s.pushUndo);

  const clip = clips.find((c) => c.id === selectedClipId);

  if (!clip) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Select a clip to edit properties
      </div>
    );
  }

  const duration = clip.timelineEndMs - clip.timelineStartMs;

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground truncate">{clip.originalName}</span>
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

      {/* Timing info */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
        <span className="text-muted-foreground">Start</span>
        <span className="text-foreground font-mono">{formatDuration(clip.timelineStartMs)}</span>
        <span className="text-muted-foreground">End</span>
        <span className="text-foreground font-mono">{formatDuration(clip.timelineEndMs)}</span>
        <span className="text-muted-foreground">Duration</span>
        <span className="text-foreground font-mono">{formatDuration(duration)}</span>
      </div>

      {/* Mode selector for video/image clips */}
      {clip.type !== 'audio' && (
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
                  pushUndo();
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

      {/* Overlay position */}
      {clip.type !== 'audio' && clip.mode === 'overlay' && clip.overlay && (
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
                min={0}
                max={100}
                step={1}
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
              min={0}
              max={100}
              step={1}
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
              min={0}
              max={200}
              step={1}
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
