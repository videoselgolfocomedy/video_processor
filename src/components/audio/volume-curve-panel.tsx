'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Info } from 'lucide-react';
import type { VolumeCurvePoint, LaughterSegment } from '@/types/project';

interface VolumeCurvePanelProps {
  volumeCurve: VolumeCurvePoint[];
  segments: LaughterSegment[];
  audioDurationMs?: number;
}

export function VolumeCurvePanel({
  volumeCurve,
  segments,
  audioDurationMs,
}: VolumeCurvePanelProps) {
  if (volumeCurve.length === 0) {
    return null;
  }

  const maxTime = audioDurationMs || (volumeCurve.length > 0
    ? volumeCurve[volumeCurve.length - 1].timeMs
    : 0);
  const maxVol = Math.max(...volumeCurve.map((p) => p.volume), 1);

  // SVG dimensions
  const width = 600;
  const height = 100;
  const padding = { left: 30, right: 10, top: 5, bottom: 20 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  // Build path
  const points = volumeCurve.map((p) => ({
    x: padding.left + (p.timeMs / maxTime) * plotW,
    y: padding.top + plotH - (p.volume / maxVol) * plotH,
  }));

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  // Segment rectangles
  const segRects = segments.map((s) => ({
    x: padding.left + (s.startMs / maxTime) * plotW,
    w: ((s.endMs - s.startMs) / maxTime) * plotW,
    label: s.label,
  }));

  const segColors: Record<string, string> = {
    laugh: 'rgba(234, 179, 8, 0.2)',
    applause: 'rgba(59, 130, 246, 0.2)',
    reaction: 'rgba(168, 85, 247, 0.2)',
  };

  // Time labels
  const totalSec = maxTime / 1000;
  const labelCount = Math.min(6, Math.floor(totalSec / 10) + 1);
  const labels = Array.from({ length: labelCount }, (_, i) => {
    const sec = Math.round((totalSec * i) / (labelCount - 1));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return { text: `${m}:${String(s).padStart(2, '0')}`, x: padding.left + (i / (labelCount - 1)) * plotW };
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Curva de Volumen de Ambiente
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border bg-secondary/30 p-2">
          <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
            {/* Grid line at volume 1.0 */}
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={padding.top + plotH - (1 / maxVol) * plotH}
              y2={padding.top + plotH - (1 / maxVol) * plotH}
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeDasharray="4 4"
            />
            <text
              x={padding.left - 4}
              y={padding.top + plotH - (1 / maxVol) * plotH + 3}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize={8}
            >
              1x
            </text>

            {/* Segment highlight rectangles */}
            {segRects.map((r, i) => (
              <rect
                key={i}
                x={r.x}
                y={padding.top}
                width={Math.max(r.w, 1)}
                height={plotH}
                fill={segColors[r.label] || segColors.reaction}
              />
            ))}

            {/* Volume curve */}
            <path
              d={pathD}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />

            {/* Time labels */}
            {labels.map((l, i) => (
              <text
                key={i}
                x={l.x}
                y={height - 4}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize={8}
              >
                {l.text}
              </text>
            ))}
          </svg>
        </div>

        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 flex-none" />
          <p>
            La curva muestra la energía relativa del ambiente. Las zonas coloreadas son segmentos detectados:
            <span className="text-yellow-400 ml-1">risas</span>,
            <span className="text-blue-400 ml-1">aplausos</span>,
            <span className="text-purple-400 ml-1">reacciones</span>.
            Esta curva se aplica como volumen dinámico del ambiente en la mezcla final.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
