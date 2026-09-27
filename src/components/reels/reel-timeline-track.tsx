'use client';

import { useCallback, useMemo, useRef } from 'react';
import { RegionBands, RegionDrawLayer, RegionKindControls, useAudioRegions } from '@/components/parts/audio-regions-context';
import { trackHeightOf } from '@/lib/track-heights';
import { stemKindOfTrack } from '@/lib/audio-stems';
import { useParams } from 'next/navigation';
import { X, Plus, Pencil, ChevronLeft, ChevronRight, CheckSquare, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReelStore } from '@/stores/reel-store';
import { ReelTimelineClip } from './reel-timeline-clip';
import { ReelTimelineSubtitleBar } from './reel-timeline-subtitle-bar';
import type { CompositionTrack } from '@/types/project';

const TRACK_HEADER_WIDTH = 120;

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
  const toggleTrackMute = useReelStore((s) => s.toggleTrackMute);
  const stemKind = stemKindOfTrack(track.id);
  const regions = useAudioRegions();
  const addClip = useReelStore((s) => s.addClip);
  const scrollOffsetMs = useReelStore((s) => s.scrollOffsetMs);
  const zoomLevel = useReelStore((s) => s.zoomLevel);
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const isDropTarget = useReelStore((s) => s.dragTargetTrackId === track.id);
  const isActiveTrack = useReelStore((s) => s.activeTrackId === track.id);

  const clips = useMemo(
    () => reel?.composition.clips.filter((c) => c.trackId === track.id) ?? [],
    [reel, track.id]
  );

  const reelDurationMs = reel ? reel.endMs - reel.startMs : 0;
  const canDelete = !PROTECTED_TRACKS.has(track.id);

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      // Clicking anywhere on this track makes it the active paste target.
      useReelStore.getState().setActiveTrackId(track.id);
      if (e.target === e.currentTarget) {
        // Don't clear selection if Shift/Cmd is held
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
          selectClip(null);
          selectSubtitle(null);
        }
      }
    },
    [selectClip, selectSubtitle, track.id]
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
    <div className="flex border-b border-border" style={{ height: trackHeightOf(track) }}>
      {/* Track header */}
      <div
        className={cn(
          'relative flex flex-shrink-0 gap-1 border-r bg-card px-2',
          stemKind ? 'items-start pt-1' : 'items-center',
          isActiveTrack ? 'border-l-2 border-l-primary border-r-border' : 'border-border'
        )}
        style={{ width: TRACK_HEADER_WIDTH }}
        title={isActiveTrack ? (track.locked ? 'Pista activa (bloqueada): lo que pegues vuelve a su pista original' : 'Pista activa: aquí se pegará lo que copies (si es del mismo tipo)') : 'Pulsa para pegar aquí'}
        onClick={() => useReelStore.getState().setActiveTrackId(track.id)}
      >
        <div className="min-w-0 flex-1">
          <span className={cn('block text-[10px] font-medium truncate', labelColor)}>
            {track.label}
            {isSubtitle && selectedSubtitleIds.length > 0 && (
              <span className="text-white/50 ml-0.5">({selectedSubtitleIds.length})</span>
            )}
          </span>
          {stemKind && (
            <span
              className="block truncate text-[8px] leading-tight text-muted-foreground"
              title="Onda gris: el audio original (mesa cruda / cámara). Onda de color: lo que suena × el volumen del clip. Línea ámbar: la ganancia aplicada en dB respecto a la raya de 0 dB (je-je, nivelado, ducking, subidas, volumen). Con el lápiz activo, arrastra sobre la pista para marcar una zona."
            >
              gris · color · línea = dB
            </span>
          )}
        </div>
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
        {stemKind && regions && (
          <button
            className={cn('p-0.5 flex-shrink-0 rounded', regions.drawKind === stemKind ? 'bg-amber-500/30 text-amber-300' : 'text-muted-foreground hover:text-amber-300')}
            onClick={() => regions.setDrawKind(regions.drawKind === stemKind ? null : stemKind)}
            title={stemKind === 'board' ? 'Lápiz: arrastra sobre la pista para marcar una zona de mesa — atenuación o «abrir» (mantener la puerta abierta), según el tipo elegido arriba (clic = 0,8 s ahí). Vuelve a pulsar para salir.' : 'Lápiz: arrastra sobre la pista para marcar una subida de ambiente o una zona sin subida, según el tipo elegido arriba (clic = 0,8 s ahí). Vuelve a pulsar para salir.'}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {track.type === 'audio' && (
          <button
            className={cn('p-0.5 flex-shrink-0', track.muted ? 'text-red-400 hover:text-red-300' : 'text-muted-foreground hover:text-foreground')}
            onClick={() => toggleTrackMute(reelId, track.id)}
            title={track.muted ? 'Pista silenciada — clic para activar' : 'Silenciar pista (también en el export)'}
          >
            {track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          </button>
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
        {stemKind && (
          <div className="absolute inset-x-2 bottom-1">
            <RegionKindControls kind={stemKind} />
          </div>
        )}
      </div>

      {/* Track body */}
      <div
        className={cn(
          'relative flex-1 overflow-hidden',
          bgClass,
          isDropTarget && 'ring-2 ring-inset ring-primary/70 bg-primary/10'
        )}
        onClick={handleTrackClick}
      >
        {isSubtitle ? (
          <ReelTimelineSubtitleBar reelId={reelId} segments={reel?.subtitleSegments ?? []} />
        ) : (
          clips.map((clip) => (
            <ReelTimelineClip key={clip.id} reelId={reelId} clip={clip} trackLocked={track.locked} />
          ))
        )}

        {/* Mesa attenuations / ambient raises drawn over the stem's waveform */}
        {stemKind && regions?.drawKind === stemKind && <RegionDrawLayer kind={stemKind} />}
        {stemKind === 'board' && <RegionBands kind="autoGate" />}
        {stemKind === 'board' && <RegionBands kind="keepOpen" />}
        {stemKind === 'ambient' && <RegionBands kind="autoRaise" />}
        {stemKind === 'ambient' && <RegionBands kind="noRaise" />}
        {stemKind && <RegionBands kind={stemKind} />}

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
