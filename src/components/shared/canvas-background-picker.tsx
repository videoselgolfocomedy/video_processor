'use client';

// Fill color behind the video when its aspect ratio doesn't match the canvas
// (the letterbox/pillarbox bars). Shared between Compose and Reels — both
// composition types persist `backgroundColor` on the same CompositionState,
// and both the live preview and the FFmpeg export read it, so what you pick
// here is exactly what ends up in the rendered video.
const PRESETS: { label: string; value: string }[] = [
  { label: 'Negro', value: '#000000' },
  { label: 'Blanco', value: '#FFFFFF' },
  { label: 'Gris', value: '#808080' },
];

export function CanvasBackgroundPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const normalized = value.toLowerCase();
  const matchesPreset = PRESETS.some((p) => p.value.toLowerCase() === normalized);

  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-muted-foreground mr-1">Fondo:</span>
      {PRESETS.map((preset) => (
        <button
          key={preset.value}
          onClick={() => onChange(preset.value)}
          title={preset.label}
          className={`h-4 w-4 rounded-full border ${
            normalized === preset.value.toLowerCase()
              ? 'border-primary ring-1 ring-primary'
              : 'border-border'
          }`}
          style={{ backgroundColor: preset.value }}
        />
      ))}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Color personalizado"
        className={`h-4 w-5 cursor-pointer rounded border bg-transparent p-0 ${
          matchesPreset ? 'border-border' : 'border-primary ring-1 ring-primary'
        }`}
      />
    </div>
  );
}
