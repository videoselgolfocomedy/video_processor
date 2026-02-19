'use client';

import { useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { STYLE_PRESETS, type StylePreset } from '@/config/subtitle-styles';
import type { SubtitleStyle } from '@/types/project';

interface SubtitleStyleEditorProps {
  style: SubtitleStyle;
  activePreset: string;
  onChange: (style: SubtitleStyle) => void;
  onPresetChange: (presetId: string, style: SubtitleStyle) => void;
}

function SliderControl({
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

export function SubtitleStyleEditor({
  style,
  activePreset,
  onChange,
  onPresetChange,
}: SubtitleStyleEditorProps) {
  const update = useCallback(
    (key: keyof SubtitleStyle, value: SubtitleStyle[keyof SubtitleStyle]) => {
      onChange({ ...style, [key]: value });
    },
    [style, onChange]
  );

  const applyPreset = useCallback(
    (preset: StylePreset) => {
      onPresetChange(preset.id, preset.style);
    },
    [onPresetChange]
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Subtitle Style</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="presets" className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="presets" className="flex-1">Presets</TabsTrigger>
            <TabsTrigger value="custom" className="flex-1">Custom</TabsTrigger>
          </TabsList>

          <TabsContent value="presets">
            <ScrollArea className="h-auto max-h-[50vh]">
              <div className="grid grid-cols-2 gap-2 p-1">
                {STYLE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      activePreset === preset.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-muted-foreground/30'
                    }`}
                    onClick={() => applyPreset(preset)}
                  >
                    <div className="mb-1 text-2xl font-bold">
                      {preset.thumbnail}
                    </div>
                    <div className="text-xs font-medium">{preset.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {preset.description}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="custom">
            <ScrollArea className="h-auto max-h-[50vh]">
              <div className="space-y-4 p-1">
                {/* Font */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Font
                  </Label>
                  <select
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    value={style.fontFamily}
                    onChange={(e) => update('fontFamily', e.target.value)}
                  >
                    {[
                      'Inter',
                      'Arial',
                      'Helvetica',
                      'Georgia',
                      'Times New Roman',
                      'Verdana',
                      'Trebuchet MS',
                      'Impact',
                      'Comic Sans MS',
                      'Courier New',
                      'Lucida Console',
                      'Palatino',
                      'Garamond',
                      'Futura',
                      'Roboto',
                      'Open Sans',
                      'Montserrat',
                      'Oswald',
                      'Bebas Neue',
                    ].map((f) => (
                      <option key={f} value={f} style={{ fontFamily: f }}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <SliderControl
                    label="Size"
                    value={style.fontSize}
                    min={16}
                    max={120}
                    step={1}
                    unit="px"
                    onChange={(v) => update('fontSize', v)}
                  />
                  <SliderControl
                    label="Weight"
                    value={style.fontWeight}
                    min={100}
                    max={900}
                    step={100}
                    onChange={(v) => update('fontWeight', v)}
                  />
                  <SliderControl
                    label="Line Height"
                    value={style.lineHeight}
                    min={0.8}
                    max={2.5}
                    step={0.1}
                    onChange={(v) => update('lineHeight', v)}
                  />
                </div>

                {/* Colors */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Colors
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[10px]">Text</Label>
                      <Input
                        type="color"
                        className="h-8 w-full"
                        value={style.color}
                        onChange={(e) => update('color', e.target.value)}
                      />
                    </div>
                    <div>
                      <Label className="text-[10px]">Highlight</Label>
                      <Input
                        type="color"
                        className="h-8 w-full"
                        value={style.highlightColor}
                        onChange={(e) => update('highlightColor', e.target.value)}
                      />
                    </div>
                    <div>
                      <Label className="text-[10px]">Stroke</Label>
                      <Input
                        type="color"
                        className="h-8 w-full"
                        value={style.strokeColor}
                        onChange={(e) => update('strokeColor', e.target.value)}
                      />
                    </div>
                    <div>
                      <Label className="text-[10px]">Background</Label>
                      <Input
                        type="color"
                        className="h-8 w-full"
                        value={style.backgroundColor === 'transparent' ? '#000000' : style.backgroundColor}
                        onChange={(e) => update('backgroundColor', e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* Stroke & Shadow */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Effects
                  </Label>
                  <SliderControl
                    label="Stroke Width"
                    value={style.strokeWidth}
                    min={0}
                    max={10}
                    step={0.5}
                    unit="px"
                    onChange={(v) => update('strokeWidth', v)}
                  />
                  <SliderControl
                    label="Shadow Blur"
                    value={style.shadowBlur}
                    min={0}
                    max={30}
                    step={1}
                    unit="px"
                    onChange={(v) => update('shadowBlur', v)}
                  />
                  <SliderControl
                    label="Background Padding"
                    value={style.backgroundPadding}
                    min={0}
                    max={30}
                    step={1}
                    unit="px"
                    onChange={(v) => update('backgroundPadding', v)}
                  />
                </div>

                {/* Position */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Position
                  </Label>
                  <div className="flex gap-1">
                    {(['top', 'center', 'bottom'] as const).map((pos) => (
                      <Button
                        key={pos}
                        variant={style.position === pos ? 'default' : 'outline'}
                        size="sm"
                        className="flex-1 text-xs"
                        onClick={() => update('position', pos)}
                      >
                        {pos}
                      </Button>
                    ))}
                  </div>
                  <SliderControl
                    label="Margin"
                    value={style.marginBottom}
                    min={0}
                    max={300}
                    step={5}
                    unit="px"
                    onChange={(v) => update('marginBottom', v)}
                  />
                  <SliderControl
                    label="Max Width"
                    value={style.maxWidth}
                    min={200}
                    max={1800}
                    step={10}
                    unit="px"
                    onChange={(v) => update('maxWidth', v)}
                  />
                </div>

                {/* Animation */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Animation
                  </Label>
                  <div className="flex flex-wrap gap-1">
                    {(['none', 'fade', 'typewriter', 'word-highlight', 'pop'] as const).map(
                      (anim) => (
                        <Button
                          key={anim}
                          variant={style.animation === anim ? 'default' : 'outline'}
                          size="sm"
                          className="text-xs"
                          onClick={() => update('animation', anim)}
                        >
                          {anim}
                        </Button>
                      )
                    )}
                  </div>
                </div>

                {/* Text Transform */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Transform
                  </Label>
                  <div className="flex gap-1">
                    {(['none', 'uppercase', 'lowercase'] as const).map((t) => (
                      <Button
                        key={t}
                        variant={style.textTransform === t ? 'default' : 'outline'}
                        size="sm"
                        className="flex-1 text-xs"
                        onClick={() => update('textTransform', t)}
                      >
                        {t}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
