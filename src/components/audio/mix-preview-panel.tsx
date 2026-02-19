'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Loader2, Blend, FileAudio, Info } from 'lucide-react';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import { AudioPlayer } from '@/components/audio/audio-player';

function formatTime(ms: number): string {
  const totalSec = Math.abs(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = (totalSec % 60).toFixed(2);
  return `${min}:${sec.padStart(5, '0')}`;
}

interface MixPreviewPanelProps {
  projectId: string;
  hasAmbient: boolean;
  alignmentOffsetMs?: number;
}

export function MixPreviewPanel({
  projectId,
  hasAmbient,
  alignmentOffsetMs,
}: MixPreviewPanelProps) {
  const [boardVolume, setBoardVolume] = useState(1.0);
  const [ambientVolume, setAmbientVolume] = useState(0.5);
  const [manualAdjustMs, setManualAdjustMs] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outputName, setOutputName] = useState<string | null>(null);
  const [cacheBust, setCacheBust] = useState(() => Date.now());
  const { toast } = useToast();

  useSSE({
    jobId,
    onProgress: (prog) => setProgress(prog),
    onComplete: () => {
      setRunning(false);
      setJobId(null);
      setCacheBust(Date.now());
      toast({ title: 'Mezcla generada' });
    },
    onError: (err) => {
      setRunning(false);
      setJobId(null);
      toast({ title: 'Mezcla fallida', description: err, variant: 'destructive' });
    },
  });

  const handleMix = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/mix-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardVolume, ambientVolume, manualAdjustMs }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error ${res.status}`);
      }
      const data = await res.json();
      setJobId(data.jobId);
      setOutputName(data.outputName);
    } catch (err) {
      setRunning(false);
      toast({
        title: 'No se pudo iniciar la mezcla',
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  }, [projectId, boardVolume, ambientVolume, manualAdjustMs, toast]);

  const mixUrl = outputName
    ? `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(outputName)}&t=${cacheBust}`
    : null;

  if (!hasAmbient) return null;

  const baseOffsetMs = alignmentOffsetMs ?? 0;
  const totalOffsetMs = baseOffsetMs + manualAdjustMs;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Preview Mezcla (Mesa + Ambiente)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-border bg-secondary/50 p-3">
          <div className="flex items-start gap-2">
            <Info className="h-4 w-4 text-primary mt-0.5 flex-none" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                Mezcla el audio de <strong className="text-green-400">mesa</strong> (voz) con el{' '}
                <strong className="text-blue-400">ambiente</strong> extraído, sincronizados por
                alineación de dos fases (envolvente + muestra a muestra).
              </p>
              <p>
                Offset auto: <strong className="text-foreground">{formatTime(baseOffsetMs)}</strong>
                {manualAdjustMs !== 0 && (
                  <> {manualAdjustMs > 0 ? '+' : ''}{manualAdjustMs}ms = <strong className="text-foreground">{formatTime(totalOffsetMs)}</strong></>
                )}
                {' '}(mesa se recorta desde este punto)
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Vol. Mesa</Label>
              <span className="text-xs text-muted-foreground">{boardVolume.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={boardVolume}
              onChange={(e) => setBoardVolume(parseFloat(e.target.value))}
              disabled={running}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Vol. Ambiente</Label>
              <span className="text-xs text-muted-foreground">{ambientVolume.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={ambientVolume}
              onChange={(e) => setAmbientVolume(parseFloat(e.target.value))}
              disabled={running}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
        </div>

        {/* Fine-tune manual offset */}
        <div className="space-y-1.5 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Ajuste manual fino</Label>
            <span className="text-xs font-mono text-muted-foreground">
              {manualAdjustMs > 0 ? '+' : ''}{manualAdjustMs}ms
            </span>
          </div>
          <input
            type="range"
            min={-200}
            max={200}
            step={1}
            value={manualAdjustMs}
            onChange={(e) => setManualAdjustMs(parseInt(e.target.value))}
            disabled={running}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/60">
            <span>-200ms</span>
            <button
              className="text-primary hover:underline"
              onClick={() => setManualAdjustMs(0)}
            >
              Reset
            </button>
            <span>+200ms</span>
          </div>
          <p className="text-[10px] text-muted-foreground/60">
            Si oyes eco, ajusta hasta que la voz de mesa y la del ambiente coincidan.
            Negativo = mesa empieza antes, Positivo = mesa empieza después.
          </p>
        </div>

        {running && <Progress value={progress} className="h-2" />}

        {!running && outputName && mixUrl && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileAudio className="h-3.5 w-3.5 text-primary flex-none" />
              <span className="font-mono truncate">{outputName}</span>
            </div>
            <AudioPlayer src={mixUrl} label="Reproducir mezcla" />
          </div>
        )}

        <Button onClick={handleMix} disabled={running} className="w-full">
          {running ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Mezclando... {Math.round(progress)}%
            </>
          ) : (
            <>
              <Blend className="mr-2 h-4 w-4" />
              {outputName ? 'Re-generar mezcla' : 'Generar mezcla'}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
