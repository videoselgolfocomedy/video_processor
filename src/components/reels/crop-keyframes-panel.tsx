'use client';

import { useState } from 'react';
import { useReelStore } from '@/stores/reel-store';
import { Button } from '@/components/ui/button';
import { minAnimatedCropScale } from '@/lib/crop-keyframes';
import type { CropRegion } from '@/types/project';
import { Diamond, Trash2, RotateCcw } from 'lucide-react';

function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** Slider + numeric box for one crop value. */
function ValueRow({
  label, value, min, max, step, unit, onStart, onChange, nudge,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onStart: () => void;
  onChange: (v: number) => void;
  nudge?: [string, string];
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-1">
      <label className="w-9 shrink-0 text-[10px] text-muted-foreground">{label}</label>
      {nudge && (
        <button
          className="rounded bg-secondary px-1 text-[10px] leading-4 text-muted-foreground hover:text-primary"
          onClick={() => { onStart(); onChange(Math.max(min, value - 1)); }}
          title={`${label} −1${unit}`}
        >{nudge[0]}</button>
      )}
      <input
        type="range"
        min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))}
        onPointerDown={onStart}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
      {nudge && (
        <button
          className="rounded bg-secondary px-1 text-[10px] leading-4 text-muted-foreground hover:text-primary"
          onClick={() => { onStart(); onChange(Math.min(max, value + 1)); }}
          title={`${label} +1${unit}`}
        >{nudge[1]}</button>
      )}
      {/* Typed values are held in a local draft and only applied once they are
          in range (and clamped on blur) — clamping every keystroke turned
          "250" into 100 → 316 as the digits arrived. */}
      <input
        type="number"
        min={min} max={max}
        value={draft ?? String(Math.round(value))}
        onFocus={(e) => { setDraft(String(Math.round(value))); e.target.select(); onStart(); }}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v) && v >= min && v <= max) onChange(v);
        }}
        onBlur={() => {
          const v = parseFloat(draft ?? '');
          if (!Number.isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
          setDraft(null);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="h-5 w-11 shrink-0 rounded border border-border bg-background px-1 text-right font-mono text-[10px]"
      />
      <span className="w-2 shrink-0 text-[9px] text-muted-foreground">{unit}</span>
    </div>
  );
}

/** Zoom / Pos X / Pos Y controls for one crop value set. */
function CropControls({
  crop, maxZoomPct, onStart, onApply, onReset,
}: {
  crop: CropRegion;
  maxZoomPct: number;
  onStart: () => void;
  onApply: (u: Partial<CropRegion>) => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-1 rounded bg-background/60 p-1.5">
      <ValueRow
        label="Zoom" unit="%" min={100} max={maxZoomPct} step={1}
        value={Math.round((1 / crop.scale) * 100)}
        onStart={onStart}
        onChange={(v) => onApply({ scale: 100 / Math.max(100, v) })}
      />
      <ValueRow
        label="Pos X" unit="%" min={0} max={100} step={0.5} nudge={['◀', '▶']}
        value={crop.centerX * 100}
        onStart={onStart}
        onChange={(v) => onApply({ centerX: v / 100 })}
      />
      <ValueRow
        label="Pos Y" unit="%" min={0} max={100} step={0.5} nudge={['▲', '▼']}
        value={crop.centerY * 100}
        onStart={onStart}
        onChange={(v) => onApply({ centerY: v / 100 })}
      />
      <button
        className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-primary"
        onClick={onReset}
        title="Centrar y quitar zoom"
      >
        <RotateCcw className="h-2.5 w-2.5" /> Centrar / quitar zoom
      </button>
    </div>
  );
}

/**
 * "Encuadre y keyframes" — the reel's 9:16 window (zoom + position) and the
 * keyframe track that animates it (manual subject tracking / pans).
 *
 * Editing model, deliberately explicit:
 *   · no keyframes  → the controls edit the STATIC crop for the whole reel.
 *   · keyframes     → EACH ROW carries its own controls; opening a row jumps
 *                     the playhead there and edits THAT keyframe by id.
 *   · playhead not on a keyframe → a "crear aquí" block adds one with the
 *                     interpolated framing (no jump) so you can adjust it.
 * The crop rect in the setup preview can still be dragged; in the timeline
 * phase (canvas preview of the 9:16 result) these controls are the only way.
 */
export function CropKeyframesPanel({ reelId, collapsed }: { reelId: string; collapsed?: boolean }) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const sourceResolution = useReelStore((s) => s.sourceResolution);
  // Rounded to a 50 ms grid IN THE SELECTOR — during playback the raw value
  // changes every rAF tick (~60/s) and this panel re-renders its whole
  // keyframe-row list on each change; only the row-open check (±80ms
  // tolerance) and the "+ Keyframe en m:ss" label read it, both fine at 50ms
  // granularity. addCropKeyframeAtPlayhead reads the store's live value
  // itself, so the actual keyframe time is never affected by this rounding.
  const currentTimeMs = useReelStore((s) => Math.round(s.currentTimeMs / 50) * 50);
  const addKf = useReelStore((s) => s.addCropKeyframeAtPlayhead);
  const updateKf = useReelStore((s) => s.updateCropKeyframe);
  const delKf = useReelStore((s) => s.deleteCropKeyframe);
  const clearKfs = useReelStore((s) => s.clearCropKeyframes);
  const updateCrop = useReelStore((s) => s.updateCropRegion);
  const setCurrentTime = useReelStore((s) => s.setCurrentTime);

  if (!reel) return null;

  const kfs = [...(reel.cropKeyframes ?? [])].sort((a, b) => a.timeMs - b.timeMs);
  const animated = kfs.length > 0;
  const srcW = sourceResolution?.width ?? 1920;
  const srcH = sourceResolution?.height ?? 1080;
  // zoompan (animated export) hard-clamps z ≤ 10 → cap the UI at what the
  // export can reproduce, so preview and render never disagree.
  const maxZoomPct = Math.round(1 / (animated ? minAnimatedCropScale(srcW, srcH) : 0.1) * 100);
  const openRow = kfs.find((k) => Math.abs(k.timeMs - currentTimeMs) <= 80);
  const snapshot = () => useReelStore.getState().saveSnapshot();

  return (
    <details className="rounded-md border border-border" open={animated && !collapsed}>
      <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
        Encuadre y keyframes
        <span className="ml-1.5 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">
          {animated ? `${kfs.length} · animado` : 'fijo'}
        </span>
      </summary>

      <div className="space-y-2 p-2">
        {!animated ? (
          <>
            <p className="text-[10px] leading-tight text-muted-foreground">
              Encuadre <strong>fijo</strong> para todo el reel:
            </p>
            <CropControls
              crop={reel.cropRegion}
              maxZoomPct={maxZoomPct}
              onStart={snapshot}
              onApply={(u) => updateCrop(reelId, u)}
              onReset={() => { snapshot(); updateCrop(reelId, { centerX: 0.5, centerY: 0.5, scale: 1 }); }}
            />
          </>
        ) : (
          <p className="text-[10px] leading-tight text-muted-foreground">
            El encuadre se <strong>anima</strong> entre keyframes. Abre uno para editar su zoom y
            posición; entre dos keyframes el movimiento se interpola solo.
          </p>
        )}

        {/* ── Keyframe list — each row IS its own editor ── */}
        {animated && (
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {kfs.map((k) => {
              const isOpen = openRow?.id === k.id;
              return (
                <div
                  key={k.id}
                  className={`rounded border ${isOpen ? 'border-sky-500/50 bg-sky-500/10' : 'border-transparent bg-secondary/60'}`}
                >
                  <div className="flex items-center gap-2 px-1.5 py-1 text-[11px]">
                    <button
                      className="flex flex-1 items-center gap-2 text-left"
                      onClick={() => setCurrentTime(k.timeMs)}
                      title={isOpen ? 'Editando este keyframe' : 'Abrir para editar (mueve el playhead aquí)'}
                    >
                      <Diamond className={`h-3 w-3 flex-none ${isOpen ? 'fill-sky-300 text-sky-300' : 'text-muted-foreground'}`} />
                      <span className="font-mono">{fmt(k.timeMs)}</span>
                      <span className="text-[10px] text-muted-foreground">
                        zoom {Math.round((1 / k.scale) * 100)}% · x {Math.round(k.centerX * 100)}% · y {Math.round(k.centerY * 100)}%
                      </span>
                    </button>
                    <button
                      className="text-muted-foreground hover:text-red-400"
                      onClick={() => delKf(reelId, k.id)}
                      title="Eliminar keyframe"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {isOpen && (
                    <div className="px-1.5 pb-1.5">
                      <CropControls
                        crop={k}
                        maxZoomPct={maxZoomPct}
                        onStart={snapshot}
                        onApply={(u) => updateKf(reelId, k.id, u)}
                        onReset={() => { snapshot(); updateKf(reelId, k.id, { centerX: 0.5, centerY: 0.5, scale: 1 }); }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Add at the playhead ── */}
        {!openRow && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => addKf(reelId)}>
              <Diamond className="h-3 w-3" />
              ＋ Keyframe en {fmt(currentTimeMs)}
            </Button>
            {animated && (
              <span className="text-[9px] text-muted-foreground">y edítalo en su fila</span>
            )}
          </div>
        )}

        {animated && (
          <div className="flex items-center justify-between">
            <span className="text-[9px] italic text-muted-foreground">
              Zoom máx. {maxZoomPct}% con animación (límite del export).
            </span>
            <Button
              size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-muted-foreground hover:text-red-400"
              onClick={() => { if (window.confirm('¿Quitar todos los keyframes? El encuadre vuelve a ser fijo.')) clearKfs(reelId); }}
            >
              Quitar todos
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}
