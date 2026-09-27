'use client';

import { useReelStore } from '@/stores/reel-store';
import { ReelVideoPlayer } from './reel-video-player';
import { ReelTrimBar } from './reel-trim-bar';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import type { CompositionClip, CompositionTrack } from '@/types/project';

interface ReelSetupViewProps {
  reelId: string;
  videoSrc?: string;
  audioSrc?: string;
  audioOffsetMs?: number;
  /** v1/a1 compose clips — passed through so the reel can inherit compose
   *  cuts the first time the user enters its timeline phase. */
  composeClips?: CompositionClip[];
  /** Compose tracks — carries the a1 mute along with the mesa/ambiente stem
   *  tracks, so a reel never plays the baked mix under the stems. */
  composeTracks?: CompositionTrack[];
}

export function ReelSetupView({ reelId, videoSrc, audioSrc, audioOffsetMs, composeClips, composeTracks }: ReelSetupViewProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const baseDurationMs = useReelStore((s) => s.baseDurationMs);
  const enterTimelinePhase = useReelStore((s) => s.enterTimelinePhase);
  const updateReel = useReelStore((s) => s.updateReel);

  if (!reel) return null;

  // Extract filenames from src URLs for clip creation
  const videoFileName = videoSrc ? new URL(videoSrc, 'http://x').searchParams.get('name') || videoSrc.split('/').pop() : undefined;
  const audioFileName = audioSrc ? new URL(audioSrc, 'http://x').searchParams.get('name') || audioSrc.split('/').pop() : undefined;

  // Compose extra-audio layers (a2+) overlapping this reel's range — carried
  // into the reel by default; the checkbox opts out (only shown when relevant).
  const composeExtraAudioCount = (composeClips ?? []).filter(
    (c) => c.type === 'audio' && c.trackId !== 'a1' && c.fileName &&
      c.timelineEndMs > reel.startMs && c.timelineStartMs < reel.endMs
  ).length;

  return (
    <div className="space-y-4 p-4">
      {reel.composeVersionId && (
        <p className="text-[11px] text-emerald-300/90" title="Este reel nació de los bits detectados sobre una versión guardada de Compose: sus cortes y subtítulos son los de esa versión, no los del Compose actual.">
          Cortes de la versión de Compose «{reel.composeVersionLabel ?? reel.composeVersionId}»
        </p>
      )}
      {/* Video Player with crop overlay */}
      <ReelVideoPlayer reelId={reelId} videoSrc={videoSrc} audioSrc={audioSrc} audioOffsetMs={audioOffsetMs} />

      {/* Trim Bar */}
      <ReelTrimBar reelId={reelId} baseDurationMs={baseDurationMs} composeClips={composeClips} />

      {/* Edit Reel button */}
      <div className="flex flex-col items-center gap-2 pt-2">
        {composeExtraAudioCount > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={reel.includeComposeExtraAudio ?? true}
              onChange={(e) => updateReel(reelId, { includeComposeExtraAudio: e.target.checked })}
            />
            Incluir el audio extra del compose ({composeExtraAudioCount} clip{composeExtraAudioCount === 1 ? '' : 's'})
          </label>
        )}
        <Button
          size="lg"
          onClick={() => enterTimelinePhase(reelId, videoFileName, audioFileName, composeClips, composeTracks)}
          className="gap-2"
        >
          Edit Reel
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
