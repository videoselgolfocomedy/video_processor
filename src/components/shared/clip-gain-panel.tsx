'use client';

import { useCallback, useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { X, Plus } from 'lucide-react';
import type { ClipGainRegion, CompositionClip } from '@/types/project';

const DB_MIN = -40, DB_MAX = 24, FADE_MAX = 5000;
const DEFAULT_NEW_MS = 800;
const FACTORY: { db: number; fadeInMs: number; fadeOutMs: number; shape: 'linear' | 'curve' } = { db: -12, fadeInMs: 250, fadeOutMs: 400, shape: 'linear' };

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

function Num({ value, min, max, title, className, onCommit }: {
  value: number; min: number; max: number; title: string; className?: string; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = parseFloat(draft);
    if (!Number.isFinite(n)) { setDraft(String(value)); return; }
    const v = Math.min(max, Math.max(min, Math.round(n)));
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number" min={min} max={max} value={draft} title={title}
      className={`h-6 rounded border border-border bg-background px-1 text-[10px] tabular-nums outline-none focus:border-primary ${className ?? ''}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/**
 * "Zonas de volumen" for ANY audio clip, in both editors: a list of zones with
 * their own dB, ramps and shape over the clip's own timeline, plus a button
 * that drops one at the playhead. Zone times are the clip's FILE clock (like
 * sourceInMs) but shown relative to the clip's start, which is what the user
 * sees on the timeline. The preview applies them live and the export renders
 * the identical curve (clip-gain.ts ↔ buildDuckVolumeExpr).
 *
 * `playheadMs` is the editor's playhead on the timeline; `onChange` persists
 * the new array (one undo entry per call in both stores).
 */
export function ClipGainPanel({ clip, playheadMs, projectId, onChange }: {
  clip: CompositionClip;
  playheadMs: number;
  projectId?: string;
  onChange: (regions: ClipGainRegion[]) => void;
}) {
  const key = `clip-gain-defaults:${projectId ?? 'x'}`;
  const [defaults, setDefaults] = useState(FACTORY);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(key);
      if (v) setDefaults({ ...FACTORY, ...JSON.parse(v) });
    } catch { /* storage unavailable */ }
  }, [key]);
  const rememberDefaults = useCallback((patch: Partial<typeof FACTORY>) => {
    setDefaults((prev) => {
      const next = { ...prev, ...patch };
      try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [key]);

  const regions = [...(clip.gainRegions ?? [])].sort((a, b) => a.startMs - b.startMs);
  const clipStart = clip.sourceInMs ?? 0;
  const clipEnd = clip.sourceOutMs ?? clipStart;

  const patch = (id: string, p: Partial<ClipGainRegion>) => {
    onChange(regions.map((r) => (r.id === id ? { ...r, ...p } : r)));
    if (p.db != null) rememberDefaults({ db: p.db });
    if (p.fadeInMs != null) rememberDefaults({ fadeInMs: p.fadeInMs });
    if (p.fadeOutMs != null) rememberDefaults({ fadeOutMs: p.fadeOutMs });
    if (p.fadeShape) rememberDefaults({ shape: p.fadeShape });
  };

  const addAtPlayhead = () => {
    // The playhead's position inside the clip, mapped to the file clock. Out of
    // range (playhead elsewhere) → drop the zone at the clip's start instead of
    // creating one nobody can see.
    const inClip = playheadMs >= clip.timelineStartMs && playheadMs < clip.timelineEndMs;
    const start = inClip ? clipStart + (playheadMs - clip.timelineStartMs) : clipStart;
    const end = Math.min(clipEnd, start + DEFAULT_NEW_MS);
    onChange([...regions, {
      id: uuidv4(),
      startMs: Math.round(start),
      endMs: Math.round(Math.max(start + 100, end)),
      db: defaults.db,
      fadeInMs: defaults.fadeInMs,
      fadeOutMs: defaults.fadeOutMs,
      fadeShape: defaults.shape,
    }].sort((a, b) => a.startMs - b.startMs));
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-[10px] text-muted-foreground" title="Sube o baja el volumen SOLO en un tramo del clip. Se oye en la previa y se exporta igual.">
          Zonas de volumen{regions.length > 0 ? ` (${regions.length})` : ''}
        </label>
        <button
          type="button"
          className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          title="Añade una zona de 0,8 s donde está el cursor (o al principio del clip si el cursor está fuera)"
          onClick={addAtPlayhead}
        >
          <Plus className="h-3 w-3" /> zona
        </button>
      </div>
      {regions.length === 0 && (
        <p className="text-[9px] leading-tight text-muted-foreground">
          Sin zonas: el clip suena a su volumen entero.
        </p>
      )}
      {regions.map((r) => (
        <div key={r.id} className="rounded border border-border/70 p-1">
          <div className="flex items-center justify-between text-[9px] text-muted-foreground">
            <span title="Tramo del clip que ocupa la zona">
              {fmt(Math.min(r.startMs, r.endMs) - clipStart)} → {fmt(Math.max(r.startMs, r.endMs) - clipStart)}
            </span>
            <button
              type="button"
              className="rounded p-[1px] hover:bg-destructive/30 hover:text-destructive"
              title="Borrar esta zona"
              onClick={() => onChange(regions.filter((x) => x.id !== r.id))}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-0.5 flex items-center gap-1">
            <Num value={r.db} min={DB_MIN} max={DB_MAX} className="w-11" title="dB: negativo baja, positivo sube" onCommit={(v) => patch(r.id, { db: v })} />
            <span className="text-[9px] text-muted-foreground">dB</span>
            <Num value={r.fadeInMs ?? 0} min={0} max={FADE_MAX} className="w-11" title="Rampa de entrada (ms), fuera de la zona" onCommit={(v) => patch(r.id, { fadeInMs: v })} />
            <Num value={r.fadeOutMs ?? 0} min={0} max={FADE_MAX} className="w-11" title="Rampa de salida (ms), fuera de la zona" onCommit={(v) => patch(r.id, { fadeOutMs: v })} />
            <button
              type="button"
              className="h-6 rounded border border-border bg-background px-1 text-[9px] hover:border-primary"
              title="Forma de las rampas: lineal (recta) o curva (suave al empezar y al acabar)"
              onClick={() => patch(r.id, { fadeShape: r.fadeShape === 'curve' ? 'linear' : 'curve' })}
            >
              {r.fadeShape === 'curve' ? 'curva' : 'lineal'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
