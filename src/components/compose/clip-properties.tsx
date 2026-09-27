'use client';

import { useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Trash2, Copy, Clipboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { useComposeStore } from '@/stores/compose-store';
import { ComposeSaveOverlayTemplateButton, ComposeApplyOverlayTemplateButton } from './compose-overlay-template-controls';
import { ClipGainPanel } from '@/components/shared/clip-gain-panel';
import { ExportAudioClipButton } from '@/components/audio/export-audio-clip-button';
import { copyMotionTransform, getMotionTransform, hasMotionTransform } from '@/lib/motion-clipboard';
import { formatDuration } from '@/lib/utils';
import { FONT_FAMILIES } from '@/config/fonts';
import type { CompositionClip } from '@/types/project';

// Label + slider + editable number input, all in the SAME natural unit (e.g.
// percent, degrees) — no separate preformatted display string needed.
function MotionRow({
  label, unit, min, max, step, value, onChange,
}: {
  label: string; unit: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-10">{label}</span>
      <Slider
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={min} max={max} step={step}
        className="flex-1"
      />
      <input
        type="number"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="w-14 h-6 rounded border border-border bg-background px-1 text-right font-mono text-[10px]"
      />
      <span className="w-3 text-[9px] text-muted-foreground">{unit}</span>
    </div>
  );
}

export function ClipProperties() {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const selectedClipIds = useComposeStore((s) => s.selectedClipIds);
  const clips = useComposeStore((s) => s.clips);
  const updateClip = useComposeStore((s) => s.updateClip);
  // 50 ms buckets: the panel only needs the playhead to place a new zone, and
  // the raw value would re-render this whole panel 60 times a second.
  const playheadMs = useComposeStore((s) => Math.round(s.currentTimeMs / 50) * 50);
  const removeClip = useComposeStore((s) => s.removeClip);
  const saveSnapshot = useComposeStore((s) => s.saveSnapshot);

  const clip = selectedClipIds.length > 0 ? clips.find((c) => c.id === selectedClipIds[0]) : null;

  const [editingText, setEditingText] = useState(false);
  const [textValue, setTextValue] = useState('');
  const [canPasteMotion, setCanPasteMotion] = useState(() => hasMotionTransform());

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

      {/* Apply / save template buttons for text overlays */}
      {isTextClip && (
        <div className="flex justify-end gap-1">
          <ComposeApplyOverlayTemplateButton clip={clip} />
          <ComposeSaveOverlayTemplateButton clip={clip} />
        </div>
      )}

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
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">Font</label>
            <select
              className="w-full bg-muted/30 border border-border rounded px-2 py-1 text-xs outline-none"
              value={clip.textStyle?.fontFamily ?? 'Inter'}
              onChange={(e) => {
                updateClip(clip.id, {
                  textStyle: { ...clip.textStyle!, fontFamily: e.target.value },
                });
              }}
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
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
          <div>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              Weight: {clip.textStyle?.fontWeight ?? 700}
            </label>
            <input
              type="range" min={100} max={900} step={100}
              value={clip.textStyle?.fontWeight ?? 700}
              onChange={(e) => {
                updateClip(clip.id, {
                  textStyle: { ...clip.textStyle!, fontWeight: parseInt(e.target.value) },
                });
              }}
              className="w-full h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
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

      {/* Motion: zoom, position & rotation for video/image clips (Premiere-style) */}
      {clip.type !== 'audio' && clip.type !== 'text' && (() => {
        const t = clip.transform ?? { scale: 1, x: 0, y: 0, rotation: 0 };
        const patchTransform = (updates: Partial<{ scale: number; x: number; y: number; rotation: number }>) => {
          updateClip(clip.id, {
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
          if (!copied) return;
          saveSnapshot();
          // Applies to every selected clip (not just this one) so a multi-
          // select paste gives them all the same zoom/position/angle in one go.
          const targets = selectedClipIds.length > 0 ? selectedClipIds : [clip.id];
          for (const id of targets) {
            const target = clips.find((c) => c.id === id);
            if (!target || target.type === 'audio' || target.type === 'text') continue;
            updateClip(id, { transform: { ...copied } });
          }
        };
        return (
          <div className="space-y-2 border-t border-border pt-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-muted-foreground font-medium">Motion (zoom / posición / ángulo)</label>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost" size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={handleCopyMotion}
                  title="Copiar zoom/posición/ángulo de este clip"
                >
                  <Copy className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost" size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={handlePasteMotion}
                  disabled={!canPasteMotion}
                  title="Pegar en el/los clip(s) seleccionado(s)"
                >
                  <Clipboard className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    saveSnapshot();
                    updateClip(clip.id, { transform: { scale: 1, x: 0, y: 0, rotation: 0 } });
                  }}
                  title="Reset motion to default"
                >
                  Reset
                </Button>
              </div>
            </div>

            <MotionRow label="Zoom" unit="%" min={10} max={400} step={1}
              value={Math.round((t.scale ?? 1) * 100)}
              onChange={(v) => patchTransform({ scale: v / 100 })}
            />
            <MotionRow label="Pos X" unit="%" min={-100} max={100} step={1}
              value={Math.round((t.x ?? 0) * 100)}
              onChange={(v) => patchTransform({ x: v / 100 })}
            />
            <MotionRow label="Pos Y" unit="%" min={-100} max={100} step={1}
              value={Math.round((t.y ?? 0) * 100)}
              onChange={(v) => patchTransform({ y: v / 100 })}
            />
            <MotionRow label="Ángulo" unit="°" min={-180} max={180} step={0.1}
              value={Math.round((t.rotation ?? 0) * 10) / 10}
              onChange={(v) => patchTransform({ rotation: v })}
            />

            <p className="text-[9px] text-muted-foreground italic leading-tight">
              Tip: para enderezar un plano torcido, gira el ángulo y sube un poco el zoom para que no aparezcan esquinas negras. Para zooms distintos en distintos momentos, divide el clip (S).
            </p>
          </div>
        );
      })()}

      {/* Transition into the NEXT adjacent video clip on this track (export via
          FFmpeg xfade with handle pre-roll; the live preview shows a cut).
          Mirrors the reels VideoClipMotionPanel section. */}
      {clip.type === 'video' && (() => {
        const nextAdjacent = clips.find(
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
                updateClip(clip.id, {
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
            {trans && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-14">Duración</span>
                <Slider
                  value={[trans.durationMs]}
                  onValueChange={([v]) => updateClip(clip.id, { transitionAfter: { ...trans, durationMs: Math.round(v) } })}
                  min={100} max={2000} step={50}
                  className="flex-1"
                />
                <span className="text-[10px] text-foreground w-12 text-right font-mono">{trans.durationMs}ms</span>
              </div>
            )}
            {trans && (
              <p className="text-[9px] text-muted-foreground italic leading-tight">
                Se renderiza en el export (el preview muestra un corte). Usa material previo al punto de entrada del clip siguiente, así la duración total no cambia.
              </p>
            )}
          </div>
        );
      })()}

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

      {/* Fade-in for EXTRA audio clips (a2+). Mirrors the reels editor
          (AudioClipConfigPanel): applied live by compose-preview and on export
          by renderReelVideo (afade=t=in). Not offered for the main a1 track. */}
      {clip.type === 'audio' && clip.trackId !== 'a1' && (() => {
        const clipDurMs = Math.max(0, clip.timelineEndMs - clip.timelineStartMs);
        const fadeMs = clip.fadeInMs ?? 0;
        const fadeMax = Math.min(10000, Math.max(200, clipDurMs));
        const curve = clip.fadeInCurve ?? 'linear';
        return (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-muted-foreground">Fade-in</label>
              {fadeMs > 0 && (
                <button
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => updateClip(clip.id, { fadeInMs: 0 })}
                  title="Quitar fundido"
                >
                  Quitar
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Slider
                value={[Math.min(fadeMs, fadeMax)]}
                onValueChange={([v]) => updateClip(clip.id, { fadeInMs: Math.round(v) })}
                min={0} max={fadeMax} step={50}
                className="flex-1"
              />
              <span className="text-[10px] text-foreground w-10 text-right font-mono">
                {fadeMs >= 1000 ? `${(fadeMs / 1000).toFixed(1)}s` : `${fadeMs}ms`}
              </span>
            </div>
            <select
              className="w-full h-6 rounded border border-border bg-background px-1 text-[10px] outline-none disabled:opacity-50"
              value={curve}
              disabled={fadeMs === 0}
              onChange={(e) => updateClip(clip.id, { fadeInCurve: e.target.value as NonNullable<CompositionClip['fadeInCurve']> })}
              title="Forma de la curva de fundido de entrada"
            >
              <option value="linear">Lineal</option>
              <option value="exponential">Exponencial (suave al inicio)</option>
              <option value="logarithmic">Logarítmica (sube rápido)</option>
              <option value="quarter-sine">Cuarto de seno (muy suave)</option>
            </select>
            <p className="text-[9px] text-muted-foreground italic leading-tight">
              Capa de audio extra: se suma al audio principal. Usa el fade-in para que entre suave.
            </p>
          </div>
        );
      })()}

      {/* Volume zones — every audio clip, main track included. */}
      {clip.type === 'audio' && (
        <div className="border-t border-border pt-2">
          <ClipGainPanel
            clip={clip}
            playheadMs={playheadMs}
            projectId={projectId}
            onChange={(regions) => {
              useComposeStore.getState().saveSnapshot();
              updateClip(clip.id, { gainRegions: regions });
            }}
          />
        </div>
      )}

      {/* Export the clip's audio slice as WAV for external editing */}
      {clip.type === 'audio' && clip.fileName && (
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
