'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Loader2, Volume2, RotateCcw, CheckCircle, FileAudio } from 'lucide-react';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import { AudioPlayer } from '@/components/audio/audio-player';
import type { AudioAmplifySettings } from '@/types/project';

interface AudioAmplifyPanelProps {
  projectId: string;
  amplifyApplied: boolean;
  amplifiedBoardPath?: string;
  boardSourceName?: string;
  onComplete: () => void;
}

const defaultSettings: AudioAmplifySettings = {
  mode: 'loudnorm',
  gainDb: 0,
  targetLUFS: -16,
  truePeak: -1.5,
  compressor: true,
  compressorThreshold: -25,
  compressorRatio: 4,
};

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className={`text-xs ${disabled ? 'text-muted-foreground/50' : ''}`}>{label}</Label>
        <span className={`text-xs ${disabled ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}>
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
        disabled={disabled}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary disabled:opacity-30"
      />
    </div>
  );
}

export function AudioAmplifyPanel({
  projectId,
  amplifyApplied,
  amplifiedBoardPath,
  boardSourceName,
  onComplete,
}: AudioAmplifyPanelProps) {
  const [settings, setSettings] = useState<AudioAmplifySettings>(defaultSettings);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [cacheBust, setCacheBust] = useState(() => Date.now());
  const { toast } = useToast();

  const outputFileName = amplifiedBoardPath?.split('/').pop() || '';
  const audioUrl = amplifyApplied && outputFileName
    ? `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(outputFileName)}&t=${cacheBust}`
    : null;

  useSSE({
    jobId,
    onProgress: (prog) => setProgress(prog),
    onComplete: () => {
      setRunning(false);
      setJobId(null);
      setCacheBust(Date.now());
      onComplete();
      toast({ title: 'Audio de mesa amplificado' });
    },
    onError: (err) => {
      setRunning(false);
      setJobId(null);
      toast({ title: 'Amplificación fallida', description: err, variant: 'destructive' });
    },
  });

  const update = useCallback(
    <K extends keyof AudioAmplifySettings>(key: K, value: AudioAmplifySettings[K]) => {
      setSettings((s) => ({ ...s, [key]: value }));
    },
    []
  );

  const handleApply = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/amplify`, {
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
        title: 'No se pudo iniciar la amplificación',
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  }, [projectId, settings, toast]);

  const handleReset = useCallback(() => {
    setSettings(defaultSettings);
  }, []);

  const usesGain = settings.mode === 'gain' || settings.mode === 'both';
  const usesLoudnorm = settings.mode === 'loudnorm' || settings.mode === 'both';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Amplificar Audio de Mesa</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Normaliza y amplifica el audio del micrófono de mesa
              {boardSourceName && <> ({boardSourceName})</>}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleReset}>
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode selector */}
        <div className="space-y-1.5">
          <Label className="text-xs">Modo</Label>
          <div className="flex gap-1">
            {([
              { value: 'loudnorm', label: 'Normalizar (LUFS)' },
              { value: 'gain', label: 'Ganancia (dB)' },
              { value: 'both', label: 'Ambos' },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                className={`flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors ${
                  settings.mode === opt.value
                    ? 'bg-primary/20 border-primary text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => update('mode', opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Loudness normalization */}
          <div className="space-y-3">
            <p className={`text-xs font-medium ${usesLoudnorm ? 'text-muted-foreground' : 'text-muted-foreground/40'}`}>
              Normalización de volumen
            </p>
            <Slider
              label="LUFS objetivo"
              value={settings.targetLUFS}
              min={-24}
              max={-10}
              step={0.5}
              unit=" LUFS"
              onChange={(v) => update('targetLUFS', v)}
              disabled={!usesLoudnorm}
            />
            <Slider
              label="Pico máximo (True Peak)"
              value={settings.truePeak}
              min={-3}
              max={0}
              step={0.1}
              unit=" dB"
              onChange={(v) => update('truePeak', v)}
              disabled={!usesLoudnorm}
            />
            <p className="text-[10px] text-muted-foreground/60">
              -16 LUFS = estándar para Instagram/YouTube. -14 = más alto.
            </p>
          </div>

          {/* Gain + Dynamics */}
          <div className="space-y-3">
            <p className={`text-xs font-medium ${usesGain ? 'text-muted-foreground' : 'text-muted-foreground/40'}`}>
              Ganancia manual
            </p>
            <Slider
              label="Ganancia"
              value={settings.gainDb}
              min={-20}
              max={30}
              step={0.5}
              unit=" dB"
              onChange={(v) => update('gainDb', v)}
              disabled={!usesGain}
            />

            <p className="text-xs font-medium text-muted-foreground mt-2">Compresor</p>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={settings.compressor}
                onChange={(e) => update('compressor', e.target.checked)}
                className="h-3 w-3 accent-primary"
              />
              Comprimir dinámica antes de amplificar
            </label>
            <Slider
              label="Umbral"
              value={settings.compressorThreshold}
              min={-40}
              max={0}
              step={1}
              unit=" dB"
              onChange={(v) => update('compressorThreshold', v)}
              disabled={!settings.compressor}
            />
            <Slider
              label="Ratio"
              value={settings.compressorRatio}
              min={1}
              max={10}
              step={0.5}
              unit=":1"
              onChange={(v) => update('compressorRatio', v)}
              disabled={!settings.compressor}
            />
          </div>
        </div>

        {/* Result */}
        {amplifyApplied && !running && (
          <div className="space-y-2 rounded-md border border-green-500/20 bg-green-500/5 p-3">
            <div className="flex items-center gap-2 text-sm text-green-500">
              <CheckCircle className="h-4 w-4" />
              Audio amplificado
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileAudio className="h-3.5 w-3.5 text-green-400 flex-none" />
              <span className="font-mono truncate">{outputFileName}</span>
            </div>
            {audioUrl && (
              <AudioPlayer src={audioUrl} label="Reproducir audio amplificado" />
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
              <Volume2 className="mr-2 h-4 w-4" />
              {amplifyApplied ? 'Re-amplificar' : 'Amplificar audio de mesa'}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
