'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Loader2, Sparkles, RotateCcw, CheckCircle, FileAudio } from 'lucide-react';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import { AudioPlayer } from '@/components/audio/audio-player';
import type { AudioCleanupSettings } from '@/types/project';

interface AudioCleanupPanelProps {
  projectId: string;
  cleanupApplied: boolean;
  cameraAmbientPath?: string;
  onComplete: () => void;
}

const defaultSettings: AudioCleanupSettings = {
  eqFrequency: 3500,
  eqGain: -6,
  eqWidth: 2,
  compressorThreshold: -20,
  compressorRatio: 4,
  limiterLevel: 0.95,
  noiseReduction: 7,
  noiseFloor: 0.002,
};

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs text-muted-foreground">
          {value}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
    </div>
  );
}

export function AudioCleanupPanel({
  projectId,
  cleanupApplied,
  cameraAmbientPath,
  onComplete,
}: AudioCleanupPanelProps) {
  const [settings, setSettings] = useState<AudioCleanupSettings>(defaultSettings);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [cacheBust, setCacheBust] = useState(() => Date.now());
  const { toast } = useToast();

  const cleanFileName = cameraAmbientPath?.split('/').pop() || 'ambiente_clean.wav';
  const cleanAudioUrl = cleanupApplied
    ? `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(cleanFileName)}&t=${cacheBust}`
    : null;

  useSSE({
    jobId,
    onProgress: (prog) => setProgress(prog),
    onComplete: () => {
      setRunning(false);
      setJobId(null);
      setCacheBust(Date.now());
      onComplete();
      toast({ title: 'Limpieza de audio completada' });
    },
    onError: (err) => {
      setRunning(false);
      setJobId(null);
      toast({ title: 'Limpieza fallida', description: err, variant: 'destructive' });
    },
  });

  const update = useCallback(
    (key: keyof AudioCleanupSettings, value: number) => {
      setSettings((s) => ({ ...s, [key]: value }));
    },
    []
  );

  const handleApply = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Error ${res.status}`);
      }
      const data = await res.json();
      setJobId(data.jobId);
    } catch (err) {
      setRunning(false);
      toast({
        title: 'No se pudo iniciar la limpieza',
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  }, [projectId, settings, toast]);

  const handleReset = useCallback(() => {
    setSettings(defaultSettings);
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Limpieza de Audio</CardTitle>
          <Button variant="ghost" size="sm" onClick={handleReset}>
            <RotateCcw className="mr-1 h-3 w-3" />
            Restablecer
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">Ecualizador</p>
            <Slider
              label="Frecuencia"
              value={settings.eqFrequency}
              min={100}
              max={10000}
              step={100}
              unit=" Hz"
              onChange={(v) => update('eqFrequency', v)}
            />
            <Slider
              label="Ganancia"
              value={settings.eqGain}
              min={-20}
              max={20}
              step={1}
              unit=" dB"
              onChange={(v) => update('eqGain', v)}
            />
            <Slider
              label="Ancho"
              value={settings.eqWidth}
              min={0.1}
              max={10}
              step={0.1}
              onChange={(v) => update('eqWidth', v)}
            />
          </div>

          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">
              Dinámica
            </p>
            <Slider
              label="Umbral del compresor"
              value={settings.compressorThreshold}
              min={-60}
              max={0}
              step={1}
              unit=" dB"
              onChange={(v) => update('compressorThreshold', v)}
            />
            <Slider
              label="Ratio del compresor"
              value={settings.compressorRatio}
              min={1}
              max={20}
              step={0.5}
              unit=":1"
              onChange={(v) => update('compressorRatio', v)}
            />
            <Slider
              label="Limitador"
              value={settings.limiterLevel}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => update('limiterLevel', v)}
            />
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            Reducción de Ruido
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Slider
              label="Intensidad"
              value={settings.noiseReduction}
              min={0}
              max={20}
              step={1}
              onChange={(v) => update('noiseReduction', v)}
            />
            <Slider
              label="Piso de ruido"
              value={settings.noiseFloor}
              min={0.001}
              max={0.1}
              step={0.001}
              onChange={(v) => update('noiseFloor', v)}
            />
          </div>
        </div>

        {/* Result */}
        {cleanupApplied && !running && (
          <div className="space-y-2 rounded-md border border-green-500/20 bg-green-500/5 p-3">
            <div className="flex items-center gap-2 text-sm text-green-500">
              <CheckCircle className="h-4 w-4" />
              Limpieza aplicada
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileAudio className="h-3.5 w-3.5 text-green-400 flex-none" />
              <span>Archivo:</span>
              <span className="font-mono">{cleanFileName}</span>
            </div>
            {cleanAudioUrl && (
              <AudioPlayer src={cleanAudioUrl} label="Reproducir audio limpio" />
            )}
          </div>
        )}

        {running && <Progress value={progress} className="h-2" />}

        <Button onClick={handleApply} disabled={running} className="w-full">
          {running ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Procesando... {Math.round(progress)}%
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {cleanupApplied ? 'Re-aplicar limpieza' : 'Aplicar limpieza'}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
