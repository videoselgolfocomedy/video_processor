'use client';

import { useState, useCallback, useEffect } from 'react';
import { useSSE } from '@/hooks/use-sse';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Loader2, Scissors, CheckCircle, Info } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface DemucsPanelProps {
  projectId: string;
  demucsStatus: 'idle' | 'running' | 'done' | 'error';
  hasAudioTracks: boolean;
  onComplete: () => void;
  onProgressChange?: (progress: number, running: boolean) => void;
}

export function DemucsPanel({
  projectId,
  demucsStatus,
  hasAudioTracks,
  onComplete,
  onProgressChange,
}: DemucsPanelProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
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
      toast({ title: 'Separación de pistas completada' });
    },
    onError: (err) => {
      setRunning(false);
      setJobId(null);
      toast({ title: 'Demucs falló', description: err, variant: 'destructive' });
    },
  });

  const handleRun = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    setMessage('Iniciando Demucs...');
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/demucs`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to start Demucs');
      const data = await res.json();
      setJobId(data.jobId);
    } catch {
      setRunning(false);
      toast({ title: 'No se pudo iniciar Demucs', variant: 'destructive' });
    }
  }, [projectId, toast]);

  const handleCancel = useCallback(async () => {
    if (jobId) {
      await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      setRunning(false);
      setJobId(null);
    }
  }, [jobId]);

  if (!hasAudioTracks) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Primero extrae el audio para usar la separación de pistas
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Separación de Pistas (Demucs)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Explanation */}
        <div className="rounded-md border border-border bg-secondary/50 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Info className="h-4 w-4 text-primary mt-0.5 flex-none" />
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <p>
                <strong className="text-foreground">Demucs</strong> es un modelo de IA (Meta/Facebook Research) que separa una pista de audio en sus componentes: <strong className="text-blue-400">voz</strong>, <strong className="text-green-400">bajo</strong>, <strong className="text-yellow-400">batería</strong> y <strong className="text-purple-400">otros</strong> (ambiente, música, ruido).
              </p>
              <p>
                <strong className="text-foreground">En este proyecto:</strong> toma el audio de la cámara y extrae por separado la <strong className="text-blue-400">voz</strong> (que descartamos, porque tenemos el audio limpio de mesa) y el <strong className="text-purple-400">ambiente</strong> (aplausos, risas, ruido de sala) que queremos conservar para la mezcla final.
              </p>
              <p>
                El resultado son 2 archivos WAV: <code className="rounded bg-muted px-1">vocals.wav</code> y <code className="rounded bg-muted px-1">no_vocals.wav</code> (ambiente). El proceso usa la CPU y puede tardar varios minutos según la duración del audio.
              </p>
            </div>
          </div>
        </div>

        {demucsStatus === 'done' && !running && (
          <div className="flex items-center gap-2 text-sm text-green-500">
            <CheckCircle className="h-4 w-4" />
            Pistas separadas correctamente
          </div>
        )}

        {running && (
          <div className="space-y-2">
            <Progress value={progress} className="h-2" />
            <p className="text-xs text-muted-foreground">{message}</p>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleRun}
            disabled={running || demucsStatus === 'running'}
          >
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Procesando... {Math.round(progress)}%
              </>
            ) : demucsStatus === 'done' ? (
              <>
                <Scissors className="mr-2 h-4 w-4" />
                Re-ejecutar Demucs
              </>
            ) : (
              <>
                <Scissors className="mr-2 h-4 w-4" />
                Ejecutar Demucs
              </>
            )}
          </Button>
          {running && (
            <Button variant="outline" onClick={handleCancel}>
              Cancelar
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
