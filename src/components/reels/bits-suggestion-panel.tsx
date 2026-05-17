'use client';

import type { BitDefinition, CompositionClip } from '@/types/project';
import { Button } from '@/components/ui/button';
import { formatTimestamp } from '@/lib/utils';
import { Sparkles, Plus } from 'lucide-react';

// Extended bit with optional source times (when bits come from compose)
interface BitWithSourceTimes extends BitDefinition {
  sourceStartMs?: number;
  sourceEndMs?: number;
}

interface BitsSuggestionPanelProps {
  bits: BitWithSourceTimes[];
  compositionClips: CompositionClip[];
  onCreateReel: (label: string, startMs: number, endMs: number, sourceStartMs?: number, sourceEndMs?: number) => void;
}

interface BitWithCoverage extends BitWithSourceTimes {
  coverage: number;
}

export function BitsSuggestionPanel({ bits, compositionClips, onCreateReel }: BitsSuggestionPanelProps) {
  // Filter to main video track clips only
  const mainClips = compositionClips.filter((c) => c.trackId === 'v1');
  const hasComposition = mainClips.length > 0;

  // Compute overlap coverage for each bit.
  //
  // CRITICAL: bits generated with source='compose' have startMs/endMs in
  // COMPOSE timeline space (relative to the edited timeline), not source
  // space. The /bits route enriches them with sourceStartMs/sourceEndMs in
  // source space. Clip ranges (sourceInMs/sourceOutMs) are in source space.
  // To compute the overlap we must compare in the SAME coordinate space —
  // prefer the bit's source-mapped times when available, otherwise assume
  // the bit times are already source-space (bits generated from 'full').
  //
  // Previous bug: comparing bit.startMs (compose) against clip.sourceInMs
  // (source) → overlap=0 for every bit → all 9 bits filtered out → the
  // panel rendered "No bits identified" despite bits.length===9 in state.
  const bitsWithCoverage: BitWithCoverage[] = bits
    .map((bit) => {
      const bitDuration = bit.endMs - bit.startMs;
      if (bitDuration <= 0) return null;

      if (!hasComposition) {
        return { ...bit, coverage: 1 };
      }

      const bitSrcStart = bit.sourceStartMs ?? bit.startMs;
      const bitSrcEnd = bit.sourceEndMs ?? bit.endMs;
      const bitSrcDuration = bitSrcEnd - bitSrcStart;
      if (bitSrcDuration <= 0) return null;

      let overlapSum = 0;
      for (const clip of mainClips) {
        const overlap = Math.max(
          0,
          Math.min(bitSrcEnd, clip.sourceOutMs) - Math.max(bitSrcStart, clip.sourceInMs)
        );
        overlapSum += overlap;
      }

      const coverage = overlapSum / bitSrcDuration;
      if (coverage <= 0) return null;

      return { ...bit, coverage };
    })
    .filter((b): b is BitWithCoverage => b !== null)
    .sort((a, b) => b.coverage - a.coverage);

  if (bitsWithCoverage.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-6 text-center">
        <Sparkles className="h-8 w-8 text-muted-foreground/40 mb-2" />
        <p className="text-sm text-muted-foreground">No bits identified</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Run AI reinterpretation on the Transcription page to identify comedy bits
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-purple-400" />
        <span className="text-sm font-medium">Comedy Bits</span>
        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
          {bitsWithCoverage.length}
        </span>
      </div>

      <div className="space-y-2 max-h-[calc(100vh-200px)] overflow-y-auto">
        {bitsWithCoverage.map((bit) => (
          <div
            key={bit.id}
            className="rounded-md border border-border bg-card p-3 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <h4 className="text-xs font-medium leading-tight">{bit.label}</h4>
              {hasComposition && (
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                  {Math.round(bit.coverage * 100)}%
                </span>
              )}
            </div>

            {bit.summary && (
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {bit.summary}
              </p>
            )}

            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">
                {formatTimestamp(bit.startMs)} - {formatTimestamp(bit.endMs)}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[10px]"
                onClick={() => {
                  // Source times for muxed-video seeking. Prefer the value the
                  // /bits route enriched the bit with (computed from the compose
                  // clips at detection time, which is the authoritative mapping);
                  // fall back to bit.startMs/endMs which are already source-space
                  // when bits were detected from source='full'.
                  const srcStart = bit.sourceStartMs ?? bit.startMs;
                  const srcEnd = bit.sourceEndMs ?? bit.endMs;
                  onCreateReel(bit.label, bit.startMs, bit.endMs, srcStart, srcEnd);
                }}
              >
                <Plus className="mr-1 h-2.5 w-2.5" />
                Create Reel
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
