'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { GitCompareArrows, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface AlignmentData {
  mic_envelope: number[];
  camera_envelope: number[];
  envelope_hop_ms: number;
  offset_ms: number;
  offset_seconds: number;
  mic_duration_s: number;
  camera_duration_s: number;
  overlap_s: number;
  correlation: number;
  /** GCC-PHAT peak / noise floor. >5 = strong, <2 = unreliable. */
  peak_to_noise?: number;
  manual_override?: boolean;
  /** Parts aligned on EXCERPTS: where each envelope starts inside its file
   *  (s), how long the whole files are, and the ranges the user asked for. */
  mic_origin_s?: number;
  camera_origin_s?: number;
  mic_file_duration_s?: number;
  camera_file_duration_s?: number;
  video_range_s?: [number, number];
  board_range_s?: [number, number];
}

interface AlignmentViewProps {
  projectId: string;
  onOffsetChanged?: () => void;
  /** Alignment JSON to read from audio/ (default: the global pair's
   *  alignment_data.json; parts pass their part_<id8>_alignment.json). */
  dataFileName?: string;
  /** Custom manual-offset applier. Default POSTs the global
   *  /audio/alignment-offset route; parts PATCH their own record instead.
   *  Must throw on failure (the error message is shown in a toast). */
  applyOffset?: (offsetMs: number) => Promise<void>;
}

