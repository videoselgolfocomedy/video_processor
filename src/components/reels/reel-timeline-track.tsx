'use client';

import { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useReelStore } from '@/stores/reel-store';
import { ReelTimelineClip } from './reel-timeline-clip';
import { ReelTimelineSubtitleBar } from './reel-timeline-subtitle-bar';
import type { CompositionTrack } from '@/types/project';

const TRACK_HEADER_WIDTH = 120;
const TRACK_HEIGHT = 48;

interface ReelTimelineTrackProps {
  reelId: string;
  track: CompositionTrack;
}

export function ReelTimelineTrack({ reelId, track }: ReelTimelineTrackProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const selectClip = useReelStore((s) => s.selectClip);
  const selectSubtitle = useReelStore((s) => s.selectSubtitle);
  const scrollOffsetMs = useReelStore((s) => s.scrollOffsetMs);
  const zoomLevel = useReelStore((s) => s.zoomLevel);

  const clips = useMemo(
    () => reel?.composition.clips.filter((c) => c.trackId === track.id) ?? [],
    [reel, track.id]
  );

  const reelDurationMs = reel ? reel.endMs - reel.startMs : 0;

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        selectClip(null);
        selectSubtitle(null);
      }
    },
    [selectClip, selectSubtitle]
  );

  const isSubtitle = track.type === 'subtitle';

  const bgClass =
    track.type === 'video'
      ? 'bg-blue-500/5'
      : track.type === 'audio'
        ? 'bg-green-500/5'
        : 'bg-yellow-500/5';

  const labelColor =
    track.type === 'video'
      ? 'text-blue-400'
      : track.type === 'audio'
        ? 'text-green-400'
        : 'text-yellow-400';

  return (
    <div className="flex border-b border-border" style={{ height: TRACK_HEIGHT }}>
      {/* Track header */}
      <div
        className="flex flex-shrink-0 items-center gap-1 border-r border-border bg-card px-2"
        style={{ width: TRACK_HEADER_WIDTH }}
      >
        <span className={cn('text-[10px] font-medium truncate flex-1', labelColor)}>
          {track.label}
        </span>
      </div>

      {/* Track body */}
      <div
        className={cn('relative flex-1 overflow-hidden', bgClass)}
        onClick={handleTrackClick}
      >
        {isSubtitle ? (
          <ReelTimelineSubtitleBar reelId={reelId} segments={reel?.subtitleSegments ?? []} />
        ) : (
          clips.map((clip) => (
            <ReelTimelineClip key={clip.id} reelId={reelId} clip={clip} trackLocked={track.locked} />
          ))
        )}

        {/* Duration end marker */}
        <div
          className="absolute top-0 bottom-0 w-px bg-border/30"
          style={{ left: (reelDurationMs - scrollOffsetMs) * zoomLevel }}
        />
      </div>
    </div>
  );
}
