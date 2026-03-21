'use client';

import { useCallback, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { STYLE_PRESETS, getCustomPresets, saveCustomPreset, deleteCustomPreset, type StylePreset } from '@/config/subtitle-styles';
import { Save, Trash2 } from 'lucide-react';
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

  const [customPresets, setCustomPresets] = useState<StylePreset[]>(() => getCustomPresets());
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [activeTab, setActiveTab] = useState<'presets' | 'custom'>('presets');

  const applyPreset = useCallback(
    (preset: StylePreset) => {
      onPresetChange(preset.id, preset.style);
    },
    [onPresetChange]
  );

  const handleSavePreset = useCallback(() => {
    if (!presetName.trim()) return;
    const preset = saveCustomPreset(presetName.trim(), style);
    setCustomPresets(getCustomPresets());
    onPresetChange(preset.id, preset.style);
    setPresetName('');
    setSavingPreset(false);
  }, [presetName, style, onPresetChange]);

  const handleDeletePreset = useCallback((id: string) => {
    deleteCustomPreset(id);
    setCustomPresets(getCustomPresets());
  }, []);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Subtitle Style</h3>

      {/* Tab buttons */}
      <div className="flex gap-1 rounded-lg bg-muted p-0.5">
        <button
          className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            activeTab === 'presets' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('presets')}
        >
          Presets
        </button>
        <button
          className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            activeTab === 'custom' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('custom')}
        >
          Custom
        </button>
      </div>

      {/* Presets tab */}
      {activeTab === 'presets' && (
        <div className="grid grid-cols-2 gap-2">
          {STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={`rounded-lg border p-2 text-left transition-colors ${
                activePreset === preset.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/30'
              }`}
              onClick={() => applyPreset(preset)}
            >
              <div className="mb-0.5 text-lg font-bold leading-tight">
                {preset.thumbnail}
              </div>
              <div className="text-[10px] font-medium">{preset.name}</div>
              <div className="text-[9px] text-muted-foreground leading-tight">
                {preset.description}
              </div>
            </button>
          ))}

          {/* Custom presets */}
          {customPresets.map((preset) => (
            <div
              key={preset.id}
              className={`relative rounded-lg border p-2 text-left transition-colors cursor-pointer ${
                activePreset === preset.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/30'
              }`}
              onClick={() => applyPreset(preset)}
            >
              <div className="mb-0.5 text-lg font-bold leading-tight">
                {preset.thumbnail}
              </div>
              <div className="text-[10px] font-medium">{preset.name}</div>
              <div className="text-[9px] text-muted-foreground">Custom</div>
              <button
                className="absolute top-1 right-1 p-0.5 text-muted-foreground hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeletePreset(preset.id);
                }}
                title="Delete preset"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Custom tab */}
      {activeTab === 'custom' && (
        <div className="space-y-3">
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
              max={300}
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
              max={3.0}
              step={0.1}
              unit="x"
              onChange={(v) => update('lineHeight', v)}
            />
          </div>

          {/* Effects */}
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

          {/* Colors */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              Colors
            </Label>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <Label className="text-[10px]">Text</Label>
                <Input
                  type="color"
                  className="h-7 w-full"
                  value={style.color}
                  onChange={(e) => update('color', e.target.value)}
                />
              </div>
              <div>
                <Label className="text-[10px]">Highlight</Label>
                <Input
                  type="color"
                  className="h-7 w-full"
                  value={style.highlightColor}
                  onChange={(e) => update('highlightColor', e.target.value)}
                />
              </div>
              <div>
                <Label className="text-[10px]">Stroke</Label>
                <Input
                  type="color"
                  className="h-7 w-full"
                  value={style.strokeColor}
                  onChange={(e) => update('strokeColor', e.target.value)}
                />
              </div>
              <div>
                <Label className="text-[10px]">BG</Label>
                <Input
                  type="color"
                  className="h-7 w-full"
                  value={style.backgroundColor === 'transparent' ? '#000000' : style.backgroundColor}
                  onChange={(e) => update('backgroundColor', e.target.value)}
                />
              </div>
            </div>
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
              max={500}
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
              {(['none', 'fade', 'typewriter', 'word-highlight', 'pop', 'punchline'] as const).map(
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
      )}

      {/* Save current as preset */}
      <div className="pt-2 border-t border-border">
        {savingPreset ? (
          <div className="flex gap-1">
            <Input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSavePreset();
                if (e.key === 'Escape') setSavingPreset(false);
                e.stopPropagation();
              }}
              placeholder="Preset name..."
              className="h-7 text-xs flex-1"
              autoFocus
            />
            <Button size="sm" className="h-7 text-xs" onClick={handleSavePreset} disabled={!presetName.trim()}>
              Save
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs h-7"
            onClick={() => setSavingPreset(true)}
          >
            <Save className="mr-1 h-3 w-3" /> Save as Preset
          </Button>
        )}
      </div>
    </div>
  );
}