// Parse "mm:ss" or "mm:ss.ms" or "123.4" (seconds) into milliseconds.
// Returns null on invalid input.
function parseOffsetInput(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    if (parts.length !== 2) return null;
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
    const sign = m < 0 || (parts[0].startsWith('-')) ? -1 : 1;
    return sign * (Math.abs(m) * 60 + s) * 1000;
  }
  // Plain number = seconds
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n * 1000;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function DualWaveformCanvas({
  micEnvelope,
  cameraEnvelope,
  hopMs,
  offsetMs,
  aligned,
  height = 100,
  micOriginMs = 0,
  camOriginMs = 0,
  micFileMs,
  camFileMs,
  videoRangeMs,
}: {
  micEnvelope: number[];
  cameraEnvelope: number[];
  hopMs: number;
  offsetMs: number;
  aligned: boolean;
  height?: number;
  /** Where each envelope starts inside its file (excerpt alignment). */
  micOriginMs?: number;
  camOriginMs?: number;
  /** Whole-file lengths — the part outside the envelopes is drawn as "not used". */
  micFileMs?: number;
  camFileMs?: number;
  /** The stretch of the video that will be EDITED (camera clock). */
  videoRangeMs?: [number, number];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width: cssWidth } = canvas.getBoundingClientRect();
    const dpr = 2;
    canvas.width = cssWidth * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const w = cssWidth;
    const AXIS_H = 14;
    const rowH = (height - AXIS_H) / 2;

    ctx.clearRect(0, 0, w, height);

    const micDurMs = micEnvelope.length * hopMs;
    const camDurMs = cameraEnvelope.length * hopMs;
    const micFile = Math.max(micFileMs ?? 0, micOriginMs + micDurMs);
    const camFile = Math.max(camFileMs ?? 0, camOriginMs + camDurMs);

    // "Before": each file on its own clock from 0 — the envelope (maybe an
    // excerpt) sits at its origin, the rest of the file is a dim bar.
    // "After": everything on the MESA clock; camera time + offset = mesa time,
    // so the camera file starts at `offset` (may be negative → shift all).
    let micStartMs: number, camStartMs: number, micFileStartMs: number, camFileStartMs: number, totalMs: number, shiftMs = 0;
    if (aligned) {
      micFileStartMs = 0;
      camFileStartMs = offsetMs;
      shiftMs = Math.max(0, -Math.min(micFileStartMs, camFileStartMs));
      micFileStartMs += shiftMs; camFileStartMs += shiftMs;
      micStartMs = micFileStartMs + micOriginMs;
      camStartMs = camFileStartMs + camOriginMs;
      totalMs = Math.max(micFileStartMs + micFile, camFileStartMs + camFile);
    } else {
      micFileStartMs = 0; camFileStartMs = 0;
      micStartMs = micOriginMs; camStartMs = camOriginMs;
      totalMs = Math.max(micFile, camFile);
    }

    if (totalMs <= 0) return;

    const msPerPx = totalMs / w;

    // Find max envelope value for normalization
    const maxVal = Math.max(
      ...micEnvelope.slice(0, 200).sort((a, b) => b - a).slice(0, 5),
      ...cameraEnvelope.slice(0, 200).sort((a, b) => b - a).slice(0, 5),
      0.001
    );
    // Use 95th percentile for better visual range
    const allVals = [...micEnvelope, ...cameraEnvelope].sort((a, b) => a - b);
    const normVal = allVals[Math.floor(allVals.length * 0.98)] || maxVal;

    const c = ctx; // non-null local alias

    function drawEnvelope(
      envelope: number[],
      startMs: number,
      color: string,
      yOffset: number
    ) {
      const mid = yOffset + rowH / 2;
      const amp = rowH / 2 - 2;

      // Background
      const envStartPx = startMs / msPerPx;
      const envWidthPx = (envelope.length * hopMs) / msPerPx;
      c.fillStyle = color + '10';
      c.fillRect(envStartPx, yOffset, envWidthPx, rowH);

      // Waveform
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.beginPath();
      for (let px = 0; px < w; px++) {
        const timeMs = px * msPerPx;
        const relMs = timeMs - startMs;
        if (relMs < 0 || relMs >= envelope.length * hopMs) continue;
        const idx = Math.floor(relMs / hopMs);
        const val = Math.min(envelope[idx] / normVal, 1.0);
        c.moveTo(px, mid - val * amp);
        c.lineTo(px, mid + val * amp);
      }
      c.stroke();

      // Center line
      c.strokeStyle = color + '30';
      c.lineWidth = 0.5;
      c.beginPath();
      c.moveTo(0, mid);
      c.lineTo(w, mid);
      c.stroke();
    }

    // The whole files as dim bars ("está grabado, pero no se usa").
    const fileBar = (startMs: number, durMs: number, yOffset: number) => {
      c.fillStyle = 'rgba(148,163,184,0.10)';
      c.fillRect(startMs / msPerPx, yOffset + 2, durMs / msPerPx, rowH - 4);
    };
    fileBar(micFileStartMs, micFile, 0);
    fileBar(camFileStartMs, camFile, rowH);

    drawEnvelope(micEnvelope, micStartMs, '#22c55e', 0);
    drawEnvelope(cameraEnvelope, camStartMs, '#3b82f6', rowH);

    // The EDITED window: the video range (or the whole video) — on the
    // camera row in "before", and as the amber band across both rows once
    // aligned (that is the stretch the mix and the mux will cover).
    const editA = camFileStartMs + (videoRangeMs ? videoRangeMs[0] : 0);
    const editB = camFileStartMs + (videoRangeMs ? videoRangeMs[1] : camFile);
    const band = (x1: number, x2: number, y: number, h: number, label: string) => {
      c.fillStyle = '#f59e0b1c';
      c.fillRect(x1, y, x2 - x1, h);
      c.strokeStyle = '#f59e0b90';
      c.lineWidth = 1;
      c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(x1, y); c.lineTo(x1, y + h); c.moveTo(x2, y); c.lineTo(x2, y + h); c.stroke();
      c.setLineDash([]);
      if (x2 - x1 > 70) {
        c.fillStyle = '#fbbf24';
        c.font = '10px ui-sans-serif, system-ui';
        c.fillText(label, x1 + 4, y + 11);
      }
    };
    if (aligned) {
      const a = Math.max(editA, micFileStartMs), b = Math.min(editB, micFileStartMs + micFile);
      if (b > a) band(a / msPerPx, b / msPerPx, 0, rowH * 2, 'se edita este tramo');
    } else {
      band(editA / msPerPx, editB / msPerPx, rowH, rowH, 'vídeo: se edita');
    }

    // Time axis, in the clock of the drawing (mesa clock when aligned).
    const axisY = rowH * 2;
    c.fillStyle = 'rgba(148,163,184,0.7)';
    c.font = '9px ui-monospace, monospace';
    const stepMs = totalMs > 3600e3 * 1.5 ? 600e3 : totalMs > 1800e3 ? 300e3 : totalMs > 600e3 ? 120e3 : 60e3;
    for (let t = 0; t <= totalMs; t += stepMs) {
      const x = t / msPerPx;
      c.fillRect(x, axisY, 1, 3);
      const tt = (t - shiftMs) / 1000;
      const sign = tt < 0 ? '-' : '';
      const abs = Math.abs(tt);
      const lbl = `${sign}${Math.floor(abs / 60)}:${String(Math.floor(abs % 60)).padStart(2, '0')}`;
      if (x + 30 < w) c.fillText(lbl, x + 2, axisY + 12);
    }
  }, [micEnvelope, cameraEnvelope, hopMs, offsetMs, aligned, height, micOriginMs, camOriginMs, micFileMs, camFileMs, videoRangeMs]);

  useEffect(() => {
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-md bg-secondary"
      style={{ height: `${height}px` }}
    />
  );
}

