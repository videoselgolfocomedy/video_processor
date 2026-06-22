'use client';

import { useState } from 'react';
import { Bold, RotateCcw } from 'lucide-react';
import { useRecentColors } from '@/hooks/use-recent-colors';
import type { SegmentStyleUpdate } from '@/lib/subtitle-utils';

/**
 * Style controls shown when one or more subtitle segments are selected in the
 * timeline. Applies color / size / bold to ALL selected segments at once
 * (same per-word mechanism as the word editor). Remembers recently-used colors
 * as quick swatches (shared across compose + reels via localStorage).
 */
export function SubtitleSelectionStyleBar({
  count,
  onApply,
}: {
  count: number;
  onApply: (update: SegmentStyleUpdate) => void;
}) {
  const { recentColors, pushColor } = useRecentColors();
  const [color, setColor] = useState('#ffd700');
  const [size, setSize] = useState(60);

  if (count === 0) return null;

  const applyColor = (hex: string) => {
    setColor(hex);
    pushColor(hex);
    onApply({ color: hex });
  };

  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-2 space-y-2">
      <div className="text-[11px] font-medium text-primary">
        {count} subtítulo{count === 1 ? '' : 's'} seleccionado{count === 1 ? '' : 's'} — estilo
      </div>

      {/* Color row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground w-10">Color</span>
        <input
          type="color"
          value={color}
          onChange={(e) => applyColor(e.target.value)}
          className="w-6 h-6 rounded cursor-pointer border border-border p-0"
          title="Aplicar color a los subtítulos seleccionados"
        />
        {/* Recent color swatches */}
        {recentColors.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => applyColor(c)}
            className="w-5 h-5 rounded border border-border/60 hover:scale-110 transition-transform"
            style={{ backgroundColor: c }}
            title={`Aplicar ${c}`}
          />
        ))}
        <button
          type="button"
          onClick={() => onApply({ color: null })}
          className="text-[10px] text-muted-foreground hover:text-foreground ml-auto"
          title="Quitar color personalizado"
        >
          quitar
        </button>
      </div>

      {/* Size row */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground w-10">Tamaño</span>
        <input
          type="range" min={16} max={300} step={1}
          value={size}
          onChange={(e) => { const v = parseInt(e.target.value); setSize(v); onApply({ fontSize: v }); }}
          className="flex-1 h-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
        />
        <span className="text-[10px] text-foreground w-8 text-right font-mono">{size}px</span>
        <button
          type="button"
          onClick={() => onApply({ fontSize: null })}
          className="text-[10px] text-muted-foreground hover:text-foreground"
          title="Tamaño por defecto"
        >
          x
        </button>
      </div>

      {/* Bold + reset */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onApply({ bold: true })}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-border text-[10px] text-muted-foreground hover:text-foreground"
          title="Negrita"
        >
          <Bold className="h-3 w-3" /> Negrita
        </button>
        <button
          type="button"
          onClick={() => onApply({ bold: false })}
          className="px-2 py-0.5 rounded border border-border text-[10px] text-muted-foreground hover:text-foreground"
          title="Quitar negrita"
        >
          Normal
        </button>
        <button
          type="button"
          onClick={() => onApply({ reset: true })}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-border text-[10px] text-muted-foreground hover:text-red-400 ml-auto"
          title="Resetear todo el estilo personalizado de los subtítulos seleccionados"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
      </div>
    </div>
  );
}
