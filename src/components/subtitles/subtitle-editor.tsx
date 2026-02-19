'use client';

import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Download, Plus, Trash2, Save } from 'lucide-react';
import { formatTimestamp } from '@/lib/utils';
import { segmentsToSrt, downloadAsFile } from '@/lib/subtitle-utils';
import type { SubtitleSegment, SubtitleConstraints } from '@/types/project';

interface SubtitleEditorProps {
  segments: SubtitleSegment[];
  onChange: (segments: SubtitleSegment[]) => void;
  onSave: () => void;
  activeSegmentIndex?: number;
  onSegmentClick?: (index: number) => void;
  constraints?: SubtitleConstraints;
}

export function SubtitleEditor({
  segments,
  onChange,
  onSave,
  activeSegmentIndex,
  onSegmentClick,
  constraints,
}: SubtitleEditorProps) {
  const updateSegment = useCallback(
    (index: number, updates: Partial<SubtitleSegment>) => {
      const newSegments = [...segments];
      newSegments[index] = { ...newSegments[index], ...updates };
      onChange(newSegments);
    },
    [segments, onChange]
  );

  const deleteSegment = useCallback(
    (index: number) => {
      onChange(segments.filter((_, i) => i !== index));
    },
    [segments, onChange]
  );

  const addSegment = useCallback(() => {
    const lastEnd = segments.length > 0
      ? segments[segments.length - 1].endMs
      : 0;
    const newSegment: SubtitleSegment = {
      id: uuidv4(),
      startMs: lastEnd,
      endMs: lastEnd + 3000,
      text: '',
    };
    onChange([...segments, newSegment]);
  }, [segments, onChange]);

  const mergeWithNext = useCallback(
    (index: number) => {
      if (index >= segments.length - 1) return;
      const current = segments[index];
      const next = segments[index + 1];
      const merged: SubtitleSegment = {
        ...current,
        endMs: next.endMs,
        text: `${current.text} ${next.text}`.trim(),
        words: [
          ...(current.words || []),
          ...(next.words || []),
        ],
      };
      const newSegments = [...segments];
      newSegments.splice(index, 2, merged);
      onChange(newSegments);
    },
    [segments, onChange]
  );

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-none pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            Subtitles ({segments.length} segments)
          </CardTitle>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={addSegment}>
              <Plus className="mr-1 h-3 w-3" />
              Add
            </Button>
            <Button variant="ghost" size="sm" onClick={onSave}>
              <Save className="mr-1 h-3 w-3" />
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadAsFile(
                segmentsToSrt(segments),
                'subtitles.srt',
                'text/srt'
              )}
              title="Descargar SRT"
            >
              <Download className="mr-1 h-3 w-3" />
              SRT
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-0">
        <ScrollArea className="h-[60vh] min-h-[300px]">
          <div className="space-y-1 p-4">
            {segments.map((seg, i) => {
              const charCount = seg.text.length;
              const durationMs = seg.endMs - seg.startMs;
              const durationSec = (durationMs / 1000).toFixed(1);
              const charsOver = constraints && charCount > constraints.maxCharsPerBlock;
              const durationOver = constraints && durationMs > constraints.maxDurationMs;

              return (
                <div
                  key={seg.id}
                  className={`group flex gap-2 rounded-md p-2 text-sm transition-colors cursor-pointer ${
                    activeSegmentIndex === i
                      ? 'bg-primary/10 border border-primary/30'
                      : 'hover:bg-secondary'
                  }`}
                  onClick={() => onSegmentClick?.(i)}
                >
                  <div className="flex-none space-y-1 text-[10px] text-muted-foreground">
                    <Input
                      className="h-5 w-16 sm:w-20 text-[10px] px-1"
                      value={formatTimestamp(seg.startMs)}
                      onChange={(e) => {
                        const parts = e.target.value.split(':');
                        if (parts.length === 2) {
                          const ms =
                            parseFloat(parts[0]) * 60000 +
                            parseFloat(parts[1]) * 1000;
                          if (!isNaN(ms)) updateSegment(i, { startMs: ms });
                        }
                      }}
                    />
                    <Input
                      className="h-5 w-16 sm:w-20 text-[10px] px-1"
                      value={formatTimestamp(seg.endMs)}
                      onChange={(e) => {
                        const parts = e.target.value.split(':');
                        if (parts.length === 2) {
                          const ms =
                            parseFloat(parts[0]) * 60000 +
                            parseFloat(parts[1]) * 1000;
                          if (!isNaN(ms)) updateSegment(i, { endMs: ms });
                        }
                      }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <textarea
                      className="w-full resize-none border-0 bg-transparent text-sm focus:outline-none focus:ring-0"
                      rows={2}
                      value={seg.text}
                      onChange={(e) => updateSegment(i, { text: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {constraints && (
                      <div className="flex gap-2 mt-0.5">
                        <span
                          className={`text-[9px] font-mono ${
                            charsOver ? 'text-red-400 font-bold' : 'text-muted-foreground/60'
                          }`}
                        >
                          {charCount}/{constraints.maxCharsPerBlock}
                        </span>
                        <span
                          className={`text-[9px] font-mono ${
                            durationOver ? 'text-red-400 font-bold' : 'text-muted-foreground/60'
                          }`}
                        >
                          {durationSec}s/{(constraints.maxDurationMs / 1000).toFixed(0)}s
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex-none flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {i < segments.length - 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        title="Merge with next"
                        onClick={(e) => {
                          e.stopPropagation();
                          mergeWithNext(i);
                        }}
                      >
                        <span className="text-[10px]">M</span>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSegment(i);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
