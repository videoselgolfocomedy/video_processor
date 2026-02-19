'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SubtitlePreview } from '@/components/subtitles/subtitle-preview';
import { RangeSelector } from '@/components/export/range-selector';
import { EXPORT_PRESETS } from '@/config/export-presets';
import { Monitor, Smartphone, Square, Zap, Film, Info, Subtitles } from 'lucide-react';
import type { ExportPreset, SubtitleSegment, SubtitleStyle, SourceFile } from '@/types/project';

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-xs"
    >
      <div
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
          checked ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </div>
      <span className={checked ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
    </button>
  );
}

interface ExportPanelProps {
  onExport: (preset: ExportPreset, includeSubtitles: boolean, trimInMs: number, trimOutMs: number) => void;
  disabled?: boolean;
  segments?: SubtitleSegment[];
  subtitleStyle?: SubtitleStyle;
  stylePresetName?: string;
  videoSource?: SourceFile;
  videoSrc?: string;
  durationMs?: number;
}

function PresetIcon({ preset }: { preset: ExportPreset }) {
  if (preset.orientation === 'vertical') return <Smartphone className="h-5 w-5" />;
  if (preset.width === preset.height) return <Square className="h-5 w-5" />;
  if (preset.id === 'preview') return <Zap className="h-5 w-5" />;
  return <Monitor className="h-5 w-5" />;
}

function AspectRatioVisual({ preset, sourceWidth, sourceHeight }: {
  preset: ExportPreset;
  sourceWidth: number;
  sourceHeight: number;
}) {
  // Draw a 16:9 rectangle representing the source, with an overlay for the crop
  const containerW = 160;
  const containerH = 90; // 16:9 container

  const sourceAspect = sourceWidth / sourceHeight;
  const presetAspect = preset.width / preset.height;

  // How the crop maps onto the source
  let cropW: number, cropH: number;
  if (presetAspect >= sourceAspect) {
    // Crop is wider or equal: full width, crop top/bottom
    cropW = containerW;
    cropH = containerW / presetAspect;
  } else {
    // Crop is taller: full height, crop sides
    cropH = containerH;
    cropW = containerH * presetAspect;
  }

  // Clamp to container
  cropW = Math.min(cropW, containerW);
  cropH = Math.min(cropH, containerH);

  const offsetX = (containerW - cropW) / 2;
  const offsetY = (containerH - cropH) / 2;

  return (
    <div className="relative" style={{ width: containerW, height: containerH }}>
      {/* Source frame */}
      <div
        className="absolute inset-0 rounded border border-border bg-muted/30"
      />
      {/* Crop overlay */}
      <div
        className="absolute rounded border-2 border-primary bg-primary/10"
        style={{
          left: offsetX,
          top: offsetY,
          width: cropW,
          height: cropH,
        }}
      />
      {/* Label */}
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[9px] font-mono text-primary">
          {preset.width}x{preset.height}
        </span>
      </div>
    </div>
  );
}

