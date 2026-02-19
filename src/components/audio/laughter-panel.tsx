'use client';

import { useState, useCallback, useEffect } from 'react';
import { useSSE } from '@/hooks/use-sse';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Loader2, Laugh, CheckCircle, Hand, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { LaughterSegment } from '@/types/project';

interface LaughterPanelProps {
  projectId: string;
  laughterStatus: 'idle' | 'running' | 'done' | 'error';
  hasAmbientAudio: boolean;
  segments: LaughterSegment[];
  onComplete: () => void;
  onProgressChange?: (progress: number, running: boolean) => void;
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const frac = Math.floor((ms % 1000) / 100);
  return `${m}:${String(sec).padStart(2, '0')}.${frac}`;
}

function SegmentBadge({ label }: { label: string }) {
  const colors: Record<string, string> = {
    laugh: 'bg-yellow-500/20 text-yellow-400',
    applause: 'bg-blue-500/20 text-blue-400',
    reaction: 'bg-purple-500/20 text-purple-400',
  };
  const icons: Record<string, React.ReactNode> = {
    laugh: <Laugh className="h-3 w-3" />,
    applause: <Hand className="h-3 w-3" />,
    reaction: <Sparkles className="h-3 w-3" />,
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${colors[label] || colors.reaction}`}>
      {icons[label] || icons.reaction}
      {label}
    </span>
  );
}

export function LaughterPanel({
  projectId,
  laughterStatus,
  hasAmbientAudio,
  segments,
  onComplete,
  onProgressChange,
}: LaughterPanelProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [threshold, setThreshold] = useState(2.0);
  const [minDuration, setMinDuration] = useState(300);
  const { toast } = useToast();

  useEffect(() => {
    onProgressChange?.(progress, running);
  }, [progress, running, onProgressChange]);

  useSSE({
    jobId,
    onProgress: (prog, msg) => {
      setProgress(prog);
      setMessage(msg);
    },
    onComplete: () => {
      setRunning(false);
      setJobId(null);
      onComplete();
      toast({ title: 'Detección de risas completada' });
    },
    onError: (err) => {
      setRunning(false);
      setJobId(null);
      toast({ title: 'Detección falló', description: err, variant: 'destructive' });
    },
  });

  const handleRun = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    setMessage('Iniciando detección...');
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/laughter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threshold,
          minDurationMs: minDuration,
          mergeGapMs: 500,
          windowMs: 50,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to start detection');
      }
      const data = await res.json();
      setJobId(data.jobId);
    } catch (err) {
      setRunning(false);
      toast({
        title: 'No se pudo iniciar la detección',
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  }, [projectId, threshold, minDuration, toast]);

  if (!hasAmbientAudio) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Ejecuta la sustracción de voz primero para obtener el audio de ambiente
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Detección de Risas y Aplausos
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Sensitivity controls */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Sensibilidad</Label>
              <span className="text-xs text-muted-foreground">{threshold}x</span>
            </div>
            <input
              type="range"
              min={1}
              max={5}
              step={0.1}
              value={threshold}
              onChange={(e) => setThreshold(parseFloat(e.target.value))}
              disabled={running}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
            <p className="text-xs text-muted-foreground">
              Menor = más sensible, mayor = solo picos fuertes
            </p>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Duración mínima</Label>
              <span className="text-xs text-muted-foreground">{minDuration}ms</span>
            </div>
            <input
              type="range"
              min={100}
              max={2000}
              step={50}
              value={minDuration}
              onChange={(e) => setMinDuration(parseInt(e.target.value))}
              disabled={running}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
        </div>

        {/* Results */}
        {laughterStatus === 'done' && !running && segments.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-green-500">
              <CheckCircle className="h-4 w-4" />
              {segments.length} segmento{segments.length !== 1 ? 's' : ''} detectado{segments.length !== 1 ? 's' : ''}
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1.5 rounded-md border border-border p-2">
              {segments.map((seg) => (
                <div
                  key={seg.id}
                  className="flex items-center gap-2 rounded bg-secondary/50 px-2 py-1.5 text-xs"
                >
                  <span className="font-mono text-muted-foreground">
                    {formatMs(seg.startMs)} - {formatMs(seg.endMs)}
                  </span>
                  <SegmentBadge label={seg.label} />
                  <span className="text-muted-foreground ml-auto">
                    {(seg.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {laughterStatus === 'done' && !running && segments.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No se detectaron segmentos. Prueba reducir la sensibilidad.
          </p>
        )}

        {running && (
          <div className="space-y-2">
            <Progress value={progress} className="h-2" />
            <p className="text-xs text-muted-foreground">{message}</p>
          </div>
        )}

        <Button
          onClick={handleRun}
          disabled={running || laughterStatus === 'running'}
          className="w-full"
        >
          {running ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Analizando... {Math.round(progress)}%
            </>
          ) : laughterStatus === 'done' ? (
            <>
              <Laugh className="mr-2 h-4 w-4" />
              Re-analizar
            </>
          ) : (
            <>
              <Laugh className="mr-2 h-4 w-4" />
              Detectar risas y aplausos
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
