'use client';

import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { useEnvelope, type EnvelopeData } from '@/lib/envelope-cache';
import type { AmbientPlan } from '@/lib/ambient-plan';

/** Sync & Mix's reference colour: the ORIGINAL signal, dimmed, behind the result. */
const ORIGINAL_COLOR = 'rgba(148,163,184,0.45)';
/** The applied-gain line (processed ÷ original, in dB) and its 0 dB reference. */
const GAIN_COLOR = 'rgba(251,191,36,0.95)';
const GAIN_REF_COLOR = 'rgba(251,191,36,0.45)';
const GAIN_MIN_DB = -36, GAIN_MAX_DB = 30;
/** Below this original peak (≈ −50 dBFS) the ratio is noise, not a gain. */
const GAIN_FLOOR = 0.003;

/**
 * The audio inside a timeline clip, drawn like the Sync & Mix rows: the same
 * absolute-amplitude envelope (peak per 25 ms, 0..1 = full scale) over exactly
 * the clip's SOURCE range. With `behind`, the ORIGINAL signal (raw mesa /
 * camera) is drawn first in gray at its own level, and the processed result
 * on top in colour scaled by the clip's volume — so a je-je cut reads as gray
 * pulses with no colour, a ducked ambient as colour lower than the gray, and
 * a raise as colour above it. Renders nothing while loading and for files the
 * envelope endpoint cannot serve, so it is safe on every audio clip.
 */
/** Extra px drawn beyond each edge of the viewport so a small pan needs no redraw to look complete. */
const SLACK_PX = 256;