export function ExportPanel({
  onExport,
  disabled,
  segments = [],
  subtitleStyle,
  stylePresetName,
  videoSource,
  videoSrc,
  durationMs = 10000,
}: ExportPanelProps) {
  const [selectedPreset, setSelectedPreset] = useState<string>('youtube_1080');
  const [includeSubtitles, setIncludeSubtitles] = useState(true);
  const [trimIn, setTrimIn] = useState(0);
  const [trimOut, setTrimOut] = useState(durationMs);

  // Reset trim range when durationMs changes
  useEffect(() => {
    setTrimIn(0);
    setTrimOut(durationMs);
  }, [durationMs]);

  const hasSubtitles = segments.length > 0 && !!subtitleStyle;

  const activePreset = useMemo(
    () => EXPORT_PRESETS.find((p) => p.id === selectedPreset),
    [selectedPreset]
  );

  const handleExport = useCallback(() => {
    if (activePreset) onExport(activePreset, includeSubtitles && hasSubtitles, trimIn, trimOut);
  }, [activePreset, onExport, includeSubtitles, hasSubtitles, trimIn, trimOut]);

  const sourceWidth = videoSource?.resolution?.width || 1920;
  const sourceHeight = videoSource?.resolution?.height || 1080;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Export Presets</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {EXPORT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selectedPreset === preset.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/30'
              }`}
              onClick={() => setSelectedPreset(preset.id)}
            >
              <div
                className={`mt-0.5 ${
                  selectedPreset === preset.id
                    ? 'text-primary'
                    : 'text-muted-foreground'
                }`}
              >
                <PresetIcon preset={preset} />
              </div>
              <div>
                <div className="text-sm font-medium">{preset.name}</div>
                <div className="text-xs text-muted-foreground">
                  {preset.width}x{preset.height} | {preset.fps}fps
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {preset.description}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Range selector */}
        {activePreset && (
          <RangeSelector
            durationMs={durationMs}
            segments={segments}
            inMs={trimIn}
            outMs={trimOut}
            onChange={(newIn, newOut) => { setTrimIn(newIn); setTrimOut(newOut); }}
          />
        )}

        {/* Settings summary + aspect ratio visual */}
        {activePreset && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Settings summary */}
            <Card className="border-border/50 bg-secondary/30">
              <CardContent className="pt-3 pb-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Info className="h-3 w-3" />
                  {activePreset.name}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                  <span className="text-muted-foreground">Resolución</span>
                  <span>{activePreset.width}x{activePreset.height}</span>
                  <span className="text-muted-foreground">FPS</span>
                  <span>{activePreset.fps}</span>
                  <span className="text-muted-foreground">Codec</span>
                  <span>{activePreset.codec.toUpperCase()}</span>
                  <span className="text-muted-foreground">CRF</span>
                  <span>{activePreset.crf}</span>
                  <span className="text-muted-foreground">Audio</span>
                  <span>{activePreset.audioBitrate}</span>
                  {videoSource && (
                    <>
                      <span className="text-muted-foreground">Fuente</span>
                      <span className="truncate">{videoSource.originalName}</span>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Aspect ratio visual */}
            <div className="flex flex-col items-center justify-center gap-2">
              <p className="text-[10px] text-muted-foreground">Recorte de aspecto</p>
              <AspectRatioVisual
                preset={activePreset}
                sourceWidth={sourceWidth}
                sourceHeight={sourceHeight}
              />
              <p className="text-[9px] text-muted-foreground">
                Fuente: {sourceWidth}x{sourceHeight}
              </p>
            </div>
          </div>
        )}

        {/* Subtitles toggle */}
        {activePreset && (
          <Card className="border-border/50 bg-secondary/30">
            <CardContent className="pt-3 pb-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Subtitles className="h-3 w-3" />
                  Subtítulos
                </div>
                <ToggleSwitch
                  checked={includeSubtitles && hasSubtitles}
                  onChange={setIncludeSubtitles}
                  label={includeSubtitles && hasSubtitles ? 'Incluidos' : 'Sin subtítulos'}
                />
              </div>
              {hasSubtitles && includeSubtitles && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                  <span className="text-muted-foreground">Segmentos</span>
                  <span>{segments.length}</span>
                  {stylePresetName && (
                    <>
                      <span className="text-muted-foreground">Estilo</span>
                      <span>{stylePresetName}</span>
                    </>
                  )}
                  {subtitleStyle && (
                    <>
                      <span className="text-muted-foreground">Posición</span>
                      <span>{subtitleStyle.position}</span>
                      <span className="text-muted-foreground">Animación</span>
                      <span>{subtitleStyle.animation}</span>
                    </>
                  )}
                </div>
              )}
              {!hasSubtitles && (
                <p className="text-[10px] text-muted-foreground">
                  No hay subtítulos configurados. Configúralos en la pestaña Subtitles.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Subtitle preview at selected aspect ratio */}
        {activePreset && includeSubtitles && hasSubtitles && subtitleStyle && (
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Vista previa con subtítulos</p>
            <SubtitlePreview
              segments={segments}
              style={subtitleStyle}
              durationMs={durationMs}
              videoSrc={videoSrc}
              width={activePreset.width}
              height={activePreset.height}
              fps={activePreset.fps}
              orientation={activePreset.orientation}
            />
          </div>
        )}

        <Button onClick={handleExport} disabled={disabled} className="w-full">
          <Film className="mr-2 h-4 w-4" />
          Start Export
        </Button>
      </CardContent>
    </Card>
  );
}
