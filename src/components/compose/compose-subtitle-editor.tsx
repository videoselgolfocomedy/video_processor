'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useComposeStore } from '@/stores/compose-store';
import { formatTimestamp } from '@/lib/utils';
import { stripTrailingPunctuation, segmentsToSrt, downloadAsFile } from '@/lib/subtitle-utils';
import { Trash2, RemoveFormatting, Download } from 'lucide-react';

export function ComposeSubtitleEditor() {
  const subtitleSegments = useComposeStore((s) => s.subtitleSegments);
  const subtitleConstraints = useComposeStore((s) => s.subtitleConstraints);
  const selectedSubtitleIds = useComposeStore((s) => s.selectedSubtitleIds);
  const selectSubtitle = useComposeStore((s) => s.selectSubtitle);
  const updateSubtitleSegment = useComposeStore((s) => s.updateSubtitleSegment);
  const deleteSubtitleSegment = useComposeStore((s) => s.deleteSubtitleSegment);
  const setCurrentTime = useComposeStore((s) => s.setCurrentTime);
  const currentTimeMs = useComposeStore((s) => s.currentTimeMs);
  const isPlaying = useComposeStore((s) => s.isPlaying);

  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const userInteracting = useRef(false);

  // When text is manually edited, sync the words array
  const handleTextChange = useCallback(
    (segId: string, newText: string) => {
      const seg = subtitleSegments.find((s) => s.id === segId);
      if (!seg || !seg.words || seg.words.length === 0) {
        updateSubtitleSegment(segId, { text: newText });
        return;
      }

      const newWords = newText.split(/\s+/).filter(Boolean);
      const oldWords = seg.words;

      if (newWords.length === oldWords.length) {
        const updatedWords = oldWords.map((w, i) => ({ ...w, text: newWords[i] }));
        updateSubtitleSegment(segId, { text: newText, words: updatedWords });
      } else {
        const segDur = seg.endMs - seg.startMs;
        const wordDur = newWords.length > 0 ? segDur / newWords.length : segDur;
        const updatedWords = newWords.map((text, i) => ({
          text,
          startMs: seg.startMs + Math.round(i * wordDur),
          endMs: seg.startMs + Math.round((i + 1) * wordDur),
          style: i < oldWords.length ? oldWords[i].style : undefined,
        }));
        updateSubtitleSegment(segId, { text: newText, words: updatedWords });
      }
    },
    [subtitleSegments, updateSubtitleSegment]
  );

  const handleTimeChange = useCallback(
    (segId: string, field: 'startMs' | 'endMs', value: string) => {
      const ms = parseTimestamp(value);
      if (ms !== null) {
        updateSubtitleSegment(segId, { [field]: ms });
      }
    },
    [updateSubtitleSegment]
  );

  // Auto-scroll to active segment during playback
  useEffect(() => {
    if (!isPlaying || userInteracting.current) return;
    const activeSeg = subtitleSegments.find(
      (s) => currentTimeMs >= s.startMs && currentTimeMs < s.endMs
    );
    if (activeSeg) {
      const el = rowRefs.current.get(activeSeg.id);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentTimeMs, isPlaying, subtitleSegments]);

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto">
      <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border sticky top-0 bg-card z-10 flex items-center justify-between">
        <span>Subtitles ({subtitleSegments.length})</span>
        <div className="flex items-center gap-2">
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
            onClick={() => {
              const store = useComposeStore.getState();
              store.saveSnapshot();
              store.setSubtitleSegments(stripTrailingPunctuation(subtitleSegments));
            }}
            title="Eliminar puntuación final (.,;:)"
          >
            <RemoveFormatting className="h-3 w-3" />
            Strip .,
          </button>
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
            onClick={() => downloadAsFile(segmentsToSrt(subtitleSegments), 'compose-subtitles.srt', 'text/srt')}
            title="Descargar SRT"
          >
            <Download className="h-3 w-3" />
            SRT
          </button>
        </div>
      </div>
      <div className="divide-y divide-border">
        {subtitleSegments.map((seg) => {
          const tooLong = seg.text.length > subtitleConstraints.maxCharsPerBlock;
          const tooSlow = (seg.endMs - seg.startMs) > subtitleConstraints.maxDurationMs;
          const isSelected = selectedSubtitleIds.includes(seg.id);
          const isActive = currentTimeMs >= seg.startMs && currentTimeMs < seg.endMs;

          return (
            <div
              key={seg.id}
              ref={(el) => { if (el) rowRefs.current.set(seg.id, el); else rowRefs.current.delete(seg.id); }}
              className={`flex items-start gap-2 px-3 py-1 text-xs cursor-pointer hover:bg-muted/30 ${
                isActive ? 'bg-primary/10 border-l-2 border-l-primary' : ''
              } ${isSelected && !isActive ? 'bg-yellow-500/10' : ''} ${
                tooLong || tooSlow ? 'bg-yellow-950/10' : ''
              }`}
              onClick={() => {
                selectSubtitle(seg.id);
                setCurrentTime(seg.startMs);
              }}
            >
              <div className="flex flex-col gap-0.5 flex-shrink-0 self-start pt-0.5">
                {/* `key` incorporates the value so the uncontrolled input remounts
                    whenever the underlying time changes externally (e.g. after
                    rippleDelete shifts subtitles to close a gap). Without this
                    the displayed timestamp would be frozen at the value when
                    the row first rendered. */}
                <input
                  key={`start-${seg.startMs}`}
                  className="text-[10px] text-muted-foreground tabular-nums w-20 bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary"
                  defaultValue={formatTimestamp(seg.startMs)}
                  onBlur={(e) => handleTimeChange(seg.id, 'startMs', e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={() => { userInteracting.current = true; }}
                />
                <input
                  key={`end-${seg.endMs}`}
                  className="text-[10px] text-muted-foreground tabular-nums w-20 bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary"
                  defaultValue={formatTimestamp(seg.endMs)}
                  onBlur={(e) => handleTimeChange(seg.id, 'endMs', e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={() => { userInteracting.current = true; }}
                />
              </div>
              <textarea
                className="flex-1 bg-transparent text-sm outline-none min-w-0 resize-none overflow-hidden"
                value={seg.text}
                rows={Math.max(1, seg.text.split('\n').length)}
                onChange={(e) => handleTextChange(seg.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onFocus={() => { userInteracting.current = true; }}
                onBlur={() => { setTimeout(() => { userInteracting.current = false; }, 300); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) e.stopPropagation();
                }}
              />
              {tooLong && (
                <span className="text-[9px] text-yellow-500 flex-shrink-0 self-start pt-0.5">
                  {seg.text.length}ch
                </span>
              )}
              <button
                className="p-0.5 text-muted-foreground hover:text-red-400 flex-shrink-0 self-start pt-0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSubtitleSegment(seg.id);
                }}
                title="Delete subtitle"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {subtitleSegments.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No subtitles loaded.
          </p>
        )}
      </div>
    </div>
  );
}

/** Parse "MM:SS.ss" or "HH:MM:SS.ss" to ms, returns null on invalid */
function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let hours = 0, minutes = 0, seconds = 0;
  if (parts.length === 3) {
    hours = parseInt(parts[0]) || 0;
    minutes = parseInt(parts[1]) || 0;
    seconds = parseFloat(parts[2]) || 0;
  } else {
    minutes = parseInt(parts[0]) || 0;
    seconds = parseFloat(parts[1]) || 0;
  }
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}
