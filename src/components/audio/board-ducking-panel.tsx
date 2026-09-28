'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Search, Wand2, Trash2, ZoomIn, ZoomOut, Play, Sparkles, Crosshair } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { BoardDuckRegion } from '@/types/project';

interface FillersData {
  envelope: number[];
  hop_ms: number;
  duration_s: number;
  sample_rate?: number;
  regions?: Array<{
    id: string; start_ms: number; end_ms: number; type: 'jeje' | 'eehh'; confidence: number;
    // Optional descriptors from the v2 detector (why it was proposed).
    pulses?: number; period_ms?: number; level_below_ctx_db?: number;
  }>;
}

/** Short human "why" for a detector proposal. */
function proposalDetail(p: { pulses?: number; period_ms?: number; level_below_ctx_db?: number }): string | undefined {
  const bits: string[] = [];
  if (p.pulses != null) bits.push(`${p.pulses} pulsos`);
  if (p.period_ms != null) bits.push(`cada ${Math.round(p.period_ms)} ms`);
  if (p.level_below_ctx_db != null) bits.push(`${p.level_below_ctx_db.toFixed(0)} dB bajo la voz`);
  return bits.length ? bits.join(' · ') : undefined;
}

/**
 * Source-agnostic editor for board (mesa) ducking regions — used by BOTH the
 * parts flow (per part) and the single-pair /audio-prep flow. The caller wires
 * the board audio URL, the fillers JSON URL, the detection endpoint, and how
 * regions are persisted / applied (parts re-mix immediately; single-pair just
 * saves and the next Mix Preview picks the regions up).
 */
interface BoardDuckingPanelProps {
  projectId: string;
  boardUrl: string;
  fillersUrl: string;
  detectUrl: string;
  initialRegions: BoardDuckRegion[];
  boardTrimMs: number;
  /** End of the stretch of this file the mix actually uses (ms in the file's
   *  own clock). Absent = until the file ends. With a video range the mesa is
   *  the whole night and the part only a piece of it: detector proposals
   *  outside [boardTrimMs, usedEndMs] are dropped and the tail is shaded. */
  usedEndMs?: number;
  durationMsFallback?: number;
  disabled?: boolean;
  onSave: (regions: BoardDuckRegion[]) => Promise<boolean>;
  applyLabel: string;
  applyHint: string;
  onApplied?: () => void | Promise<void>;
  /** When embedded in Compose/Reels: returns the board-stem time (ms) matching
   *  the video editor's current playhead, so the board waveform can jump there.
   *  Enables the "Ir al playhead del vídeo" button. */
  getEditorBoardMs?: () => number | null;
  /** 'duck' (default): attenuate mesa filler regions, with detection tools.
   *  'boost': raise the AMBIENT in marked regions (positive dB) with a
   *  configurable fade-in/out pattern — laughs swell smoothly, no detection
   *  tools, waveform loads from the envelope route via fillersUrl. */
  mode?: 'duck' | 'boost';
  /** Authoritative waveform source (the /audio/envelope route). When given,
   *  the wave/duration ALWAYS come from here — the fillers JSON only
   *  contributes detection proposals. Without it, a stale/truncated fillers
   *  file (detection ran on an older or shorter audio) draws a wave shorter
   *  than the real file, and seeking past its end blanked the canvas. */
  envelopeUrl?: string;
}

const DEFAULT_ATTEN_DB = -18;

const SRC_COLOR: Record<BoardDuckRegion['source'], string> = {
  manual: '#22c55e', // green
  jeje: '#f59e0b',   // amber
  eehh: '#a855f7',   // violet
};
const SRC_LABEL: Record<BoardDuckRegion['source'], string> = {
  manual: 'Manual',
  jeje: 'je-je',
  eehh: 'eehh',
};