export function ClipWaveform({
  fileName,
  sourceInMs,
  sourceOutMs,
  leftPx,
  widthPx,
  viewportWidthPx,
  color,
  gain = 1,
  behind,
  plan,
}: {
  fileName: string;
  sourceInMs: number;
  sourceOutMs: number;
  /** The clip's left edge relative to the track body (may be negative when scrolled past). */
  leftPx: number;
  /** The clip's full width in px — can be hundreds of thousands for a whole set. */
  widthPx: number;
  /** Visible width of the track body. */
  viewportWidthPx: number;
  color: string;
  gain?: number;
  /** The original file and where this clip's source t=0 sits inside it. */
  behind?: { fileName: string; offsetMs: number } | null;
  /** FORECAST (unapplied edits): the processed wave becomes original × this
   *  gain and the bright line follows it; the gain the files carry stays as a
   *  dim dotted line. Needs `behind`. */
  plan?: AmbientPlan | null;
}) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const rev = useProjectStore((s) => s.currentProject?.sync.audioRev);
  const env = useEnvelope(projectId, fileName, rev);
  const behindEnv = useEnvelope(projectId, behind?.fileName, rev);
  const behindOffsetMs = behind?.offsetMs ?? 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Only the VISIBLE slice of the clip gets a canvas. A 27-min clip at a
  // wide zoom is 160k+ px wide and a canvas that size silently draws nothing
  // (browsers cap canvases around 32k px) — that is exactly why no timeline
  // waveform ever showed on a full-set project.
  const x0 = Math.max(0, Math.floor(-leftPx - SLACK_PX));
  const x1 = Math.min(Math.round(widthPx), Math.ceil(viewportWidthPx - leftPx + SLACK_PX));
  const sliceW = x1 - x0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || sliceW < 2 || widthPx < 2 || (!env && !behindEnv)) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = sliceW;
    const h = canvas.clientHeight || 40;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const span = Math.max(1, sourceOutMs - sourceInMs);
    const msPerPx = span / widthPx;

    // Draw one envelope over the slice and return its per-column peaks.
    const draw = (e: EnvelopeData, fill: string | null, g: number, shiftMs: number): Float32Array | null => {
      const hop = e.hop_ms;
      if (hop <= 0) return null;
      const n = e.envelope.length;
      const peaks = new Float32Array(w);
      if (fill) ctx.fillStyle = fill;
      for (let x = 0; x < w; x++) {
        const t0 = sourceInMs + shiftMs + (x0 + x) * msPerPx;
        const t1 = t0 + msPerPx;
        const i0 = Math.max(0, Math.floor(t0 / hop));
        const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(t1 / hop)));
        let peak = 0;
        for (let i = i0; i < i1; i++) { const v = e.envelope[i]; if (v > peak) peak = v; }
        peaks[x] = peak;
        if (peak <= 0 || !fill) continue;
        const a = Math.min(1, peak * g);
        const y = Math.max(1, a * (mid - 1));
        ctx.fillRect(x, mid - y, 1, y * 2);
      }
      return peaks;
    };
    const rawPeaks = behindEnv ? draw(behindEnv, ORIGINAL_COLOR, 1, behindOffsetMs) : null;
    const forecast = !!(plan && rawPeaks);
    // With a forecast the processed wave on disk is stale: draw the PREDICTED
    // one (original × planned gain) in its place and keep the applied peaks
    // only for the dim line.
    const procPeaks = env ? draw(env, forecast ? null : color, gain, 0) : null;
    let planDb: Float32Array | null = null;
    if (forecast && rawPeaks) {
      planDb = new Float32Array(w);
      ctx.fillStyle = color;
      for (let x = 0; x < w; x++) {
        const t = sourceInMs + (x0 + x + 0.5) * msPerPx;
        const db = plan!.gainDbAt(t);
        planDb[x] = db;
        const r = rawPeaks[x];
        if (r <= 0) continue;
        const a = Math.min(1, r * Math.pow(10, db / 20) * gain);
        const y = Math.max(1, a * (mid - 1));
        ctx.fillRect(x, mid - y, 1, y * 2);
      }
    }

    // The APPLIED GAIN as a line: processed ÷ original per column, in dB —
    // every change the chain made (je-je cuts, leveler, ducking, raises, mix
    // volume) reads directly as the line's distance from the dashed 0 dB.
    if (rawPeaks && procPeaks) {
      const yOf = (db: number) => {
        const t = (Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, db)) - GAIN_MIN_DB) / (GAIN_MAX_DB - GAIN_MIN_DB);
        return h - 1 - t * (h - 2);
      };
      const y0 = yOf(0);
      ctx.strokeStyle = GAIN_REF_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(w, y0 + 0.5); ctx.stroke();
      // The gain the files carry — only while it IS the result. Under a
      // forecast it is not drawn at all: a raise the user just deleted must
      // not linger as a dim bump in the middle of the track; the forecast
      // line is the truth until Aplicar makes it real.
      if (!planDb) {
        ctx.setLineDash([]);
        ctx.strokeStyle = GAIN_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let pen = false;
        for (let x = 0; x < w; x++) {
          const r = rawPeaks[x], q = procPeaks[x];
          if (r < GAIN_FLOOR || q <= 0) { pen = false; continue; }
          const db = 20 * Math.log10((q * gain) / r);
          const y = yOf(db);
          if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
        }
        ctx.stroke();
      }
      if (planDb) {
        ctx.strokeStyle = GAIN_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const y = yOf(planDb[x] + 20 * Math.log10(Math.max(1e-4, gain)));
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // "0 dB" at the left edge of what is on screen.
      const labelX = Math.max(0, -leftPx) - x0 + 3;
      ctx.fillStyle = GAIN_COLOR;
      ctx.font = '8px sans-serif';
      ctx.fillText('0 dB', labelX, y0 - 2);
      ctx.fillText(`+${GAIN_MAX_DB}`, labelX, 8);
      ctx.fillText(`${GAIN_MIN_DB}`, labelX, h - 2);
      if (planDb) {
        ctx.fillStyle = GAIN_COLOR;
        ctx.font = 'bold 9px sans-serif';
        ctx.fillText('previsión · pulsa Aplicar', labelX + 26, 9);
      }
    }
  }, [env, behindEnv, behindOffsetMs, sourceInMs, sourceOutMs, widthPx, x0, sliceW, leftPx, color, gain, plan]);

  if ((!env && !behindEnv) || sliceW < 2) return null;
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 bottom-0 h-full"
      style={{ left: x0, width: sliceW }}
      aria-hidden
    />
  );
}