export function AlignmentView({ projectId, onOffsetChanged, dataFileName = 'alignment_data.json', applyOffset }: AlignmentViewProps) {
  const [data, setData] = useState<AlignmentData | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [manualInput, setManualInput] = useState('');
  const [applying, setApplying] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const url = `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(dataFileName)}&t=${Date.now()}`;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then((d: AlignmentData) => {
        setData(d);
        // Pre-fill the input with the current offset in mm:ss for easy tweaking
        const sec = d.offset_ms / 1000;
        const sign = sec < 0 ? '-' : '';
        const abs = Math.abs(sec);
        const m = Math.floor(abs / 60);
        const s = (abs % 60).toFixed(1);
        setManualInput(`${sign}${m}:${s.padStart(4, '0')}`);
      })
      .catch(() => setError(true));
  }, [projectId, dataFileName, reloadKey]);

  const applyManual = useCallback(async () => {
    const offsetMs = parseOffsetInput(manualInput);
    if (offsetMs === null) {
      toast({
        title: 'Formato no válido',
        description: 'Usa "mm:ss" (ej: 3:30) o segundos (ej: 210)',
        variant: 'destructive',
      });
      return;
    }
    setApplying(true);
    try {
      if (applyOffset) {
        await applyOffset(offsetMs);
      } else {
        const res = await fetch(`/api/projects/${projectId}/audio/alignment-offset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offsetMs }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `Error ${res.status}`);
        }
      }
      toast({ title: 'Offset actualizado', description: `${(offsetMs / 1000).toFixed(2)}s aplicado` });
      setReloadKey((k) => k + 1);
      onOffsetChanged?.();
    } catch (err) {
      toast({
        title: 'No se pudo aplicar',
        description: (err as Error).message,
        variant: 'destructive',
      });
    } finally {
      setApplying(false);
    }
  }, [projectId, manualInput, toast, onOffsetChanged, applyOffset]);

  if (error || !data) return null;

  const offsetSec = Math.abs(data.offset_seconds);
  const micLeads = data.offset_ms > 0;
  const micOriginMs = (data.mic_origin_s ?? 0) * 1000;
  const camOriginMs = (data.camera_origin_s ?? 0) * 1000;
  const micFileMs = (data.mic_file_duration_s ?? data.mic_duration_s) * 1000;
  const camFileMs = (data.camera_file_duration_s ?? data.camera_duration_s) * 1000;
  const videoRangeMs = data.video_range_s ? [data.video_range_s[0] * 1000, data.video_range_s[1] * 1000] as [number, number] : undefined;
  // Where the edited stretch of the video lands in the mesa (camera + offset).
  const editCamA = videoRangeMs ? videoRangeMs[0] : 0;
  const editCamB = videoRangeMs ? videoRangeMs[1] : camFileMs;
  const editMesaA = editCamA + data.offset_ms, editMesaB = editCamB + data.offset_ms;
  const mmss = (ms: number) => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
  // Trust the PHAT peak/noise ratio when it's available (more reliable than
  // the waveform correlation, which can be high by accident on near-silence).
  const ptn = data.peak_to_noise;
  const lowConfidence = !data.manual_override && (
    ptn !== undefined ? ptn < 2 : data.correlation < 0.1
  );
  // 20×+ is a confidently-right peak; 2–20× has landed on the WRONG moment in
  // real projects (short camera pieces) — flag it as "verify by ear".
  const mediumConfidence = !data.manual_override && !lowConfidence &&
    ptn !== undefined && ptn < 20;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <GitCompareArrows className="h-4 w-4 text-amber-400" />
          Alineación de pistas
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Offset: <strong className="text-foreground">{formatTime(offsetSec)}</strong>
            {' '}({micLeads ? 'mesa empieza antes' : 'cámara empieza antes'})
          </span>
          <span>
            Solapamiento: <strong className="text-foreground">{formatTime(data.overlap_s)}</strong>
          </span>
          <span>
            Correlación: <strong className="text-foreground">
              {data.correlation.toFixed(3)}
            </strong>
          </span>
          {ptn !== undefined && (
            <span>
              Peak/ruido: <strong className={lowConfidence ? 'text-red-400' : ptn >= 20 ? 'text-green-400' : 'text-amber-400'}>
                {ptn.toFixed(1)}×
              </strong>
            </span>
          )}
          {data.manual_override && (
            <span className="inline-flex items-center gap-1 text-amber-400">
              <Check className="h-3 w-3" /> ajuste manual
            </span>
          )}
        </div>

        {/* What will be edited, in both clocks — the sentence the drawings
            illustrate. */}
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px]">
          <span className="font-medium text-amber-300">Se edita:</span>{' '}
          <span className="text-blue-300">vídeo {mmss(editCamA)}–{mmss(editCamB)}</span>
          {videoRangeMs ? '' : ' (entero)'}
          {' '}<span className="text-muted-foreground">↔</span>{' '}
          <span className="text-green-300">mesa {mmss(editMesaA)}–{mmss(editMesaB)}</span>
          <span className="text-muted-foreground"> · {mmss(editCamB - editCamA)} de duración</span>
          {data.board_range_s && (
            <span className="text-muted-foreground"> · buscado en la mesa entre {mmss(data.board_range_s[0] * 1000)} y {mmss(data.board_range_s[1] * 1000)}
              {editMesaA < data.board_range_s[0] * 1000 - 1000 || editMesaB > data.board_range_s[1] * 1000 + 1000 ? <span className="text-amber-300"> — cae parcialmente fuera de ese tramo</span> : ''}
            </span>
          )}
        </div>

        {/* Low-correlation warning + manual override input.
            Correlation < 0.1 means cross-correlation found a noise peak (the
            true alignment couldn't be detected). User must enter the real
            offset manually. */}
        {lowConfidence && (
          <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2.5 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 flex-none" />
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              <p className="text-red-400 font-medium">
                {ptn !== undefined
                  ? `Pico GCC-PHAT muy débil (${ptn.toFixed(1)}× el ruido). El offset detectado probablemente es incorrecto.`
                  : `Correlación muy baja (${data.correlation.toFixed(3)}). El offset detectado probablemente es incorrecto.`}
              </p>
              <p>
                Introduce abajo el offset real entre mesa y cámara para corregirlo a mano.
              </p>
            </div>
          </div>
        )}

        {/* Medium confidence: the peak exists but isn't decisive — with short
            camera pieces it can lock onto a similar-sounding WRONG moment. */}
        {mediumConfidence && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 flex-none" />
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              <p className="text-amber-400 font-medium">
                Pico de correlación justo ({ptn!.toFixed(1)}× el ruido) — verifica de oído.
              </p>
              <p>
                Si el offset no cuadra (tramos cortos pueden engancharse a un momento
                parecido pero equivocado), indica el <strong>tramo del vídeo</strong> que vas a
                editar y <strong>dónde cae en la mesa</strong> (filas del paso 2) y pulsa Realinear:
                la correlación se hace solo entre esos dos tramos.
              </p>
            </div>
          </div>
        )}

        <div className="rounded-md border border-border p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Ajuste manual del offset</span>
            <span className="text-[10px] text-muted-foreground">mm:ss o segundos · positivo = mesa empieza antes</span>
          </div>
          <div className="flex gap-2">
            <Input
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              placeholder="3:30"
              className="h-8 text-xs font-mono flex-1"
              disabled={applying}
              onKeyDown={(e) => { if (e.key === 'Enter') applyManual(); }}
            />
            <Button size="sm" variant="outline" onClick={applyManual} disabled={applying} className="h-8">
              {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Aplicar'}
            </Button>
          </div>
        </div>

        {/* Before alignment */}
        <div className="space-y-1">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground font-medium">Antes de alinear</span>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-500" />
              <span className="text-muted-foreground">Mesa ({formatTime(micFileMs / 1000)}{data.mic_origin_s != null && data.mic_file_duration_s != null && data.mic_duration_s < data.mic_file_duration_s - 1 ? `, analizado ${mmss(micOriginMs)}–${mmss(micOriginMs + data.mic_duration_s * 1000)}` : ''})</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-500" />
              <span className="text-muted-foreground">Cámara ({formatTime(camFileMs / 1000)}{videoRangeMs ? `, se edita ${mmss(videoRangeMs[0])}–${mmss(videoRangeMs[1])}` : ''})</span>
            </div>
            <span className="text-[10px] text-muted-foreground/70">gris = grabado pero fuera del análisis · cada fila en su propio reloj</span>
          </div>
          <DualWaveformCanvas
            micEnvelope={data.mic_envelope}
            cameraEnvelope={data.camera_envelope}
            hopMs={data.envelope_hop_ms}
            offsetMs={data.offset_ms}
            aligned={false}
            height={96}
            micOriginMs={micOriginMs}
            camOriginMs={camOriginMs}
            micFileMs={micFileMs}
            camFileMs={camFileMs}
            videoRangeMs={videoRangeMs}
          />
        </div>

        {/* After alignment */}
        <div className="space-y-1">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground font-medium">Después de alinear</span>
            <span className="text-amber-400/70 text-[10px]">reloj de la mesa · en ámbar, el tramo que se edita (lo que mezcla y muxa esta parte)</span>
          </div>
          <DualWaveformCanvas
            micEnvelope={data.mic_envelope}
            cameraEnvelope={data.camera_envelope}
            hopMs={data.envelope_hop_ms}
            offsetMs={data.offset_ms}
            aligned={true}
            height={96}
            micOriginMs={micOriginMs}
            camOriginMs={camOriginMs}
            micFileMs={micFileMs}
            camFileMs={camFileMs}
            videoRangeMs={videoRangeMs}
          />
        </div>
      </CardContent>
    </Card>
  );
}
