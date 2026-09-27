'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import type { PartsConcatState, ProjectPart } from '@/types/project';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Combine,
  Loader2,
  XCircle,
} from 'lucide-react';
import { formatDurationMs } from './part-card';

interface PartsConcatCardProps {
  parts: ProjectPart[];
  concat: PartsConcatState | null;
  projectId: string;
  hasExistingMux: boolean;
  onRefresh: () => void;
}

export function PartsConcatCard({
  parts,
  concat,
  projectId,
  hasExistingMux,
  onRefresh,
}: PartsConcatCardProps) {
  const { toast } = useToast();

  const [localJobId, setLocalJobId] = useState<string | null>(null);
  const [sseProgress, setSseProgress] = useState<number | null>(null);
  const [sseMessage, setSseMessage] = useState('');

  const anyProcessing = parts.some((p) => p.status === 'processing');
  const allDone = parts.length > 0 && parts.every((p) => p.status === 'done');
  // Audio-only re-mixes refresh the audio master (sync.mixedAudioPath) without
  // rewriting this video, so its embedded track can be older than the mix.
  const newestMixAt = parts.reduce<string | null>((acc, p) => (p.mixedAt && (!acc || p.mixedAt > acc) ? p.mixedAt : acc), null);
  const joinedAudioStale = concat?.status === 'done' && !!concat.concatenatedAt && !!newestMixAt && newestMixAt > concat.concatenatedAt;
  const isRunning = concat?.status === 'running' || localJobId !== null;
  const activeJobId =
    localJobId ??
    (concat?.status === 'running' && concat.jobId ? concat.jobId : null);

  // Stable callbacks: useSSE's effect depends on these — inline arrows would
  // recreate the EventSource every render (documented project pitfall).
  const handleProgress = useCallback((pct: number, msg: string) => {
    setSseProgress(pct);
    setSseMessage(msg);
  }, []);
  const handleComplete = useCallback(() => {
    setLocalJobId(null);
    setSseProgress(null);
    setSseMessage('');
    toast({
      title: 'Partes unidas',
      description: 'El vídeo muxado final está listo para transcribir.',
    });
    onRefresh();
  }, [onRefresh, toast]);
  const handleError = useCallback(
    (err: string) => {
      setLocalJobId(null);
      setSseProgress(null);
      setSseMessage('');
      toast({
        title: 'Error al unir las partes',
        description: err,
        variant: 'destructive',
      });
      onRefresh();
    },
    [onRefresh, toast]
  );

  useSSE({
    jobId: activeJobId,
    onProgress: handleProgress,
    onComplete: handleComplete,
    onError: handleError,
  });

  const handleJoin = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/parts/concat`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || `Error ${res.status}`
        );
      }
      const data = await res.json();
      setLocalJobId(data.jobId);
      setSseProgress(0);
      setSseMessage('');
      onRefresh();
    } catch (err) {
      toast({
        title: 'No se pudo iniciar la unión',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
  }, [projectId, onRefresh, toast]);

  const knownDurations = parts.filter((p) => p.muxedDurationMs !== undefined);
  const totalMs = knownDurations.reduce(
    (acc, p) => acc + (p.muxedDurationMs ?? 0),
    0
  );

  // Single part: the join runs automatically at the end of that part's mix
  // (an instant clone — see runPartPipeline), so there is nothing to order and
  // no button to press. Show a one-line status; the explicit button only comes
  // back if the auto-join failed or never ran (projects mixed before this).
  if (parts.length === 1) {
    const part = parts[0];
    const needsManual = !isRunning && part.status === 'done' && concat?.status !== 'done';
    return (
      <div className="rounded-md border border-border px-3 py-2 text-xs">
        {isRunning ? (
          <div className="flex items-center gap-1.5 text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {sseMessage || 'Generando el vídeo final…'}
          </div>
        ) : concat?.status === 'done' ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1.5 text-green-500">
              <CheckCircle className="h-3.5 w-3.5 flex-none" />
              Vídeo final listo
              {concat.outputPath ? ` — ${concat.outputPath.split('/').pop()}` : ''}
            </span>
            <span className="text-muted-foreground">
              (una sola parte: se regenera solo cada vez que la mezclas)
            </span>
            <Link
              href={`/project/${projectId}/transcription`}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Ir a Transcripción
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        ) : part.status !== 'done' ? (
          <span className="text-muted-foreground">
            Una sola parte: el vídeo final se genera automáticamente al pulsar
            «Mezclar y muxar» — no hay nada que unir.
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {concat?.status === 'error' && concat.error ? (
              <span className="flex items-center gap-1.5 text-destructive">
                <XCircle className="h-3.5 w-3.5 flex-none" />
                {concat.error}
              </span>
            ) : (
              <span className="text-muted-foreground">
                La parte está mezclada pero el vídeo final aún no se ha generado.
              </span>
            )}
            {needsManual && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleJoin} disabled={anyProcessing}>
                <Combine className="mr-1.5 h-3.5 w-3.5" />
                Generar vídeo final
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Unir en un solo vídeo
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Ordered summary */}
        <div className="space-y-1">
          {parts.map((part, i) => (
            <div
              key={part.id}
              className="flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-xs"
            >
              <span className="w-6 flex-none text-muted-foreground">
                #{i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{part.name}</span>
              {part.status === 'done' ? (
                <span className="flex-none text-muted-foreground">
                  {part.muxedDurationMs !== undefined
                    ? formatDurationMs(part.muxedDurationMs)
                    : '—'}
                </span>
              ) : (
                <span className="flex-none text-amber-500">sin procesar</span>
              )}
            </div>
          ))}
        </div>
        {knownDurations.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Duración total: {formatDurationMs(totalMs)}
          </p>
        )}

        {/* Replace warning */}
        {hasExistingMux && !isRunning && concat?.status !== 'done' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>
              Esto reemplazará el vídeo muxado actual (muxed_*.mp4). Los
              tiempos de clips, subtítulos y reels existentes pueden dejar de
              ser válidos.
            </span>
          </div>
        )}

        {/* Progress while running */}
        {isRunning && (
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-xs text-primary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {sseMessage || 'Uniendo partes…'}
            </div>
            <Progress value={sseProgress ?? 0} className="h-1.5" />
            <p className="mt-1 text-right text-[10px] text-muted-foreground">
              {Math.round(sseProgress ?? 0)}%
            </p>
          </div>
        )}

        {/* Error */}
        {!isRunning && concat?.status === 'error' && concat.error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <XCircle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>{concat.error}</span>
          </div>
        )}

        {/* Joined video carries an older mix than the current audio master */}
        {!isRunning && joinedAudioStale && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>
              La mezcla vigente es más nueva que el audio de este vídeo unido. Compose, Reels,
              el export y la transcripción ya usan la mezcla vigente (el wav maestro), así que
              solo necesitas volver a unir si quieres el audio nuevo dentro del propio vídeo.
            </span>
          </div>
        )}

        {/* Success */}
        {!isRunning && concat?.status === 'done' && (
          <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-xs">
            <div className="flex items-center gap-2 text-green-500">
              <CheckCircle className="h-3.5 w-3.5 flex-none" />
              <span>
                Partes unidas
                {concat.outputPath
                  ? ` — ${concat.outputPath.split('/').pop()}`
                  : ''}
              </span>
            </div>
            <Link
              href={`/project/${projectId}/transcription`}
              className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
            >
              Ir a Transcripción
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        )}

        <Button
          onClick={handleJoin}
          disabled={!allDone || anyProcessing || isRunning}
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uniendo…
            </>
          ) : (
            <>
              <Combine className="mr-2 h-4 w-4" />
              Unir partes
            </>
          )}
        </Button>
        {!allDone && parts.length > 0 && !isRunning && (
          <p className="text-xs text-muted-foreground">
            Procesa todas las partes antes de unirlas.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
