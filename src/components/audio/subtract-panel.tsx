'use client';

import { useState, useCallback, useEffect } from 'react';
import { useSSE } from '@/hooks/use-sse';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Loader2, Waves, CheckCircle, Info, FileAudio } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { AudioPlayer } from '@/components/audio/audio-player';
import { WaveformView } from '@/components/audio/waveform-view';
import { AlignmentView } from '@/components/audio/alignment-view';
import type { SourceFile, AudioTrack } from '@/types/project';

interface SubtractPanelProps {
  projectId: string;
  subtractionStatus: 'idle' | 'running' | 'done' | 'error';
  hasRequiredAudio: boolean;
  boardSource?: SourceFile;
  cameraSource?: SourceFile;
  cameraTrack?: AudioTrack;
  ambientPath?: string;
  onComplete: () => void;
  onProgressChange?: (progress: number, running: boolean) => void;
}

type SubtractionMethod = 'spectral' | 'nlms';

export function SubtractPanel({
  projectId,
  subtractionStatus,
  hasRequiredAudio,
  boardSource,
  cameraSource,
  cameraTrack,
  ambientPath,
  onComplete,
  onProgressChange,
}: SubtractPanelProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [alignOnly, setAlignOnly] = useState(false);
  const [method, setMethod] = useState<SubtractionMethod>('spectral');
  const [alpha, setAlpha] = useState(1.5);
  const [floor, setFloor] = useState(0.02);
  const [filterLength, setFilterLength] = useState(2048);
  const [mu, setMu] = useState(0.5);
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
      setCacheBust(Date.now());
      onComplete();
      toast({ title: alignOnly ? 'Alineación completada' : 'Sustracción de voz completada' });
    },
    onError: (err) => {
      setRunning(false);
      setJobId(null);
      toast({ title: 'Sustracción falló', description: err, variant: 'destructive' });
    },
  });

  const handleRun = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    setMessage(alignOnly ? 'Iniciando alineación...' : 'Iniciando sustracción...');
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/subtract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, alpha, floor, filterLength, mu, alignOnly }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to start subtraction');
      }
      const data = await res.json();
      setJobId(data.jobId);
    } catch (err) {
      setRunning(false);
      toast({
        title: 'No se pudo iniciar la sustracción',
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  }, [projectId, method, alpha, floor, filterLength, mu, alignOnly, toast]);

  const handleCancel = useCallback(async () => {
    if (jobId) {
      await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      setRunning(false);
      setJobId(null);
    }
  }, [jobId]);

  // Build audio URLs for player/waveform (cache-bust to avoid stale browser cache)
  const [cacheBust, setCacheBust] = useState(() => Date.now());
  const audioFileUrl = (name: string) =>
    `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(name)}&t=${cacheBust}`;

  const ambientFileName = ambientPath ? ambientPath.split('/').pop() || 'ambient.wav' : null;
  const ambientUrl = ambientFileName ? audioFileUrl(ambientFileName) : null;

  if (!hasRequiredAudio) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Necesitas audio de mesa y cámara extraído para la sustracción guiada
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Alineación y Sustracción de Voz
          <span className="text-[10px] text-muted-foreground/60 font-normal ml-1.5">(opcional)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Explanation */}
        <div className="rounded-md border border-border bg-secondary/50 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Info className="h-4 w-4 text-primary mt-0.5 flex-none" />
            <div className="space-y-1.5 text-xs text-muted-foreground">
              {alignOnly ? (
                <p>
                  <strong className="text-foreground">Solo alinear</strong>: sincroniza el audio de cámara con el de mesa por correlación cruzada y lo guarda sin modificar. Útil para mezclar con el audio crudo de cámara (con voz incluida).
                </p>
              ) : (
                <>
                  <p>
                    <strong className="text-foreground">Sustracción guiada</strong> usa el audio de mesa como referencia para eliminar la voz del audio de cámara, dejando solo el <strong className="text-green-400">ambiente</strong> (risas, aplausos, ruido de sala).
                  </p>
                  <p>
                    Alinea automáticamente las pistas por envolvente de energía y usa filtrado Wiener con función de transferencia acústica para evitar artefactos.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Input files info — show actual files used in subtraction */}
        <div className="rounded-md border border-border p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Archivos que se usarán</p>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <FileAudio className="h-3.5 w-3.5 text-green-400 flex-none" />
              <span className="text-muted-foreground">Mesa (referencia voz):</span>
              <span className="truncate">{boardSource?.originalName || '—'}</span>
              {boardSource?.duration && (
                <span className="text-muted-foreground ml-auto flex-none">
                  {Math.floor(boardSource.duration / 60)}:{String(Math.floor(boardSource.duration % 60)).padStart(2, '0')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <FileAudio className="h-3.5 w-3.5 text-blue-400 flex-none" />
              <span className="text-muted-foreground">Cámara (audio extraído):</span>
              <span className="truncate">
                {cameraTrack
                  ? cameraTrack.path.split('/').pop()
                  : '—'}
              </span>
              {cameraTrack?.duration && (
                <span className="text-muted-foreground ml-auto flex-none">
                  {Math.floor(cameraTrack.duration / 60)}:{String(Math.floor(cameraTrack.duration % 60)).padStart(2, '0')}
                </span>
              )}
            </div>
            {cameraSource && (
              <p className="text-[10px] text-muted-foreground/60 pl-5">
                extraído de {cameraSource.originalName}
              </p>
            )}
          </div>
        </div>

        {/* Mode selector: align-only vs subtraction methods */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Modo</Label>
            <div className="flex gap-1">
              <button
                className={`flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors ${
                  alignOnly
                    ? 'bg-orange-500/20 border-orange-500 text-orange-400'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setAlignOnly(true)}
                disabled={running}
              >
                Solo alinear
              </button>
              <button
                className={`flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors ${
                  !alignOnly && method === 'spectral'
                    ? 'bg-blue-500/20 border-blue-500 text-blue-400'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => { setAlignOnly(false); setMethod('spectral'); }}
                disabled={running}
              >
                Wiener (STFT)
              </button>
              <button
                className={`flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors ${
                  !alignOnly && method === 'nlms'
                    ? 'bg-blue-500/20 border-blue-500 text-blue-400'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => { setAlignOnly(false); setMethod('nlms'); }}
                disabled={running}
              >
                NLMS Adaptativo
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {alignOnly
                ? 'Alinea las pistas sin tocar el audio. Ideal para mezclar con cámara en crudo.'
                : method === 'spectral'
                  ? 'Máscara Wiener con función de transferencia acústica. Sin artefactos musicales.'
                  : 'Filtro adaptativo muestra a muestra. Más lento, puede funcionar mejor en algunos casos.'}
            </p>
          </div>

          {/* Method-specific params (hidden in align-only mode) */}
          {!alignOnly && method === 'spectral' ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Supresión de voz (alpha)</Label>
                  <span className="text-xs text-muted-foreground">{alpha}</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.1}
                  value={alpha}
                  onChange={(e) => setAlpha(parseFloat(e.target.value))}
                  disabled={running}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Piso espectral</Label>
                  <span className="text-xs text-muted-foreground">{floor}</span>
                </div>
                <input
                  type="range"
                  min={0.001}
                  max={0.1}
                  step={0.001}
                  value={floor}
                  onChange={(e) => setFloor(parseFloat(e.target.value))}
                  disabled={running}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
                />
              </div>
            </div>
          ) : !alignOnly ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Longitud del filtro</Label>
                  <span className="text-xs text-muted-foreground">{filterLength}</span>
                </div>
                <input
                  type="range"
                  min={512}
                  max={8192}
                  step={256}
                  value={filterLength}
                  onChange={(e) => setFilterLength(parseInt(e.target.value))}
                  disabled={running}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Paso (mu)</Label>
                  <span className="text-xs text-muted-foreground">{mu}</span>
                </div>
                <input
                  type="range"
                  min={0.01}
                  max={2}
                  step={0.01}
                  value={mu}
                  onChange={(e) => setMu(parseFloat(e.target.value))}
                  disabled={running}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
                />
              </div>
            </div>
          ) : null}
        </div>

        {/* Status + results */}
        {subtractionStatus === 'done' && !running && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-green-500">
              <CheckCircle className="h-4 w-4" />
              {alignOnly ? 'Audio de cámara alineado' : 'Ambiente extraído correctamente'}
            </div>

            {/* Alignment visualization: before & after sync */}
            <AlignmentView projectId={projectId} />

            {/* Result waveform + player */}
            {ambientUrl && ambientFileName && (
              <>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <FileAudio className="h-3.5 w-3.5 text-green-400 flex-none" />
                    <span className="text-muted-foreground">Archivo generado:</span>
                    <span className="font-mono">{ambientFileName}</span>
                  </div>
                  <WaveformView
                    label="Ambiente (resultado)"
                    color="#22c55e"
                    audioUrl={ambientUrl}
                    height={60}
                  />
                </div>
                <AudioPlayer
                  src={ambientUrl}
                  label="Reproducir ambiente"
                />
              </>
            )}
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
            disabled={running || subtractionStatus === 'running'}
          >
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {alignOnly ? 'Alineando' : 'Procesando'}... {Math.round(progress)}%
              </>
            ) : subtractionStatus === 'done' ? (
              <>
                <Waves className="mr-2 h-4 w-4" />
                {alignOnly ? 'Re-alinear' : 'Re-ejecutar sustracción'}
              </>
            ) : (
              <>
                <Waves className="mr-2 h-4 w-4" />
                {alignOnly ? 'Alinear pistas' : 'Extraer ambiente'}
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
