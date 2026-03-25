'use client';

import { useReelStore } from '@/stores/reel-store';
import { ReelVideoPlayer } from './reel-video-player';
import { ReelTrimBar } from './reel-trim-bar';
import { formatTimestamp } from '@/lib/utils';
import { stripTrailingPunctuation } from '@/lib/subtitle-utils';
import { RemoveFormatting } from 'lucide-react';

interface ReelEditorProps {
  reelId: string;
  videoSrc?: string;
  audioSrc?: string;
}

export function ReelEditor({ reelId, videoSrc, audioSrc }: ReelEditorProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const baseDurationMs = useReelStore((s) => s.baseDurationMs);
  const updateReelSubtitleSegment = useReelStore((s) => s.updateReelSubtitleSegment);

  if (!reel) return null;

  const constraints = reel.subtitleConstraints;

  return (
    <div className="space-y-4 p-4">
      {/* Video Player with crop overlay */}
      <ReelVideoPlayer reelId={reelId} videoSrc={videoSrc} audioSrc={audioSrc} />

      {/* Trim Bar */}
      <ReelTrimBar reelId={reelId} baseDurationMs={baseDurationMs} />

      {/* Subtitles */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">
            Subtitles ({reel.subtitleSegments.length})
          </h3>
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
            onClick={() => {
              const stripped = stripTrailingPunctuation(reel.subtitleSegments);
              stripped.forEach((seg, i) => {
                if (seg.text !== reel.subtitleSegments[i]?.text) {
                  updateReelSubtitleSegment(reelId, seg.id, { text: seg.text, words: seg.words });
                }
              });
            }}
            title="Eliminar puntuación final (.,;:)"
          >
            <RemoveFormatting className="h-3 w-3" />
            Strip .,
          </button>
        </div>
        <div className="space-y-1">
          {reel.subtitleSegments.map((seg) => {
            const tooLong = seg.text.length > constraints.maxCharsPerBlock;
            const tooSlow = (seg.endMs - seg.startMs) > constraints.maxDurationMs;
            return (
              <div
                key={seg.id}
                className={`rounded border p-1.5 text-xs ${
                  tooLong || tooSlow ? 'border-yellow-700/50 bg-yellow-950/10' : 'border-border'
                }`}
              >
                <div className="text-[10px] text-muted-foreground">
                  {formatTimestamp(seg.startMs)} → {formatTimestamp(seg.endMs)}
                  {tooLong && <span className="ml-1 text-yellow-500">({seg.text.length} chars)</span>}
                  {tooSlow && <span className="ml-1 text-yellow-500">({((seg.endMs - seg.startMs) / 1000).toFixed(1)}s)</span>}
                </div>
                <input
                  className="w-full bg-transparent text-sm mt-0.5 outline-none"
                  value={seg.text}
                  onChange={(e) => updateReelSubtitleSegment(reelId, seg.id, { text: e.target.value })}
                />
              </div>
            );
          })}
          {reel.subtitleSegments.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No subtitles. Use &quot;Regenerate&quot; in the right panel.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
