'use client';

import { useCallback, useRef, useMemo } from 'react';
import { Lock, Unlock, Eye, EyeOff, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useComposeStore } from '@/stores/compose-store';
import { TimelineClip } from './timeline-clip';
import { TimelineSubtitleTrack } from './timeline-subtitle-track';
import type { CompositionTrack, MediaBinAsset } from '@/types/project';

const TRACK_HEADER_WIDTH = 120;
const TRACK_HEIGHT = 48;

interface TimelineTrackProps {
  track: CompositionTrack;
}

export function TimelineTrack({ track }: TimelineTrackProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const allClips = useComposeStore((s) => s.clips);
  const clips = useMemo(
    () => allClips.filter((c) => c.trackId === track.id),
    [allClips, track.id]
  );
  const toggleMute = useComposeStore((s) => s.toggleTrackMute);
  const toggleLock = useComposeStore((s) => s.toggleTrackLock);
  const toggleVisible = useComposeStore((s) => s.toggleTrackVisible);
  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const durationMs = useComposeStore((s) => s.durationMs);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const selectClip = useComposeStore((s) => s.selectClip);
  const addClip = useComposeStore((s) => s.addClip);

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        selectClip(null);
      }
    },
    [selectClip]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (track.locked || track.type === 'subtitle') return;
      if (e.dataTransfer.types.includes('application/compose-asset')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    },
    [track.locked, track.type]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (track.locked || track.type === 'subtitle') return;
      const data = e.dataTransfer.getData('application/compose-asset');
      if (!data) return;
      e.preventDefault();

      const asset: MediaBinAsset = JSON.parse(data);

      // Check type compatibility
      if (track.type === 'video' && asset.type === 'audio') return;
      if (track.type === 'audio' && asset.type !== 'audio') return;

      // Calculate drop position in ms
      const rect = bodyRef.current?.getBoundingClientRect();
      const relX = rect ? e.clientX - rect.left : 0;
      const dropMs = Math.max(0, relX / zoomLevel + scrollOffsetMs);
      const clipDuration = asset.duration || 5000;

      addClip({
        type: asset.type,
        fileName: asset.fileName,
        originalName: asset.originalName,
        trackId: track.id,
        timelineStartMs: dropMs,
        timelineEndMs: dropMs + clipDuration,
        sourceInMs: 0,
        sourceOutMs: clipDuration,
        mode: asset.type === 'audio' ? undefined : 'cutaway',
        volume: asset.type === 'audio' ? 1 : undefined,
        opacity: asset.type !== 'audio' ? 1 : undefined,
      });
    },
    [track, zoomLevel, scrollOffsetMs, addClip]
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
        <div className="flex gap-0.5">
          {track.type !== 'subtitle' && (
            <button
              className="p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => toggleMute(track.id)}
              title={track.muted ? 'Unmute' : 'Mute'}
            >
              {track.muted ? (
                <VolumeX className="h-3 w-3" />
              ) : (
                <Volume2 className="h-3 w-3" />
              )}
            </button>
          )}
          {track.type === 'video' && (
            <button
              className="p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => toggleVisible(track.id)}
              title={track.visible ? 'Hide' : 'Show'}
            >
              {track.visible ? (
                <Eye className="h-3 w-3" />
              ) : (
                <EyeOff className="h-3 w-3" />
              )}
            </button>
          )}
          <button
            className="p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => toggleLock(track.id)}
            title={track.locked ? 'Unlock' : 'Lock'}
          >
            {track.locked ? (
              <Lock className="h-3 w-3 text-yellow-500" />
            ) : (
              <Unlock className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {/* Track body */}
      <div
        ref={bodyRef}
        className={cn('relative flex-1 overflow-hidden', bgClass)}
        onClick={handleTrackClick}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isSubtitle ? (
          <TimelineSubtitleTrack />
        ) : (
          clips.map((clip) => (
            <TimelineClip key={clip.id} clip={clip} trackLocked={track.locked} />
          ))
        )}

        {/* Track duration marker */}
        <div
          className="absolute top-0 bottom-0 w-px bg-border/30"
          style={{ left: (durationMs - scrollOffsetMs) * zoomLevel }}
        />
      </div>
    </div>
  );
}