function fmt(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

/* ── Region list (memoized so the per-frame playhead follow doesn't re-render
   dozens of rows during playback) ─────────────────────────────────────── */
interface RegionListProps {
  regions: BoardDuckRegion[];
  selectedId: string | null;
  disabled?: boolean;
  mode?: 'duck' | 'boost';
  onToggle: (id: string, enabled: boolean) => void;
  onAtten: (id: string, db: number) => void;
  onFade?: (id: string, which: 'in' | 'out', ms: number) => void;
  onSelectSeek: (id: string, ms: number) => void;
  onSeek: (ms: number) => void;
  onDelete: (id: string) => void;
}
const RegionList = ({ regions, selectedId, disabled, mode, onToggle, onAtten, onFade, onSelectSeek, onSeek, onDelete }: RegionListProps) => {
  if (regions.length === 0) {
    return (
      <p className="px-1 text-[11px] text-muted-foreground">
        {mode === 'boost'
          ? 'Sin zonas. Arrastra sobre la onda para marcar el tramo donde subir el ambiente (risas).'
          : 'Sin zonas. Arrastra sobre la onda para marcar una, o pulsa "Detectar rellenos".'}
      </p>
    );
  }
  return (
    <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-1">
      {regions.map((r) => (
        <div
          key={r.id}
          data-region-id={r.id}
          className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1.5 py-1 text-xs ${r.id === selectedId ? 'bg-primary/15 ring-1 ring-primary/40' : ''}`}
        >
          {/* ✓ / ✗ — the review verdict. Both persist: ✓ = attenuated AND a
              positive example, ✗ = kept intact AND a negative example for
              "Buscar parecidos". A proposal with neither is PENDING. */}
          {mode !== 'boost' ? (
            <span className="flex flex-none items-center gap-0.5" title="✓ sí es je-je/relleno (se atenúa y enseña al detector) · ✗ no lo es (queda intacto y el detector lo evita) · sin marcar = por revisar (no enseña nada)">
              <button
                onClick={() => onToggle(r.id, true)} disabled={disabled}
                className={`h-5 w-6 rounded text-[11px] font-bold ${r.enabled ? 'bg-emerald-500/30 text-emerald-300' : 'bg-secondary text-muted-foreground hover:text-emerald-300'}`}
              >✓</button>
              <button
                onClick={() => onToggle(r.id, false)} disabled={disabled}
                className={`h-5 w-6 rounded text-[11px] font-bold ${!r.enabled && r.rejected ? 'bg-red-500/25 text-red-300' : 'bg-secondary text-muted-foreground hover:text-red-300'}`}
              >✗</button>
              {!r.enabled && !r.rejected && r.source !== 'manual' && (
                <span className="ml-0.5 rounded bg-amber-500/15 px-1 text-[9px] text-amber-300" title="Propuesta del detector sin revisar">por revisar</span>
              )}
            </span>
          ) : (
            <input
              type="checkbox" checked={r.enabled}
              onChange={(e) => onToggle(r.id, e.target.checked)}
              disabled={disabled}
              className="flex-none"
              title={r.enabled ? 'Activa' : 'Desactivada'}
            />
          )}
          <span
            className="inline-block h-2.5 w-2.5 flex-none rounded-sm"
            style={{ backgroundColor: SRC_COLOR[r.source] }}
            title={SRC_LABEL[r.source]}
          />
          <span className="w-10 flex-none text-[10px] text-muted-foreground">{SRC_LABEL[r.source]}</span>
          <button className="flex-none font-mono hover:text-primary" onClick={() => onSelectSeek(r.id, r.startMs)} title="Escuchar esta zona (con medio segundo antes y después)">
            {fmt(r.startMs)}–{fmt(r.endMs)}
          </button>
          <span className="flex-none text-[10px] text-muted-foreground">({((r.endMs - r.startMs) / 1000).toFixed(1)}s)</span>
          {r.confidence != null && (
            <span className="flex-none rounded bg-secondary px-1 text-[9px] text-muted-foreground" title="Confianza del detector">
              {Math.round(r.confidence * 100)}%
            </span>
          )}
          {r.detail && (
            <span className="flex-none text-[9px] text-muted-foreground/80">{r.detail}</span>
          )}
          {/* Right cluster — flex-none so it never gets squeezed off-screen. */}
          <div className="ml-auto flex flex-none items-center gap-1">
            <Input
              type="number" step={1} value={r.attenuationDb}
              onChange={(e) => onAtten(r.id, Number(e.target.value))}
              disabled={disabled}
              className="h-6 w-16 px-1 text-center text-[11px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              title={mode === 'boost' ? 'dB de ganancia (positivo = sube el ambiente aquí)' : 'dB de atenuación (negativo = baja la mesa aquí)'}
            />
            <span className="text-[10px] text-muted-foreground">dB</span>
            {mode === 'boost' && onFade && (
              <>
                <Input
                  type="number" step={50} min={0} value={r.fadeInMs ?? 250}
                  onChange={(e) => onFade(r.id, 'in', Math.max(0, Number(e.target.value)))}
                  disabled={disabled}
                  className="h-6 w-14 px-1 text-center text-[11px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  title="Fade-in (ms)"
                />
                <Input
                  type="number" step={50} min={0} value={r.fadeOutMs ?? 400}
                  onChange={(e) => onFade(r.id, 'out', Math.max(0, Number(e.target.value)))}
                  disabled={disabled}
                  className="h-6 w-14 px-1 text-center text-[11px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  title="Fade-out (ms)"
                />
                <span className="text-[10px] text-muted-foreground">ms</span>
              </>
            )}
            <button className="text-muted-foreground hover:text-foreground" onClick={() => onSeek(r.startMs)} title="Reproducir desde aquí"><Play className="h-3.5 w-3.5" /></button>
            <button className="text-muted-foreground hover:text-red-400" onClick={() => onDelete(r.id)} disabled={disabled} title="Eliminar"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      ))}
    </div>
  );
};
const MemoRegionList = ({ ...props }: RegionListProps) => useMemo(
  () => <RegionList {...props} />,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [props.regions, props.selectedId, props.disabled]
);

export function BoardDuckingPanel({
  projectId, boardUrl, fillersUrl, detectUrl, initialRegions, boardTrimMs, usedEndMs,
  durationMsFallback = 0, disabled, onSave, applyLabel, applyHint, onApplied, getEditorBoardMs,
  mode = 'duck', envelopeUrl,
}: BoardDuckingPanelProps) {
  void projectId;
  const { toast } = useToast();
  const isBoost = mode === 'boost';

  const [fillers, setFillers] = useState<FillersData | null>(null);
  const [regions, setRegions] = useState<BoardDuckRegion[]>(initialRegions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaultAtten, setDefaultAtten] = useState(String(isBoost ? 6 : DEFAULT_ATTEN_DB));
  // Boost pattern defaults (fade lengths, ms) — persisted so the "quick mark"
  // workflow keeps the user's preferred swell shape across sessions.
  const [defFadeIn, setDefFadeIn] = useState(() =>
    (typeof window !== 'undefined' && window.localStorage.getItem('ambient-boost-fade-in')) || '250');
  const [defFadeOut, setDefFadeOut] = useState(() =>
    (typeof window !== 'undefined' && window.localStorage.getItem('ambient-boost-fade-out')) || '400');
  useEffect(() => { try { window.localStorage.setItem('ambient-boost-fade-in', defFadeIn); } catch { /* ignore */ } }, [defFadeIn]);
  useEffect(() => { try { window.localStorage.setItem('ambient-boost-fade-out', defFadeOut); } catch { /* ignore */ } }, [defFadeOut]);
  const [saving, setSaving] = useState(false);

  const [detectJobId, setDetectJobId] = useState<string | null>(null);
  const [detectProgress, setDetectProgress] = useState<number | null>(null);
  const [detectMsg, setDetectMsg] = useState('');

  const usedEnd = usedEndMs != null && usedEndMs > boardTrimMs ? usedEndMs : Infinity;
  const initialJson = JSON.stringify(initialRegions);
  useEffect(() => {
    // Unreviewed detector proposals outside the used stretch are noise (the
    // mix never plays them); anything the user marked or drew is kept.
    setRegions((JSON.parse(initialJson) as BoardDuckRegion[]).filter((r) =>
      r.source === 'manual' || r.enabled || r.rejected ||
      (r.endMs > boardTrimMs && r.startMs < usedEnd)));
  }, [initialJson, boardTrimMs, usedEnd]);

  const durationMs = useMemo(
    () => (fillers ? fillers.duration_s * 1000 : durationMsFallback),
    [fillers, durationMsFallback]
  );

  // 98th-percentile envelope value for normalization (computed once per JSON).
  const envNorm = useMemo(() => {
    const env = fillers?.envelope;
    if (!env || !env.length) return 1;
    const sorted = [...env].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.98)] || Math.max(...env) || 0.001;
  }, [fillers]);

  const [view, setView] = useState({ startMs: 0, endMs: 0 });
  useEffect(() => {
    if (durationMs > 0 && view.endMs === 0) setView({ startMs: 0, endMs: durationMs });
  }, [durationMs, view.endMs]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [dragBand, setDragBand] = useState<{ a: number; b: number } | null>(null);
  const [audioMs, setAudioMs] = useState(0);
  // Audition auto-stop: when a region row is clicked, playback starts a bit
  // before it and pauses a bit after it (set here, honored by the rAF loop).
  const stopAtMsRef = useRef<number | null>(null);

  // Refs mirroring state so the rAF follow loop + stable callbacks read fresh
  // values without re-subscribing / breaking list memoization.
  const viewRef = useRef(view); useEffect(() => { viewRef.current = view; }, [view]);
  const durationRef = useRef(durationMs); useEffect(() => { durationRef.current = durationMs; }, [durationMs]);
  const regionsRef = useRef(regions); useEffect(() => { regionsRef.current = regions; }, [regions]);

  // --- Load the fillers JSON (proposals) + authoritative envelope ------------
  const loadFillers = useCallback(async () => {
    let fillersData: FillersData | null = null;
    // Some mounts (the ambient-boost panel) pass the SAME envelope endpoint as
    // both fillersUrl and envelopeUrl — skip the duplicate download.
    if (fillersUrl !== envelopeUrl) {
      try {
        const res = await fetch(`${fillersUrl}${fillersUrl.includes('?') ? '&' : '?'}t=${Date.now()}`);
        if (res.ok) fillersData = await res.json();
      } catch { /* fillers absent — fine */ }
    }

    // With an envelopeUrl, the wave/duration come from the REAL audio file —
    // a stale/truncated fillers JSON (detection ran on older/shorter audio)
    // must not shorten the drawn wave or break seeks past its end.
    if (envelopeUrl) {
      try {
        const envRes = await fetch(`${envelopeUrl}${envelopeUrl.includes('?') ? '&' : '?'}t=${Date.now()}`);
        if (envRes.ok) {
          const env = await envRes.json();
          if (env?.envelope?.length) {
            fillersData = {
              ...(fillersData ?? {}),
              envelope: env.envelope,
              hop_ms: env.hop_ms,
              duration_s: env.duration_s,
            } as FillersData;
          }
        }
      } catch { /* fall back to fillers-provided envelope */ }
    }

    if (fillersData) setFillers(fillersData);
    return fillersData;
  }, [fillersUrl, envelopeUrl]);

  useEffect(() => { void loadFillers(); }, [loadFillers]);

  const mergeProposals = useCallback((d: FillersData) => {
    const proposals = d.regions ?? [];
    setRegions((prev) => {
      // Keep ALL existing regions — your enabled (good) AND disabled (rejected)
      // decisions persist, so "Buscar parecidos" converges: rejected zones don't
      // reappear and taught positives stay. Only add new, non-overlapping candidates.
      const overlapsExisting = (s: number, e: number) =>
        prev.some((k) => Math.min(e, k.endMs) - Math.max(s, k.startMs) > 0);
      const fresh: BoardDuckRegion[] = proposals
        .filter((p) => p.end_ms > boardTrimMs && p.start_ms < usedEnd)
        .filter((p) => !overlapsExisting(p.start_ms, p.end_ms))
        .map((p) => ({
          id: uuidv4(),
          startMs: p.start_ms,
          endMs: p.end_ms,
          attenuationDb: Number(defaultAtten) || DEFAULT_ATTEN_DB,
          source: p.type,
          enabled: false,
          confidence: p.confidence,
          detail: proposalDetail(p),
        }));
      return [...prev, ...fresh].sort((a, b) => a.startMs - b.startMs);
    });
  }, [defaultAtten, boardTrimMs, usedEnd]);

  // --- Detection job ---------------------------------------------------------
  // `learn` = true runs the example-based search: enabled regions are the good
  // examples (positives), disabled ones the rejected examples (negatives).
  const runDetect = useCallback(async (learn = false) => {
    try {
      let init: RequestInit = { method: 'POST' };
      if (learn) {
        const cur = regionsRef.current;
        const positives = cur.filter((r) => r.enabled).map((r) => ({
          start_ms: Math.round(r.startMs), end_ms: Math.round(r.endMs),
          type: r.source === 'eehh' ? 'eehh' : 'jeje',
        }));
        // Only EXPLICIT rejections are negatives — an untouched proposal is
        // pending, not "no" (see BoardDuckRegion.rejected).
        const negatives = cur.filter((r) => !r.enabled && r.rejected === true).map((r) => ({
          start_ms: Math.round(r.startMs), end_ms: Math.round(r.endMs),
        }));
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ examples: { positives, negatives } }),
        };
      }
      const res = await fetch(detectUrl, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `Error ${res.status}`);
      setDetectJobId((data as { jobId: string }).jobId);
      setDetectProgress(0);
      setDetectMsg(learn ? 'Buscando parecidos...' : 'Detectando...');
    } catch (err) {
      toast({ title: 'No se pudo detectar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    }
  }, [detectUrl, toast]);

  // useSSE contract (see use-sse.ts / CLAUDE.md): callbacks MUST be stable —
  // inline arrows recreate the EventSource on EVERY render, and this panel
  // re-renders per rAF tick while audio plays (~60/s).
  const onDetectProgress = useCallback((p: number, m: string) => {
    setDetectProgress(p);
    setDetectMsg(m);
  }, []);
  const onDetectComplete = useCallback(async () => {
    setDetectJobId(null);
    setDetectProgress(null);
    const d = await loadFillers();
    if (d) {
      mergeProposals(d);
      const n = (d.regions ?? []).filter((r) => r.end_ms > boardTrimMs && r.start_ms < usedEnd).length;
      toast({ title: 'Detección lista', description: `${n} zona(s) propuesta(s) — actívalas para atenuarlas.` });
    }
  }, [loadFillers, mergeProposals, boardTrimMs, usedEnd, toast]);
  const onDetectError = useCallback((e: string) => {
    setDetectJobId(null);
    setDetectProgress(null);
    toast({ title: 'Detección falló', description: e, variant: 'destructive' });
  }, [toast]);

  useSSE({
    jobId: detectJobId,
    onProgress: onDetectProgress,
    onComplete: onDetectComplete,
    onError: onDetectError,
  });

  // --- Canvas drawing --------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width: cssW } = canvas.getBoundingClientRect();
    const cssH = 120;
    const dpr = 2;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const vStart = view.startMs;
    const vEnd = view.endMs || durationMs;
    const span = Math.max(1, vEnd - vStart);
    const msPerPx = span / cssW;
    const mid = cssH / 2;
    const base = cssH / 2 - 4;

    const env = fillers?.envelope;
    const hop = fillers?.hop_ms ?? 25;
    if (env && env.length) {
      // Enabled regions → linear gain envelope (incl. per-region fades), so the
      // wave is drawn attenuated (duck) or swelling (boost) exactly as it will
      // sound. Fades sit OUTSIDE the marked range (region = full-gain plateau).
      const ducks = regions
        .filter((r) => r.enabled)
        .map((r) => ({
          s: Math.min(r.startMs, r.endMs),
          e: Math.max(r.startMs, r.endMs),
          g: Math.pow(10, r.attenuationDb / 20),
          ri: Math.max(1, r.fadeInMs ?? 30),
          ro: Math.max(1, r.fadeOutMs ?? 30),
        }));
      const gainAt = (t: number) => {
        let g = 1;
        for (const d of ducks) {
          const w = Math.max(0, Math.min(1, Math.min((t - (d.s - d.ri)) / d.ri, (d.e + d.ro - t) / d.ro)));
          g *= 1 - (1 - d.g) * w;
        }
        return g;
      };
      // Ghost of the REMOVED audio — drawn only where a region ducks, from the
      // attenuated height up to the original height, in a dim red so you can see
      // how much is being cut.
      ctx.strokeStyle = 'rgba(239,68,68,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let px = 0; px < cssW; px++) {
        const t = vStart + px * msPerPx;
        const g = gainAt(t);
        if (g >= 0.999) continue;
        const idx = Math.floor(t / hop);
        if (idx < 0 || idx >= env.length) continue;
        const full = base * Math.min(env[idx] / envNorm, 1);
        const kept = full * g;
        ctx.moveTo(px, mid - full); ctx.lineTo(px, mid - kept);
        ctx.moveTo(px, mid + kept); ctx.lineTo(px, mid + full);
      }
      ctx.stroke();
      // Solid wave, gain applied inside enabled regions (dips when ducking,
      // rises when boosting — clamped to the lane height).
      ctx.strokeStyle = '#94a3b8';
      ctx.beginPath();
      for (let px = 0; px < cssW; px++) {
        const t = vStart + px * msPerPx;
        const idx = Math.floor(t / hop);
        if (idx < 0 || idx >= env.length) continue;
        const amp = Math.min(base, base * Math.min(env[idx] / envNorm, 1) * gainAt(t));
        ctx.moveTo(px, mid - amp);
        ctx.lineTo(px, mid + amp);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        isBoost ? 'Cargando onda del ambiente…' : 'Pulsa "Detectar rellenos" para ver la onda de la mesa',
        cssW / 2, mid,
      );
      ctx.textAlign = 'left';
    }

    // Shade the trimmed-away board head ([0, boardTrimMs]).
    if (boardTrimMs > vStart) {
      const x2 = (Math.min(boardTrimMs, vEnd) - vStart) / msPerPx;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, x2, cssH);
      ctx.strokeStyle = 'rgba(148,163,184,0.5)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x2, 0);
      ctx.lineTo(x2, cssH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (x2 > 60) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px sans-serif';
        ctx.fillText('no usado (recortado)', 4, 12);
      }
    }
    // …and the tail past the end of the used stretch.
    if (usedEnd < vEnd) {
      const x1 = Math.max(0, (usedEnd - vStart) / msPerPx);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x1, 0, cssW - x1, cssH);
      ctx.strokeStyle = 'rgba(148,163,184,0.5)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, cssH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (cssW - x1 > 120) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px sans-serif';
        ctx.fillText('no usado (recortado)', x1 + 4, 12);
      }
    }

    // Region bands
    for (const r of regions) {
      if (r.endMs < vStart || r.startMs > vEnd) continue;
      const x1 = (r.startMs - vStart) / msPerPx;
      const x2 = (r.endMs - vStart) / msPerPx;
      const color = SRC_COLOR[r.source];
      ctx.fillStyle = color + (r.enabled ? '30' : '12');
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), cssH);
      ctx.strokeStyle = color + (r.enabled ? 'cc' : '55');
      ctx.lineWidth = r.id === selectedId ? 2 : 1;
      ctx.strokeRect(x1, 0.5, Math.max(1, x2 - x1), cssH - 1);
    }

    // Drag-in-progress band
    if (dragBand) {
      const x1 = (Math.min(dragBand.a, dragBand.b) - vStart) / msPerPx;
      const x2 = (Math.max(dragBand.a, dragBand.b) - vStart) / msPerPx;
      ctx.fillStyle = '#22c55e44';
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), cssH);
    }

    // Playhead
    if (audioMs >= vStart && audioMs <= vEnd) {
      const x = (audioMs - vStart) / msPerPx;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }
  }, [view, durationMs, fillers, envNorm, regions, selectedId, dragBand, audioMs, boardTrimMs, usedEnd, isBoost]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  // Update the playhead on paused seeks (while playing, the rAF loop below drives it).
  // Advance the playhead AND auto-scroll the (zoomed) view to follow it. A rAF
  // loop runs while playing (smooth 60fps); 'seeked'/'timeupdate' cover paused
  // scrubbing. Reads view/duration via refs so it never re-subscribes.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    let raf = 0;
    const sync = () => {
      const ms = a.currentTime * 1000;
      setAudioMs(ms);
      const stopAt = stopAtMsRef.current;
      if (stopAt != null && ms >= stopAt && !a.paused) {
        stopAtMsRef.current = null;
        a.pause();
      }
      const v = viewRef.current;
      const dur = durationRef.current;
      const span = (v.endMs || dur) - v.startMs;
      if (dur > 0 && span < dur - 1) {
        // Keep the playhead ~40% from the left edge of the zoomed view.
        let start = ms - span * 0.4;
        start = Math.max(0, Math.min(Math.max(0, dur - span), start));
        if (Math.abs(start - v.startMs) > span * 0.004) setView({ startMs: start, endMs: start + span });
      }
    };
    const loop = () => { if (!a.paused) { sync(); raf = requestAnimationFrame(loop); } };
    const onPlay = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); };
    const onStop = () => cancelAnimationFrame(raf);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onStop);
    a.addEventListener('ended', onStop);
    a.addEventListener('seeked', sync);
    a.addEventListener('timeupdate', () => { if (a.paused) sync(); });
    return () => {
      cancelAnimationFrame(raf);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onStop);
      a.removeEventListener('ended', onStop);
      a.removeEventListener('seeked', sync);
    };
  }, []);

  const pxToMs = useCallback((clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = viewRef.current;
    const dur = durationRef.current;
    return v.startMs + frac * ((v.endMs || dur) - v.startMs);
  }, []);

  // Drag on the canvas creates a new manual region; a tiny drag = click (select/seek).
  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    const startMs = pxToMs(e.clientX);
    const onMove = (ev: MouseEvent) => setDragBand({ a: startMs, b: pxToMs(ev.clientX) });
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setDragBand(null);
      const endMs = pxToMs(ev.clientX);
      const a = Math.min(startMs, endMs);
      const b = Math.max(startMs, endMs);
      if (b - a < 120) {
        const hit = regionsRef.current.find((r) => a >= r.startMs && a <= r.endMs);
        setSelectedId(hit ? hit.id : null);
        if (audioRef.current) audioRef.current.currentTime = a / 1000;
        setAudioMs(a);
        return;
      }
      const nr: BoardDuckRegion = {
        id: uuidv4(), startMs: Math.round(a), endMs: Math.round(b),
        attenuationDb: Number(defaultAtten) || (isBoost ? 6 : DEFAULT_ATTEN_DB),
        source: 'manual', enabled: true,
        // Boost regions carry the configured swell pattern.
        ...(isBoost ? { fadeInMs: Math.max(0, Number(defFadeIn) || 250), fadeOutMs: Math.max(0, Number(defFadeOut) || 400) } : {}),
      };
      setRegions((prev) => [...prev, nr].sort((x, y) => x.startMs - y.startMs));
      setSelectedId(nr.id);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [disabled, pxToMs, defaultAtten, isBoost, defFadeIn, defFadeOut]);

  // --- Stable region-list callbacks (keep MemoRegionList from re-rendering) ---
  // ✓ → enabled (and clears any rejection); ✗ → disabled AND rejected.
  const onToggle = useCallback((id: string, enabled: boolean) =>
    setRegions((prev) => prev.map((r) => (r.id === id ? { ...r, enabled, rejected: !enabled } : r))), []);
  const onAtten = useCallback((id: string, db: number) =>
    setRegions((prev) => prev.map((r) => (r.id === id ? { ...r, attenuationDb: db } : r))), []);
  const onFade = useCallback((id: string, which: 'in' | 'out', ms: number) =>
    setRegions((prev) => prev.map((r) => (r.id === id
      ? { ...r, ...(which === 'in' ? { fadeInMs: ms } : { fadeOutMs: ms }) }
      : r))), []);
  const onDelete = useCallback((id: string) =>
    setRegions((prev) => prev.filter((r) => r.id !== id)), []);
  const seekTo = useCallback((ms: number) => {
    const dur = durationRef.current;
    // Clamp to the drawable range — seeking past the envelope's end used to
    // produce an inverted view (start > end) that blanked the whole canvas.
    const target = Math.max(0, dur > 0 ? Math.min(ms, dur) : ms);
    if (audioRef.current) audioRef.current.currentTime = target / 1000;
    setAudioMs(target);
    const v = viewRef.current;
    const vEnd = v.endMs || dur;
    if (target < v.startMs || target > vEnd) {
      const span = Math.max(1000, vEnd - v.startMs);
      let start = target - span / 2;
      if (dur > 0) start = Math.min(Math.max(0, dur - span), start);
      start = Math.max(0, start);
      setView({ startMs: start, endMs: start + span });
    }
  }, []);
  // Row click = AUDITION: select, jump 500 ms before the zone, play, and stop
  // 500 ms after it — so you can go down the list deciding ✓/✗ by ear.
  const AUDITION_PAD_MS = 500;
  const auditionRegion = useCallback((id: string) => {
    const r = regionsRef.current.find((x) => x.id === id);
    if (!r) return;
    setSelectedId(id);
    const from = Math.max(0, r.startMs - AUDITION_PAD_MS);
    stopAtMsRef.current = r.endMs + AUDITION_PAD_MS;
    seekTo(from);
    const a = audioRef.current;
    if (a) { a.currentTime = from / 1000; void a.play().catch(() => {}); }
  }, [seekTo]);
  const onSelectSeek = useCallback((id: string) => auditionRegion(id), [auditionRegion]);

  // Keyboard review on the panel: ↑/↓ move, Space/Enter re-listen, Y/S/J = ✓,
  // N = ✗ (both then advance to the next row), Delete/Backspace removes the
  // selected zone. Scoped to the panel container (it must have focus) so the
  // editor's own shortcuts are untouched; ignored while typing in an input.
  const onListKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'AUDIO' || tag === 'SELECT') return;
    const list = regionsRef.current;
    if (list.length === 0) return;
    const idx = list.findIndex((r) => r.id === selectedId);
    if ((e.key === 'Delete' || e.key === 'Backspace') && idx >= 0) {
      e.preventDefault();
      onDelete(list[idx].id);
      setSelectedId(null);
      return;
    }
    const go = (i: number) => {
      const next = list[Math.max(0, Math.min(list.length - 1, i))];
      if (next) {
        auditionRegion(next.id);
        document.querySelector(`[data-region-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    const k = e.key.toLowerCase();
    if (k === 'arrowdown') { e.preventDefault(); go(idx + 1); }
    else if (k === 'arrowup') { e.preventDefault(); go(idx - 1); }
    else if ((k === ' ' || k === 'enter') && idx >= 0) { e.preventDefault(); auditionRegion(list[idx].id); }
    else if ((k === 'y' || k === 's' || k === 'j') && idx >= 0) { e.preventDefault(); onToggle(list[idx].id, true); go(idx + 1); }
    else if (k === 'n' && idx >= 0) { e.preventDefault(); onToggle(list[idx].id, false); go(idx + 1); }
  }, [selectedId, auditionRegion, onToggle, onDelete]);

  // --- Zoom / pan ------------------------------------------------------------
  const zoom = (factor: number) => {
    if (durationMs <= 0) return;
    const vEnd = view.endMs || durationMs;
    // Anchor the zoom on the PLAYHEAD when it's visible (so zooming in/out
    // keeps the position you're working on centered); fall back to the view
    // center otherwise.
    const anchor = audioMs >= view.startMs && audioMs <= vEnd
      ? audioMs
      : (view.startMs + vEnd) / 2;
    const span = Math.max(1000, Math.min(durationMs, (vEnd - view.startMs) * factor));
    let start = anchor - span / 2;
    start = Math.max(0, Math.min(durationMs - span, start));
    setView({ startMs: start, endMs: start + span });
  };
  const pan = (fracOfDuration: number) => {
    const vEnd = view.endMs || durationMs;
    const span = vEnd - view.startMs;
    const start = Math.max(0, Math.min(durationMs - span, fracOfDuration * durationMs));
    setView({ startMs: start, endMs: start + span });
  };

  // --- Save + apply ----------------------------------------------------------
  const apply = useCallback(async () => {
    setSaving(true);
    try {
      const ok = await onSave(regions);
      if (ok) await onApplied?.();
    } finally {
      setSaving(false);
    }
  }, [onSave, regions, onApplied]);

  const enabledCount = regions.filter((r) => r.enabled).length;
  const detecting = detectJobId !== null;
  const span = (view.endMs || durationMs) - view.startMs;
  const panFrac = durationMs > 0 ? view.startMs / durationMs : 0;
  const zoomed = durationMs > 0 && span < durationMs - 1;

  return (
    <div className="space-y-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {!isBoost && (
          <>
            <Button size="sm" variant="outline" onClick={() => runDetect(false)} disabled={disabled || detecting} className="h-8 gap-1.5">
              {detecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              Detectar rellenos
            </Button>
            <Button
              size="sm" variant="outline" onClick={() => runDetect(true)}
              disabled={disabled || detecting || enabledCount === 0}
              className="h-8 gap-1.5"
              title={enabledCount === 0
                ? 'Activa primero al menos una zona buena (y deja desactivadas las malas) para enseñar al detector'
                : 'Busca zonas parecidas a las activas (buenas) y distintas de las desactivadas (malas)'}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Buscar parecidos
            </Button>
          </>
        )}
        {getEditorBoardMs && (
          <Button
            size="sm" variant="outline" disabled={disabled}
            onClick={() => { const b = getEditorBoardMs(); if (b != null) seekTo(b); }}
            className="h-8 gap-1.5"
            title="Lleva la onda de la mesa al momento donde está el vídeo, para marcar ahí el je-je/ehh que estás oyendo"
          >
            <Crosshair className="h-3.5 w-3.5" />
            Ir al playhead del vídeo
          </Button>
        )}
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">{isBoost ? 'Ganancia' : 'Atenuación'}</span>
          <Input
            type="number" step={1} value={defaultAtten}
            onChange={(e) => setDefaultAtten(e.target.value)}
            className="h-8 w-16 text-xs"
            title={isBoost
              ? 'dB de ganancia por defecto para nuevas zonas (positivo = sube el ambiente)'
              : 'dB de atenuación por defecto para nuevas regiones (negativo = baja)'}
          />
          <span className="text-[11px] text-muted-foreground">dB</span>
        </div>
        {isBoost && (
          <div className="flex items-center gap-1" title="Patrón de fundido para nuevas zonas: la ganancia entra en rampa ANTES del inicio y sale en rampa DESPUÉS del fin — el tramo marcado queda a ganancia plena (evita el efecto risa enlatada)">
            <span className="text-[11px] text-muted-foreground">Fade</span>
            <Input
              type="number" step={50} min={0} value={defFadeIn}
              onChange={(e) => setDefFadeIn(e.target.value)}
              className="h-8 w-16 text-xs" title="Fade-in (ms)"
            />
            <span className="text-[11px] text-muted-foreground">/</span>
            <Input
              type="number" step={50} min={0} value={defFadeOut}
              onChange={(e) => setDefFadeOut(e.target.value)}
              className="h-8 w-16 text-xs" title="Fade-out (ms)"
            />
            <span className="text-[11px] text-muted-foreground">ms</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => zoom(0.5)} disabled={disabled} className="h-8 w-8 p-0" title="Zoom +"><ZoomIn className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={() => zoom(2)} disabled={disabled} className="h-8 w-8 p-0" title="Zoom -"><ZoomOut className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setView({ startMs: 0, endMs: durationMs })} disabled={disabled} className="h-8 px-2 text-[11px]" title="Ver todo">Todo</Button>
        </div>
      </div>

      {detecting && detectProgress !== null && (
        <div className="space-y-1">
          <Progress value={detectProgress} className="h-1.5" />
          <p className="text-[11px] text-muted-foreground">{detectMsg}</p>
        </div>
      )}

      {/* Waveform + regions (keyboard review + delete work while this block has focus) */}
      <div tabIndex={0} onKeyDown={onListKeyDown} className="relative rounded-md outline-none focus:ring-1 focus:ring-primary/40">
        <canvas
          ref={canvasRef}
          onMouseDown={onCanvasMouseDown}
          className="w-full cursor-crosshair rounded-md bg-secondary"
          style={{ height: 120 }}
          title="Arrastra para marcar una zona a atenuar · clic en una zona para seleccionarla (✕ la borra, Supr también) · la onda baja en las zonas activas"
        />
        {/* Delete button pinned to the SELECTED zone on the wave itself. */}
        {(() => {
          const sel = selectedId ? regions.find((r) => r.id === selectedId) : undefined;
          if (!sel || disabled) return null;
          const vEnd = view.endMs || durationMs;
          const spanMs = Math.max(1, vEnd - view.startMs);
          const cw = canvasRef.current?.getBoundingClientRect().width ?? 0;
          if (cw <= 0 || sel.endMs < view.startMs || sel.startMs > vEnd) return null;
          const xEnd = ((Math.min(sel.endMs, vEnd) - view.startMs) / spanMs) * cw;
          const left = Math.max(0, Math.min(cw - 92, xEnd - 92));
          return (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDelete(sel.id); setSelectedId(null); }}
              className="absolute top-1 z-10 flex h-6 items-center gap-1 rounded bg-red-600/85 px-1.5 text-[10px] font-medium text-white shadow hover:bg-red-500"
              style={{ left }}
              title="Borrar esta zona (también con Supr)"
            >
              <Trash2 className="h-3 w-3" /> borrar zona
            </button>
          );
        })()}
      </div>
      {zoomed && (
        <input
          type="range" min={0} max={1000}
          value={Math.round(panFrac * 1000)}
          onChange={(e) => pan(Number(e.target.value) / 1000)}
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          title="Desplazar"
        />
      )}

      {/* Native audio for scrub/preview of the board stem */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={boardUrl} controls preload="none" className="h-8 w-full" />

      {!isBoost && regions.length > 0 && (
        <p className="text-[10px] leading-tight text-muted-foreground">
          <strong>Revisión:</strong> pincha una zona para oírla (½ s antes y después) y marca
          <span className="text-emerald-300"> ✓ es je-je</span> o <span className="text-red-300">✗ no</span>.
          Con la lista enfocada: ↑/↓ siguiente, espacio = repetir, <kbd>S</kbd> = ✓, <kbd>N</kbd> = ✗, <kbd>Supr</kbd> = borrar.
          Las ✓ se atenúan y son los ejemplos buenos de «Buscar parecidos»; las ✗ quedan intactas y el detector aprende a evitarlas;
          lo no marcado no enseña nada.
          {' '}{regions.filter((r) => r.source !== 'manual' && !r.enabled && !r.rejected).length} propuesta(s) por revisar
          {' · '}{regions.filter((r) => !r.enabled && r.rejected).length} rechazada(s).
        </p>
      )}
      <div tabIndex={0} onKeyDown={onListKeyDown} className="rounded-md outline-none focus:ring-1 focus:ring-primary/40">
        <MemoRegionList
          regions={regions}
          selectedId={selectedId}
          disabled={disabled}
          mode={mode}
          onToggle={onToggle}
          onAtten={onAtten}
          onFade={onFade}
          onSelectSeek={onSelectSeek}
          onSeek={seekTo}
          onDelete={onDelete}
        />
      </div>

      {/* Apply */}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={apply} disabled={disabled || saving} className="h-8 gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          {applyLabel}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {enabledCount} zona(s) activa(s) de {regions.length}. {applyHint}
        </span>
      </div>
    </div>
  );
}
