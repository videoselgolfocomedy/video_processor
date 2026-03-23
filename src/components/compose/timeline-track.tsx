'use client';

import { useCallback, useRef, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { Lock, Unlock, Eye, EyeOff, Volume2, VolumeX, X, Plus, ChevronLeft, ChevronRight, CheckSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useComposeStore } from '@/stores/compose-store';
import { TimelineClip } from './timeline-clip';
import { TimelineSubtitleTrack } from './timeline-subtitle-track';
import type { CompositionTrack, MediaBinAsset } from '@/types/project';

const TRACK_HEADER_WIDTH = 120;
const TRACK_HEIGHT = 48;

const PROTECTED_TRACKS = new Set(['v1', 'a1', 's1']);

interface TimelineTrackProps {
  track: CompositionTrack;
}

export function TimelineTrack({ track }: TimelineTrackProps) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const selectSubtitle = useComposeStore((s) => s.selectSubtitle);
  const selectAllSubtitles = useComposeStore((s) => s.selectAllSubtitles);
  const selectSubtitlesFromPlayhead = useComposeStore((s) => s.selectSubtitlesFromPlayhead);
  const selectedSubtitleIds = useComposeStore((s) => s.selectedSubtitleIds);
  const subtitleSegments = useComposeStore((s) => s.subtitleSegments);
  const addClip = useComposeStore((s) => s.addClip);
  const removeTrack = useComposeStore((s) => s.removeTrack);
  const currentTimeMs = useComposeStore((s) => s.currentTimeMs);

  const canDelete = !PROTECTED_TRACKS.has(track.id);
  const isSubtitle = track.type === 'subtitle';
  const canAddClip = canDelete && !isSubtitle;

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
          selectClip(null);
          selectSubtitle(null);
        }
      }
    },
    [selectClip, selectSubtitle]
  );

  const handleAddClip = useCallback(async () => {
    if (track.type === 'text') {
      addClip({
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
      fileInputRef.current?.click();
    }
  }, [track.type, track.id, currentTimeMs, addClip]);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !projectId) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`/api/projects/${projectId}/compose/upload`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) return;
      const data = await res.json();

      addClip({
        type: data.type,
        fileName: data.fileName,
        originalName: data.originalName,
        trackId: track.id,
        timelineStartMs: currentTimeMs,
        timelineEndMs: currentTimeMs + (data.duration || 3000),
        sourceInMs: 0,
        sourceOutMs: data.duration || 3000,
      });
    } catch {
      // silently fail
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [projectId, track.id, currentTimeMs, addClip]);

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
      if (track.type === 'video' && asset.type === 'audio') return;
      if (track.type === 'audio' && asset.type !== 'audio') return;

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

        {/* Subtitle track: select before/all/after buttons */}
        {isSubtitle && (
          <div className="flex gap-0 flex-shrink-0">
            <button
              className="p-0.5 text-muted-foreground hover:text-yellow-300 flex-shrink-0"
              onClick={() => selectSubtitlesFromPlayhead('left')}
              title="Select subtitles before playhead"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button
              className={cn(
                'p-0.5 flex-shrink-0',
                selectedSubtitleIds.length > 0 && selectedSubtitleIds.length === subtitleSegments.length
                  ? 'text-yellow-400'
                  : 'text-muted-foreground hover:text-yellow-300',
              )}
              onClick={() => {
                const allSelected = selectedSubtitleIds.length === subtitleSegments.length && subtitleSegments.length > 0;
                if (allSelected) { selectSubtitle(null); }
                else { selectAllSubtitles(); }
              }}
              title="Select all / deselect all"
            >
              <CheckSquare className="h-3 w-3" />
            </button>
            <button
              className="p-0.5 text-muted-foreground hover:text-yellow-300 flex-shrink-0"
              onClick={() => selectSubtitlesFromPlayhead('right')}
              title="Select subtitles after playhead"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Non-subtitle controls */}
        {!isSubtitle && (
          <div className="flex gap-0.5">
            {track.type !== 'subtitle' && (
              <button
                className="p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => toggleMute(track.id)}
                title={track.muted ? 'Unmute' : 'Mute'}
              >
                {track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
              </button>
            )}
            {track.type === 'video' && (
              <button
                className="p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => toggleVisible(track.id)}
                title={track.visible ? 'Hide' : 'Show'}
              >
                {track.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              </button>
            )}
            <button
              className="p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => toggleLock(track.id)}
              title={track.locked ? 'Unlock' : 'Lock'}
            >
              {track.locked ? <Lock className="h-3 w-3 text-yellow-500" /> : <Unlock className="h-3 w-3" />}
            </button>
          </div>
        )}

        {/* Add clip button for non-protected, non-subtitle tracks */}
        {canAddClip && (
          <button
            className="p-0.5 text-muted-foreground hover:text-green-400 flex-shrink-0"
            onClick={handleAddClip}
            title="Add clip"
          >
            <Plus className="h-3 w-3" />
          </button>
        )}

        {/* Delete track button */}
        {canDelete && (
          <button
            className="p-0.5 text-muted-foreground hover:text-red-400 flex-shrink-0"
            onClick={() => {
              if (window.confirm(`Delete track "${track.label}" and all its clips?`)) {
                removeTrack(track.id);
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
