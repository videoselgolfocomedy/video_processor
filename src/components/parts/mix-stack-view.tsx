'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { STEM_MIX_NORMALIZATION } from '@/lib/audio-stems';

interface EnvelopeData {
  envelope: number[];
  hop_ms: number;
  duration_s: number;
}

/**
 * The mixer, drawn: the two PROCESSED stems with their mix volume applied,
 * and the resulting mix underneath — three lanes on one shared timeline so
 * moving "Vol. mesa" / "Vol. cámara" is visible immediately.
 *
 * The stems are tapped where each branch enters the final amix, so their
 * timelines already match the mix's; the drawing multiplies their envelopes
 * by the CURRENT slider values (client-side, instant). The mix lane shows the
 * real mixed file (authoritative, what plays) plus — when the sliders no
 * longer match the volumes that mix was made with — an outline of the
 * estimated sum, so the user sees where the new balance would land before
 * re-mixing. That estimate is an upper bound: peak envelopes only add
 * linearly when both signals are in phase (they are for the comic's voice,
 * which is in both mics; less so for the audience).
 */
export function MixStackView({
  projectId,
  boardFile,
  ambientFile,
  mixFile,
  boardVolume,
  ambientVolume,
  mixedWithBoardVolume,
  mixedWithAmbientVolume,
  refreshKey,
  laneHeight = 54,
}: {
  projectId: string;
  boardFile: string;
  ambientFile: string;
  mixFile: string;
  boardVolume: number;
  ambientVolume: number;
  /** Volumes the CURRENT mix file was rendered with (to flag a mismatch). */
  mixedWithBoardVolume?: number;
  mixedWithAmbientVolume?: number;
  refreshKey?: string;
  laneHeight?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [board, setBoard] = useState<EnvelopeData | null>(null);
  const [amb, setAmb] = useState<EnvelopeData | null>(null);
  const [mix, setMix] = useState<EnvelopeData | null>(null);
  const [posMs, setPosMs] = useState(0);
  const [view, setView] = useState<{ startMs: number; endMs: number } | null>(null);

  useEffect(() => {
    let dead = false;
    setBoard(null); setAmb(null); setMix(null); setView(null);
    const get = (name: string) =>
      fetch(`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(name)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    void Promise.all([get(boardFile), get(ambientFile), get(mixFile)]).then(([b, a, m]) => {
      if (dead) return;
      setBoard(b); setAmb(a); setMix(m);
    });
    return () => { dead = true; };
  }, [projectId, boardFile, ambientFile, mixFile, refreshKey]);

  const durationMs = mix ? mix.duration_s * 1000 : Math.max(board?.duration_s ?? 0, amb?.duration_s ?? 0) * 1000;
  const vStart = view?.startMs ?? 0;
  const vEnd = view?.endMs ?? durationMs;
  const spanMs = Math.max(1, vEnd - vStart);
  const zoomed = view != null && durationMs > 0 && spanMs < durationMs - 1;

  const volMismatch =
    (mixedWithBoardVolume != null && Math.abs(mixedWithBoardVolume - boardVolume) > 0.001) ||
    (mixedWithAmbientVolume != null && Math.abs(mixedWithAmbientVolume - ambientVolume) > 0.001);

  /** Peak of an envelope over the visible window, with a gain applied. */
  const peakDb = useCallback((e: EnvelopeData | null, gain: number) => {
    if (!e || e.hop_ms <= 0) return null;
    const i0 = Math.max(0, Math.floor(vStart / e.hop_ms));
    const i1 = Math.min(e.envelope.length, Math.ceil(vEnd / e.hop_ms));
    let p = 0;
    for (let i = i0; i < i1; i++) if (e.envelope[i] > p) p = e.envelope[i];
    return 20 * Math.log10(Math.max(1e-4, p * gain));
  }, [vStart, vEnd]);

  // The stems are tapped POST-volume (they already carry the volumes the mix
  // was made with), so a lane's gain is the slider RELATIVE to that: same
  // value → ×1. And the mix averages the two branches (amix ÷2) before the
  // limiter — the estimate does the same.
  const boardGain = boardVolume / (mixedWithBoardVolume || boardVolume || 1);
  const ambGain = ambientVolume / (mixedWithAmbientVolume || ambientVolume || 1);
  const lanes = useMemo(() => ([
    { key: 'board', env: board, gain: boardGain, color: '#34d399', label: `Mesa procesada × ${boardVolume}` },
    { key: 'amb', env: amb, gain: ambGain, color: '#38bdf8', label: `Ambiente procesado × ${ambientVolume}` },
    { key: 'mix', env: mix, gain: 1, color: '#c084fc', label: 'Mezcla = (mesa + ambiente) ÷ 2 → limitador (lo que va al vídeo)' },
  ]), [board, amb, mix, boardVolume, ambientVolume, boardGain, ambGain]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || laneHeight * 3;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '9px sans-serif';

    const laneH = h / 3;
    // Sampled peaks per pixel for a lane (gain applied, NOT clamped).
    const sample = (e: EnvelopeData | null, gain: number): Float32Array => {
      const out = new Float32Array(w);
      if (!e || e.hop_ms <= 0) return out;
      const i0 = Math.max(0, Math.floor(vStart / e.hop_ms));
      const i1 = Math.min(e.envelope.length, Math.ceil(vEnd / e.hop_ms));
      const n = Math.max(1, i1 - i0);
      const step = Math.max(1, Math.floor(n / w));
      for (let x = 0; x < w; x++) {
        const j0 = i0 + Math.floor((x / w) * n);
        let p = 0;
        for (let i = j0; i < Math.min(i1, j0 + step); i++) if (e.envelope[i] > p) p = e.envelope[i];
        out[x] = p * gain;
      }
      return out;
    };
    const cols = lanes.map((l) => sample(l.env, l.gain));

    lanes.forEach((lane, li) => {
      const top = li * laneH;
      const mid = top + laneH / 2;
      const half = laneH / 2 - 2;
      // guides
      for (const db of [0, -6, -12]) {
        const a = Math.pow(10, db / 20);
        ctx.strokeStyle = db === 0 ? 'rgba(148,163,184,0.30)' : 'rgba(148,163,184,0.12)';
        ctx.beginPath();
        ctx.moveTo(0, mid - a * half); ctx.lineTo(w, mid - a * half);
        ctx.moveTo(0, mid + a * half); ctx.lineTo(w, mid + a * half);
        ctx.stroke();
      }
      // waveform (clipping above 0 dBFS drawn red)
      const col = cols[li];
      for (let x = 0; x < w; x++) {
        const v = col[x];
        const y = Math.max(1, Math.min(1, v) * half);
        ctx.fillStyle = v > 1 ? '#f87171' : lane.color;
        ctx.fillRect(x, mid - y, 1, y * 2);
      }
      // estimated sum on the mix lane, when the sliders moved since the mix
      if (lane.key === 'mix' && volMismatch) {
        ctx.strokeStyle = 'rgba(251,191,36,0.95)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const est = Math.min(1, (cols[0][x] + cols[1][x]) * STEM_MIX_NORMALIZATION);
          const y = mid - Math.max(1, est * half);
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // lane separator + label
      ctx.strokeStyle = 'rgba(148,163,184,0.25)';
      ctx.beginPath(); ctx.moveTo(0, top + laneH); ctx.lineTo(w, top + laneH); ctx.stroke();
      ctx.fillStyle = lane.color;
      ctx.fillText(lane.label, 3, top + 10);
      const pk = peakDb(lane.env, lane.gain);
      if (pk != null) {
        ctx.fillStyle = pk > -0.1 ? '#f87171' : 'rgba(148,163,184,0.85)';
        ctx.textAlign = 'right';
        ctx.fillText(`pico ${pk.toFixed(1)} dB`, w - 3, top + 10);
        ctx.textAlign = 'left';
      }
    });
  }, [lanes, vStart, vEnd, volMismatch, laneHeight, peakDb]);

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
  const pan = useCallback((frac: number) => {
    setView((prev) => {
      if (!prev || durationMs <= 0) return prev;
      const span = prev.endMs - prev.startMs;
      const start = Math.max(0, Math.min(durationMs - span, frac * durationMs));
      return { startMs: start, endMs: start + span };
    });
  }, [durationMs]);

  const fmtT = (ms: number) => {
    const s = Math.max(0, ms / 1000);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const playheadPct = durationMs > 0 && posMs >= vStart && posMs <= vEnd ? ((posMs - vStart) / spanMs) * 100 : null;

  if (!board && !amb && !mix) {
    return <p className="text-[10px] italic text-muted-foreground">Genera una vista previa o mezcla para ver cómo se suman las pistas.</p>;
  }

  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[10px] text-muted-foreground">
          Cómo se suman las pistas — <span className="text-emerald-400">mesa</span> +{' '}
          <span className="text-sky-400">ambiente</span> ={' '}
          <span className="text-purple-400">mezcla</span>, con los volúmenes de arriba aplicados
        </span>
        <span className="flex items-center gap-0.5">
          <button type="button" onClick={() => zoom(0.25)} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title="Zoom +"><ZoomIn className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => zoom(4)} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title="Zoom −"><ZoomOut className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => setView(null)} className={`rounded px-1 text-[10px] ${zoomed ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/40'}`} title="Ver todo">Todo</button>
          {zoomed && <span className="font-mono text-[9px] text-muted-foreground">{fmtT(vStart)}–{fmtT(vEnd)}</span>}
        </span>
      </div>
      {volMismatch && (
        <p className="text-[9px] leading-tight text-amber-300">
          ⚠ Los volúmenes han cambiado desde la mezcla: la línea ámbar es la <strong>suma estimada</strong> con los valores
          actuales (máximo posible); el relleno morado sigue siendo la mezcla que existe. Re-mezcla para hacerla real.
        </p>
      )}
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="w-full cursor-pointer rounded bg-secondary/40"
          style={{ height: laneHeight * 3 }}
          title="Clic para saltar a ese punto · +/− para acercar"
          onClick={(e) => {
            const a = audioRef.current;
            const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            const t = vStart + frac * spanMs;
            setPosMs(t);
            if (a) { a.currentTime = t / 1000; void a.play().catch(() => {}); }
          }}
        />
        {playheadPct != null && (
          <div className="pointer-events-none absolute inset-y-0 w-[1.5px] bg-red-400" style={{ left: `${playheadPct}%` }} />
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
      <audio
        ref={audioRef}
        controls
        preload="none"
        className="h-7 w-full"
        src={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(mixFile)}&v=${encodeURIComponent(refreshKey ?? '')}`}
        onTimeUpdate={(e) => {
          const a = e.target as HTMLAudioElement;
          const ms = a.currentTime * 1000;
          setPosMs(ms);
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
