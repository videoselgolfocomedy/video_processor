'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { computeLevelStats, continuousGainDb, fmtDelta, gainScale, type LevelStats } from '@/lib/level-stats';

interface EnvelopeData {
  envelope: number[];
  hop_ms: number;
  duration_s: number;
}

/**
 * One audio track: name + amplitude waveform + player + LEVEL READOUT, for the
 * part card's signal-chain view (raw vs PROCESSED stems). The envelope
 * endpoint returns ABSOLUTE amplitude (|peak|/32768 per 25 ms hop), so a raw
 * track and its processed twin drawn at the same scale show exactly the
 * applied gain — "ver las curvas con los dB aplicados". The readout puts
 * numbers on it: room floor, typical voice, loud voice and peak in dBFS, and
 * with a `behind` reference the origin→result deltas. Click the waveform to
 * seek; zoom (+/−/Todo) and the pan slider work like the je-je editor, and
 * while playing the zoomed view follows the playhead.
 */
export function TrackRow({
  projectId,
  label,
  fileName,
  color = '#60a5fa',
  refreshKey,
  missingHint,
  behind,
  chainLabel,
  onStats,
  height = 72,
  kind,
  producedAt,
  sublabel,
  warning,
}: {
  projectId: string;
  label: string;
  fileName: string;
  color?: string;
  /** Changes when the file may have been rewritten (e.g. part status). */
  refreshKey?: string;
  missingHint?: string;
  /** Reference envelope drawn DIMMED behind the main one, at the same
   *  absolute scale — e.g. the RAW track behind its PROCESSED version, so
   *  ducks/boosts read as valleys/peaks against the gray. offsetSec maps the
   *  main track's t=0 into the reference file (alignment trim + preview
   *  window start). */
  behind?: { fileName: string; offsetSec: number };
  /** What the chain applied to produce THIS file — shown under the label so
   *  the wave you see and play is never ambiguous. */
  chainLabel?: string;
  /** Reports the measured level stats of this file (null while loading). */
  onStats?: (stats: LevelStats | null) => void;
  /** Canvas height in CSS px. */
  height?: number;
  /** WHAT this player plays — rendered as a colored chip so no waveform is
   *  ever ambiguous: the recording as-is, a processed stem, a 30 s preview,
   *  or the real mix. */
  kind?: 'original' | 'processed' | 'preview' | 'mix';
  /** ISO time the file was produced ("generada 12:03"). */
  producedAt?: string;
  /** One-line plain description of what is (and is NOT) in this signal. */
  sublabel?: string;
  /** Amber warning line (e.g. settings changed since this was made). */
  warning?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [env, setEnv] = useState<EnvelopeData | null>(null);
  const [behindEnv, setBehindEnv] = useState<EnvelopeData | null>(null);
  const [missing, setMissing] = useState(false);
  const [posMs, setPosMs] = useState(0);
  // Zoom window in track ms; null = whole file.
  const [view, setView] = useState<{ startMs: number; endMs: number } | null>(null);

  const fileUrl = `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(fileName)}&v=${encodeURIComponent(refreshKey ?? '')}`;

  // The `behind` prop arrives as an inline object literal (fresh identity per
  // parent render) — effects must depend on these primitives, never on the
  // object, or the full waveform redraws on every parent render (e.g. every
  // SSE progress event during a mix).
  const behindFileName = behind?.fileName;
  const behindOffsetSec = behind?.offsetSec;

  useEffect(() => {
    let dead = false;
    setEnv(null);
    setMissing(false);
    setView(null);
    fetch(`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(fileName)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => { if (!dead) setEnv(d); })
      .catch(() => { if (!dead) setMissing(true); });
    return () => { dead = true; };
  }, [projectId, fileName, refreshKey]);

  useEffect(() => {
    let dead = false;
    setBehindEnv(null);
    if (!behindFileName) return;
    fetch(`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(behindFileName)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => { if (!dead) setBehindEnv(d); })
      .catch(() => { /* reference is optional — just skip the overlay */ });
    return () => { dead = true; };
  }, [projectId, behindFileName, refreshKey]);

  // Level readouts (dBFS). The reference is measured over the SAME window the
  // main file covers, so origin→result compares like with like.
  const stats = useMemo(() => (env ? computeLevelStats(env.envelope) : null), [env]);
  const behindStats = useMemo(() => {
    if (!env || !behindEnv || behindOffsetSec == null || behindEnv.hop_ms <= 0) return null;
    const b0 = Math.floor((behindOffsetSec * 1000) / behindEnv.hop_ms);
    const bn = Math.max(1, Math.floor((env.duration_s * 1000) / behindEnv.hop_ms));
    return computeLevelStats(behindEnv.envelope, b0, b0 + bn);
  }, [env, behindEnv, behindOffsetSec]);
  useEffect(() => { onStats?.(stats); }, [stats, onStats]);

  const durationMs = env ? env.duration_s * 1000 : 0;
  const vStart = view?.startMs ?? 0;
  const vEnd = view?.endMs ?? durationMs;
  const spanMs = Math.max(1, vEnd - vStart);
  const zoomed = view != null && durationMs > 0 && spanMs < durationMs - 1;

  // Draw waveform over the current view. Absolute scale (0..1 == full scale)
  // so raw and processed rows are directly comparable; dB guides labeled.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !env) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    ctx.font = '9px sans-serif';
    for (const db of [0, -6, -12, -24]) {
      const a = Math.pow(10, db / 20);
      ctx.strokeStyle = db === 0 ? 'rgba(148,163,184,0.35)' : 'rgba(148,163,184,0.15)';
      ctx.beginPath();
      ctx.moveTo(0, mid - a * mid); ctx.lineTo(w, mid - a * mid);
      ctx.moveTo(0, mid + a * mid); ctx.lineTo(w, mid + a * mid);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.7)';
      ctx.fillText(`${db} dB`, 2, Math.max(9, mid - a * mid - 1));
    }
    const hop = env.hop_ms > 0 ? env.hop_ms : 25;
    const i0 = Math.max(0, Math.floor(vStart / hop));
    const i1 = Math.min(env.envelope.length, Math.ceil(vEnd / hop));
    const n = Math.max(1, i1 - i0);
    // Reference (raw) envelope behind, same window & absolute scale.
    if (behindOffsetSec != null && behindEnv && behindEnv.hop_ms > 0) {
      const bh = behindEnv.hop_ms;
      const b0 = Math.floor((behindOffsetSec * 1000 + vStart) / bh);
      const bn = Math.max(1, Math.floor(spanMs / bh));
      const bStep = Math.max(1, Math.floor(bn / w));
      ctx.fillStyle = 'rgba(148,163,184,0.45)';
      for (let x = 0; x < w; x++) {
        const j0 = b0 + Math.floor((x / w) * bn);
        let peak = 0;
        for (let i = j0; i < Math.min(behindEnv.envelope.length, j0 + bStep); i++) {
          peak = Math.max(peak, behindEnv.envelope[i] ?? 0);
        }
        const y = Math.max(1, peak * mid);
        ctx.fillRect(x, mid - y, 1, y * 2);
      }
    }
    ctx.fillStyle = color;
    const step = Math.max(1, Math.floor(n / w));
    const procPeak = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const j0 = i0 + Math.floor((x / w) * n);
      let peak = 0;
      for (let i = j0; i < Math.min(i1, j0 + step); i++) peak = Math.max(peak, env.envelope[i]);
      procPeak[x] = peak;
      const y = Math.max(1, peak * mid);
      ctx.fillRect(x, mid - y, 1, y * 2);
    }
    // APPLIED GAIN line (amber), the same read-out the editing timeline draws
    // on the stem tracks: 20·log10(processed ÷ original) per column over the
    // peaks, CONTINUOUS (it holds its value through digital silence instead of
    // breaking — see continuousGainDb), on a −36…+24 dB scale with a dotted
    // 0 dB. It makes a duck/attenuation read as a dip and a
    // raise as a bump even when the two waveforms look alike.
    if (behindOffsetSec != null && behindEnv && behindEnv.hop_ms > 0) {
      const bh = behindEnv.hop_ms;
      const b0 = Math.floor((behindOffsetSec * 1000 + vStart) / bh);
      const bn = Math.max(1, Math.floor(spanMs / bh));
      const bStep = Math.max(1, Math.floor(bn / w));
      const origPeak = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        const j0 = b0 + Math.floor((x / w) * bn);
        let orig = 0;
        for (let i = Math.max(0, j0); i < Math.min(behindEnv.envelope.length, j0 + bStep); i++) orig = Math.max(orig, behindEnv.envelope[i] ?? 0);
        origPeak[x] = orig;
      }
      const appliedDb = continuousGainDb(origPeak, procPeak);
      const { lo: LO, hi: HI } = gainScale(appliedDb, -36, 24);
      const yOf = (db: number) => h - 1 - ((Math.max(LO, Math.min(HI, db)) - LO) / (HI - LO)) * (h - 2);
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(251,191,36,0.35)';
      ctx.beginPath(); ctx.moveTo(0, yOf(0)); ctx.lineTo(w, yOf(0)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(251,191,36,0.9)';
      ctx.lineWidth = 1.2;
      if (appliedDb) {
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const y = yOf(appliedDb[x]);
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(251,191,36,0.8)';
      ctx.fillText(`+${HI}`, w - 20, yOf(HI) + 9);
      ctx.fillText(`−${Math.abs(LO)}`, w - 20, yOf(LO) - 2);
      ctx.fillText('0 dB gan.', w - 42, yOf(0) - 2);
    }
    // Playhead is a separate absolutely-positioned div (below), NOT drawn
    // here — audio playback fires onTimeUpdate ~4Hz; redrawing the whole
    // envelope per tick just to move a 1.5px line was a measured hotspot.
  }, [env, behindEnv, behindOffsetSec, color, height, vStart, vEnd, spanMs]);

  // Zoom / pan — same feel as the je-je editor: anchored on the playhead when
  // it is in view, min window 1 s, "Todo" resets.
  // FUNCTIONAL updates: two quick clicks used to apply only ONE step because
  // both handlers captured the same stale `view` (React batches the renders) —
  // that read as "el zoom no va" on a 27-min file. Step is 4× so a long set
  // reaches a readable window in 3 clicks instead of 10.
  const zoom = useCallback((factor: number) => {
    setView((prev) => {
      if (durationMs <= 0) return prev;
      const curStart = prev?.startMs ?? 0;
      const curEnd = prev?.endMs ?? durationMs;
      const anchor = posMs >= curStart && posMs <= curEnd ? posMs : (curStart + curEnd) / 2;
      const span = Math.max(1000, Math.min(durationMs, (curEnd - curStart) * factor));
      if (span >= durationMs - 1) return null;
      let start = anchor - span / 2;
      start = Math.max(0, Math.min(durationMs - span, start));
      return { startMs: start, endMs: start + span };
    });
  }, [durationMs, posMs]);
  const pan = useCallback((fracOfDuration: number) => {
    setView((prev) => {
      if (!prev || durationMs <= 0) return prev;
      const span = prev.endMs - prev.startMs;
      const start = Math.max(0, Math.min(durationMs - span, fracOfDuration * durationMs));
      return { startMs: start, endMs: start + span };
    });
  }, [durationMs]);

  if (missing) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-44 shrink-0 text-[10px] text-muted-foreground">{label}</span>
        <span className="text-[10px] italic text-muted-foreground">
          {missingHint ?? 'aún no generada'}
        </span>
      </div>
    );
  }

  const f0 = (v: number) => v.toFixed(0);
  const KIND: Record<NonNullable<typeof kind>, { text: string; cls: string }> = {
    original: { text: 'ORIGINAL', cls: 'bg-slate-500/25 text-slate-300' },
    processed: { text: 'PROCESADA', cls: 'bg-emerald-500/20 text-emerald-300' },
    preview: { text: 'VISTA PREVIA 30 s', cls: 'bg-amber-500/20 text-amber-300' },
    mix: { text: 'MEZCLA REAL', cls: 'bg-purple-500/25 text-purple-300' },
  };
  const when = producedAt ? new Date(producedAt) : null;
  const whenStr = when && !Number.isNaN(when.getTime())
    ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    : null;
  const fmtT = (ms: number) => {
    const s = Math.max(0, ms / 1000);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const playheadPct = durationMs > 0 && posMs >= vStart && posMs <= vEnd ? ((posMs - vStart) / spanMs) * 100 : null;

  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="flex flex-wrap items-baseline gap-x-1.5 text-[10px] text-muted-foreground">
          {kind && (
            <span className={`rounded px-1 py-px text-[9px] font-semibold tracking-wide ${KIND[kind].cls}`}>{KIND[kind].text}</span>
          )}
          <span>{label}</span>
          {whenStr && <span className="text-[9px] text-muted-foreground/70">generada {whenStr}</span>}
        </span>
        <span className="flex items-center gap-2">
          {behind && env && (
            <span className="text-[9px] text-muted-foreground">
              <span className="text-slate-400">gris = original</span> · <span style={{ color }}>color = procesada</span>
            </span>
          )}
          {env && (
            <span className="flex items-center gap-0.5">
              <button type="button" onClick={() => zoom(0.25)} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title="Zoom +"><ZoomIn className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => zoom(4)} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title="Zoom −"><ZoomOut className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setView(null)} className={`rounded px-1 text-[10px] ${zoomed ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/40'}`} title="Ver todo">Todo</button>
              {zoomed && <span className="font-mono text-[9px] text-muted-foreground">{fmtT(vStart)}–{fmtT(vEnd)}</span>}
            </span>
          )}
        </span>
      </div>
      {sublabel && (
        <p className="text-[9px] leading-tight text-muted-foreground">{sublabel}</p>
      )}
      {chainLabel && (
        <p className="text-[9px] leading-tight text-muted-foreground/80">
          <span className="text-muted-foreground">aplicado:</span> {chainLabel}
        </p>
      )}
      {warning && (
        <p className="text-[9px] leading-tight text-amber-300">⚠ {warning}</p>
      )}
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="w-full cursor-pointer rounded bg-secondary/40"
          style={{ height }}
          title="Clic para saltar a ese punto · rueda = acercar/alejar en el cursor · Shift+rueda = desplazar"
          onWheel={(e) => {
            if (!env || durationMs <= 0) return;
            e.preventDefault();
            const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setView((prev) => {
              const curStart = prev?.startMs ?? 0;
              const curEnd = prev?.endMs ?? durationMs;
              const curSpan = curEnd - curStart;
              if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                // Pan by a fraction of the window (trackpad sideways or Shift+wheel).
                const d = (e.shiftKey ? e.deltaY : e.deltaX) / rect.width * curSpan;
                const start = Math.max(0, Math.min(durationMs - curSpan, curStart + d));
                return curSpan >= durationMs - 1 ? null : { startMs: start, endMs: start + curSpan };
              }
              // Zoom around the pointer: the time under the cursor stays put.
              const factor = Math.exp(e.deltaY * 0.002);
              const span = Math.max(1000, Math.min(durationMs, curSpan * factor));
              if (span >= durationMs - 1) return null;
              const anchor = curStart + frac * curSpan;
              let start = anchor - frac * span;
              start = Math.max(0, Math.min(durationMs - span, start));
              return { startMs: start, endMs: start + span };
            });
          }}
          onClick={(e) => {
            const audio = audioRef.current;
            if (!audio || !env) return;
            const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            const t = (vStart + frac * spanMs) / 1000;
            audio.currentTime = t;
            setPosMs(t * 1000);
            void audio.play();
          }}
        />
        {playheadPct != null && (
          <div
            className="pointer-events-none absolute inset-y-0 w-[1.5px] bg-red-400"
            style={{ left: `${playheadPct}%` }}
          />
        )}
      </div>
      {zoomed && (
        <input
          type="range" min={0} max={1000}
          value={Math.round((vStart / durationMs) * 1000)}
          onChange={(e) => pan(Number(e.target.value) / 1000)}
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          title="Desplazar la ventana"
        />
      )}
      {stats && (
        <p className="font-mono text-[9px] leading-tight text-muted-foreground" title="Medido sobre la envolvente (picos por 25 ms). Voz típica = mediana de los tramos con voz; fuerte = percentil 95; ruido = percentil 10 de todo.">
          {behindStats ? (
            <>
              <span className="text-slate-400">orig → </span><span style={{ color }}>proc</span>
              {' · '}voz típica {f0(behindStats.typicalDb)}→{f0(stats.typicalDb)} dB
              <span className="text-emerald-400"> ({fmtDelta(stats.typicalDb, behindStats.typicalDb)})</span>
              {' · '}fuerte {f0(behindStats.loudDb)}→{f0(stats.loudDb)}
              <span className="text-emerald-400"> ({fmtDelta(stats.loudDb, behindStats.loudDb)})</span>
              {' · '}pico {f0(behindStats.peakDb)}→{f0(stats.peakDb)}
              <span className="text-emerald-400"> ({fmtDelta(stats.peakDb, behindStats.peakDb)})</span>
              {' · '}ruido {f0(behindStats.floorDb)}→{f0(stats.floorDb)}
            </>
          ) : (
            <>
              pico {f0(stats.peakDb)} dB · voz típica {f0(stats.typicalDb)} · fuerte {f0(stats.loudDb)} · ruido {f0(stats.floorDb)}
            </>
          )}
        </p>
      )}
      <audio
        ref={audioRef}
        controls
        preload="none"
        className="h-7 w-full"
        src={fileUrl}
        onTimeUpdate={(e) => {
          const a = e.target as HTMLAudioElement;
          const ms = a.currentTime * 1000;
          setPosMs(ms);
          // Follow the playhead while zoomed: keep it ~40% from the left edge
          // once it leaves the middle band of the window.
          if (view && durationMs > 0) {
            const span = view.endMs - view.startMs;
            if (span < durationMs - 1 && (ms < view.startMs + span * 0.1 || ms > view.endMs - span * 0.1)) {
              let start = ms - span * 0.4;
              start = Math.max(0, Math.min(durationMs - span, start));
              if (Math.abs(start - view.startMs) > span * 0.004) setView({ startMs: start, endMs: start + span });
            }
          }
        }}
      />
    </div>
  );
}
