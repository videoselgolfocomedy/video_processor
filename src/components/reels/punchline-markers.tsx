'use client';

import type { PunchlineHint } from '@/types/project';
import { formatTimestamp } from '@/lib/utils';
import { Laugh } from 'lucide-react';

interface PunchlineMarkersProps {
  hints: PunchlineHint[];
  durationMs: number;
  onSelect?: (hint: PunchlineHint) => void;
}

export function PunchlineMarkers({ hints, durationMs, onSelect }: PunchlineMarkersProps) {
  if (hints.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium flex items-center gap-1.5">
        <Laugh className="h-3 w-3 text-yellow-500" />
        Punchlines ({hints.length})
      </h4>

      {/* Visual bar */}
      <div className="relative h-4 bg-secondary rounded-full overflow-hidden">
        {hints.map((hint) => (
          <button
            key={hint.id}
            className="absolute top-0 h-full w-1.5 bg-yellow-500 hover:bg-yellow-400 transition-colors rounded-full"
            style={{
              left: `${(hint.timestampMs / durationMs) * 100}%`,
              opacity: 0.4 + hint.confidence * 0.6,
            }}
            title={`${formatTimestamp(hint.timestampMs)} — ${hint.suggestedLabel ?? 'punchline'}`}
            onClick={() => onSelect?.(hint)}
          />
        ))}
      </div>

      {/* List */}
      <div className="max-h-[150px] overflow-auto space-y-0.5">
        {hints.map((hint) => (
          <button
            key={hint.id}
            className="w-full flex items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-secondary/50 transition-colors"
            onClick={() => onSelect?.(hint)}
          >
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {formatTimestamp(hint.timestampMs)}
            </span>
            <span className="truncate flex-1">{hint.suggestedLabel}</span>
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{
                backgroundColor: `rgba(234, 179, 8, ${0.3 + hint.confidence * 0.7})`,
              }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
