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
}

interface AlignmentViewProps {
  projectId: string;
  onOffsetChanged?: () => void;
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
}: {
  micEnvelope: number[];
  cameraEnvelope: number[];
  hopMs: number;
  offsetMs: number;
  aligned: boolean;
  height?: number;
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
    const rowH = height / 2;

    ctx.clearRect(0, 0, w, height);

    // Total timeline duration in ms
    const micDurMs = micEnvelope.length * hopMs;
    const camDurMs = cameraEnvelope.length * hopMs;

    // In "before" mode: both start at 0, total = max of both
    // In "after" mode: mic might be offset, total = full aligned span
    let micStartMs = 0;
    let camStartMs = 0;
    let totalMs: number;

    if (aligned) {
      // Offset > 0 means mic starts before camera
      if (offsetMs > 0) {
        micStartMs = 0;
        camStartMs = offsetMs;
      } else {
        micStartMs = -offsetMs;
        camStartMs = 0;
      }
      totalMs = Math.max(micStartMs + micDurMs, camStartMs + camDurMs);
    } else {
      totalMs = Math.max(micDurMs, camDurMs);
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

    drawEnvelope(micEnvelope, micStartMs, '#22c55e', 0);
    drawEnvelope(cameraEnvelope, camStartMs, '#3b82f6', rowH);

    // In aligned mode, draw the overlap region
    if (aligned) {
      const overlapStart = Math.max(micStartMs, camStartMs);
      const overlapEnd = Math.min(micStartMs + micDurMs, camStartMs + camDurMs);
      if (overlapEnd > overlapStart) {
        const x1 = overlapStart / msPerPx;
        const x2 = overlapEnd / msPerPx;
        c.fillStyle = '#f59e0b18';
        c.fillRect(x1, 0, x2 - x1, height);
        c.strokeStyle = '#f59e0b40';
        c.lineWidth = 1;
        c.setLineDash([4, 4]);
        c.beginPath();
        c.moveTo(x1, 0);
        c.lineTo(x1, height);
        c.moveTo(x2, 0);
        c.lineTo(x2, height);
        c.stroke();
        c.setLineDash([]);
      }
    }
  }, [micEnvelope, cameraEnvelope, hopMs, offsetMs, aligned, height]);

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

export function AlignmentView({ projectId, onOffsetChanged }: AlignmentViewProps) {
  const [data, setData] = useState<AlignmentData | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [manualInput, setManualInput] = useState('');
  const [applying, setApplying] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const url = `/api/projects/${projectId}/audio/file?name=alignment_data.json&t=${Date.now()}`;
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
  }, [projectId, reloadKey]);

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
      const res = await fetch(`/api/projects/${projectId}/audio/alignment-offset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMs }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Error ${res.status}`);
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
  }, [projectId, manualInput, toast, onOffsetChanged]);

  if (error || !data) return null;

  const offsetSec = Math.abs(data.offset_seconds);
  const micLeads = data.offset_ms > 0;
  // Trust the PHAT peak/noise ratio when it's available (more reliable than
  // the waveform correlation, which can be high by accident on near-silence).
  const ptn = data.peak_to_noise;
  const lowConfidence = !data.manual_override && (
    ptn !== undefined ? ptn < 2 : data.correlation < 0.1
  );

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
              Peak/ruido: <strong className={lowConfidence ? 'text-red-400' : ptn >= 5 ? 'text-green-400' : 'text-foreground'}>
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
              <span className="text-muted-foreground">Mesa ({formatTime(data.mic_duration_s)})</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-500" />
              <span className="text-muted-foreground">Cámara ({formatTime(data.camera_duration_s)})</span>
            </div>
          </div>
          <DualWaveformCanvas
            micEnvelope={data.mic_envelope}
            cameraEnvelope={data.camera_envelope}
            hopMs={data.envelope_hop_ms}
            offsetMs={data.offset_ms}
            aligned={false}
            height={80}
          />
        </div>

        {/* After alignment */}
        <div className="space-y-1">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground font-medium">Después de alinear</span>
            <span className="text-amber-400/70 text-[10px]">zona de solapamiento en ámbar</span>
          </div>
          <DualWaveformCanvas
            micEnvelope={data.mic_envelope}
            cameraEnvelope={data.camera_envelope}
            hopMs={data.envelope_hop_ms}
            offsetMs={data.offset_ms}
            aligned={true}
            height={80}
          />
        </div>
      </CardContent>
    </Card>
  );
}
