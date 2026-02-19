'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Volume2 } from 'lucide-react';

interface AudioMixerProps {
  boardVolume: number;
  cameraAmbientVolume: number;
  onBoardVolumeChange: (v: number) => void;
  onCameraAmbientVolumeChange: (v: number) => void;
  onMix: () => void;
  mixing?: boolean;
}

function Fader({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs text-muted-foreground">
          {Math.round(value * 100)}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
    </div>
  );
}

export function AudioMixer({
  boardVolume,
  cameraAmbientVolume,
  onBoardVolumeChange,
  onCameraAmbientVolumeChange,
  onMix,
  mixing,
}: AudioMixerProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Audio Mixer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Mesa = voz limpia del mixer · Ambiente = sonido de sala (cámara sin voz)
        </p>
        <Fader
          label="Mesa (Voz)"
          value={boardVolume}
          onChange={onBoardVolumeChange}
        />
        <Fader
          label="Ambiente (Cámara)"
          value={cameraAmbientVolume}
          onChange={onCameraAmbientVolumeChange}
        />
        <Button onClick={onMix} disabled={mixing} className="w-full">
          <Volume2 className="mr-2 h-4 w-4" />
          {mixing ? 'Mezclando...' : 'Generar Mezcla'}
        </Button>
      </CardContent>
    </Card>
  );
}
