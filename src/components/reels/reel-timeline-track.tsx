'use client';

import { useCallback, useMemo, useRef } from 'react';
import { useParams } from 'next/navigation';
import { X, Plus, ChevronLeft, ChevronRight, CheckSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReelStore } from '@/stores/reel-store';
import { ReelTimelineClip } from './reel-timeline-clip';
import { ReelTimelineSubtitleBar } from './reel-timeline-subtitle-bar';
import type { CompositionTrack } from '@/types/project';

const TRACK_HEADER_WIDTH = 120;
const TRACK_HEIGHT = 48;

const PROTECTED_TRACKS = new Set(['rv1', 'ra1', 'rs1']);

interface ReelTimelineTrackProps {
  reelId: string;
  track: CompositionTrack;
}

export function ReelTimelineTrack({ reelId, track }: ReelTimelineTrackProps) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const selectClip = useReelStore((s) => s.selectClip);
  const selectSubtitle = useReelStore((s) => s.selectSubtitle);
  const selectAllSubtitles = useReelStore((s) => s.selectAllSubtitles);
  const selectSubtitlesFromPlayhead = useReelStore((s) => s.selectSubtitlesFromPlayhead);
  const selectedSubtitleIds = useReelStore((s) => s.selectedSubtitleIds);
  const removeTrack = useReelStore((s) => s.removeTrack);
  const addClip = useReelStore((s) => s.addClip);
  const scrollOffsetMs = useReelStore((s) => s.scrollOffsetMs);
  const zoomLevel = useReelStore((s) => s.zoomLevel);
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);

  const clips = useMemo(
    () => reel?.composition.clips.filter((c) => c.trackId === track.id) ?? [],
    [reel, track.id]
  );

  const reelDurationMs = reel ? reel.endMs - reel.startMs : 0;
  const canDelete = !PROTECTED_TRACKS.has(track.id);

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        // Don't clear selection if Shift/Cmd is held
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
          selectClip(null);
          selectSubtitle(null);
        }
      }
    },
    [selectClip, selectSubtitle]
  );

  const isSubtitle = track.type === 'subtitle';
  const canAddClip = canDelete && !isSubtitle;

  const handleAddClip = useCallback(async () => {
    if (track.type === 'text') {
      // Create text clip at playhead (3 seconds)
      addClip(reelId, {
        type: 'text',
        fileName: '',
        originalName: 'Text',
        trackId: track.id,
        timelineStartMs: currentTimeMs,
        timelineEndMs: currentTimeMs + 3000,
        sourceInMs: 0,
        sourceOutMs: 3000,
        textContent: '',
      });
    } else {
      // Open file picker
      fileInputRef.current?.click();
    }
  }, [track.type, track.id, reelId, currentTimeMs, addClip]);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !projectId) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`/api/projects/${projectId}/reels/upload`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) return;
      const data = await res.json();

      addClip(reelId, {
        type: data.type,
        fileName: data.fileName,
        originalName: data.originalName,
        trackId: track.id,
        timelineStartMs: currentTimeMs,
        timelineEndMs: currentTimeMs + 3000,
        sourceInMs: 0,
        sourceOutMs: 3000,
      });
    } catch {
      // silently fail
    }

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [projectId, reelId, track.id, currentTimeMs, addClip]);

  const fileAccept = track.type === 'video' ? 'video/*'
    : track.type === 'audio' ? 'audio/*'
    : 'image/*';

  const bgClass =
    track.type === 'video'
      ? 'bg-blue-500/5'
      : track.type === 'audio'
        ? 'bg-green-500/5'
        : track.type === 'image'
          ? 'bg-purple-500/5'
          : track.type === 'text'
            ? 'bg-orange-500/5'
            : 'bg-yellow-500/5';

  const labelColor =
    track.type === 'video'
      ? 'text-blue-400'
      : track.type === 'audio'
        ? 'text-green-400'
        : track.type === 'image'
          ? 'text-purple-400'
          : track.type === 'text'
            ? 'text-orange-400'
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
          {isSubtitle && selectedSubtitleIds.length > 0 && (
            <span className="text-white/50 ml-0.5">({selectedSubtitleIds.length})</span>
          )}
        </span>
        {isSubtitle && (
          <div className="flex gap-0 flex-shrink-0">
            <button
              className={cn(
                'p-0.5 text-muted-foreground hover:text-yellow-300 flex-shrink-0',
              )}
              onClick={() => selectSubtitlesFromPlayhead(reelId, 'left')}
              title="Select subtitles before playhead"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button
              className={cn(
                'p-0.5 flex-shrink-0',
                selectedSubtitleIds.length > 0 && reel && selectedSubtitleIds.length === reel.subtitleSegments.length
                  ? 'text-yellow-400'
                  : 'text-muted-foreground hover:text-yellow-300',
              )}
              onClick={() => {
                const allSelected = reel && selectedSubtitleIds.length === reel.subtitleSegments.length && reel.subtitleSegments.length > 0;
                if (allSelected) {
                  selectSubtitle(null);
                } else {
                  selectAllSubtitles(reelId);
                }
              }}
              title="Select all / deselect all"
            >
              <CheckSquare className="h-3 w-3" />
            </button>
            <button
              className="p-0.5 text-muted-foreground hover:text-yellow-300 flex-shrink-0"
              onClick={() => selectSubtitlesFromPlayhead(reelId, 'right')}
              title="Select subtitles after playhead"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        )}
        {canAddClip && (
          <button
            className="p-0.5 text-muted-foreground hover:text-green-400 flex-shrink-0"
            onClick={handleAddClip}
            title="Add clip"
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
        {canDelete && (
          <button
            className="p-0.5 text-muted-foreground hover:text-red-400 flex-shrink-0"
            onClick={() => {
              if (window.confirm(`Delete track "${track.label}" and all its clips?`)) {
                removeTrack(reelId, track.id);
              }
            }}
            title="Delete track"
          >
            <X className="h-3 w-3" />
          </button>
        )}
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

      {/* Hidden file input for upload */}
      {canAddClip && track.type !== 'text' && (
        <input
          ref={fileInputRef}
          type="file"
          accept={fileAccept}
          className="hidden"
          onChange={handleFileSelected}
        />
      )}
    </div>
  );
}
