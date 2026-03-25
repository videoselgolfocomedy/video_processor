'use client';

import React, { useRef, useMemo, useEffect } from 'react';
import { Player } from '@remotion/player';
import type { PlayerRef } from '@remotion/player';
import { AbsoluteFill, Video, Audio, Sequence, Img } from 'remotion';
import { SubtitleLayer } from '@/remotion/compositions/SubtitleLayer';
import { useComposeStore } from '@/stores/compose-store';
import type { SubtitleStyle } from '@/types/project';

const FPS = 30;
const CONTIGUOUS_THRESHOLD_MS = 50; // clips within 50ms are considered contiguous

// Merge contiguous clips from the same source into single ranges to avoid
// mounting multiple <Video> elements which causes a black flash at cuts.
interface MergedRange {
  id: string;
  timelineStartMs: number;
  timelineEndMs: number;
  sourceInMs: number;
}

function mergeContiguousClips(
  trackClips: { id: string; timelineStartMs: number; timelineEndMs: number; sourceInMs: number; sourceOutMs: number }[]
): MergedRange[] {
  if (trackClips.length === 0) return [];
  const sorted = [...trackClips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const merged: MergedRange[] = [];
  let current: MergedRange = {
    id: sorted[0].id,
    timelineStartMs: sorted[0].timelineStartMs,
    timelineEndMs: sorted[0].timelineEndMs,
    sourceInMs: sorted[0].sourceInMs,
  };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const timeGap = next.timelineStartMs - current.timelineEndMs;
    const expectedSourceIn = current.sourceInMs + (current.timelineEndMs - current.timelineStartMs);
    const sourceGap = Math.abs(next.sourceInMs - expectedSourceIn);

    // Contiguous: timeline gap < threshold AND source position is continuous
    if (timeGap < CONTIGUOUS_THRESHOLD_MS && sourceGap < CONTIGUOUS_THRESHOLD_MS) {
      current.timelineEndMs = next.timelineEndMs;
      // Keep current.sourceInMs — the Video plays continuously from the original startFrom
    } else {
      merged.push(current);
      current = {
        id: next.id,
        timelineStartMs: next.timelineStartMs,
        timelineEndMs: next.timelineEndMs,
        sourceInMs: next.sourceInMs,
      };
    }
  }
  merged.push(current);
  return merged;
}

// --- Remotion Composition ---
// The composition reads clips/tracks/segments directly from the zustand store
// instead of relying on Remotion Player's inputProps propagation. This ensures
// the composition always reflects the latest store state (e.g. after clip deletion)
// without depending on the Player re-rendering in response to inputProps changes.

interface ComposeCompositionProps {
  videoSrc?: string;
  audioSrc?: string;
  clipSources: Record<string, string>;
  subtitleStyle: SubtitleStyle;
}

const ComposeComposition: React.FC<ComposeCompositionProps> = ({
  videoSrc,
  audioSrc,
  clipSources,
  subtitleStyle,
}) => {
  // Read directly from the store so deletions/mutations are always reflected
  const clips = useComposeStore((s) => s.clips);
  const tracks = useComposeStore((s) => s.tracks);
  const segments = useComposeStore((s) => s.subtitleSegments);

  const mutedTrackIds = new Set(tracks.filter((t) => t.muted).map((t) => t.id));
  const hiddenTrackIds = new Set(tracks.filter((t) => !t.visible).map((t) => t.id));

  const videoClips = clips.filter(
    (c) => (c.type === 'video' || c.type === 'image') && !hiddenTrackIds.has(c.trackId)
  );
  const audioClips = clips.filter(
    (c) => c.type === 'audio' && !mutedTrackIds.has(c.trackId)
  );
  const textClips = clips.filter(
    (c) => c.type === 'text' && !hiddenTrackIds.has(c.trackId)
  );
  const imageOverlayClips = clips.filter(
    (c) => (c.type === 'image' || c.type === 'gif') && c.overlayPosition && !hiddenTrackIds.has(c.trackId)
  );

  const cutaways = videoClips.filter((c) => c.mode === 'cutaway' && !c.overlayPosition);
  const overlays = videoClips.filter((c) => c.mode === 'overlay');

  // Base video/audio clips on v1/a1 tracks — merge contiguous to avoid black flash
  const v1Clips = clips.filter((c) => c.trackId === 'v1');
  const a1Clips = clips.filter((c) => c.trackId === 'a1');
  const v1Merged = mergeContiguousClips(v1Clips);
  const a1Merged = mergeContiguousClips(a1Clips);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* 1. Base video clips (merged contiguous ranges → single <Video> per range) */}
      {/* Muted because audio is handled separately via a1 clips — the muxed video
          contains embedded audio which would play on top of the separate Audio track */}
      {videoSrc && v1Merged.map((range) => {
        const from = Math.round((range.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((range.timelineEndMs - range.timelineStartMs) / 1000) * FPS));
        const startFrom = Math.round((range.sourceInMs / 1000) * FPS);
        return (
          <Sequence key={range.id} from={from} durationInFrames={dur}>
            <Video
              src={videoSrc}
              startFrom={startFrom}
              volume={0}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </Sequence>
        );
      })}

      {/* 2. Cutaways */}
      {cutaways.map((clip) => {
        const src = clipSources[clip.fileName];
        if (!src) return null;
        const from = Math.round((clip.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((clip.timelineEndMs - clip.timelineStartMs) / 1000) * FPS));
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ opacity: clip.opacity ?? 1 }}>
              {clip.type === 'image' ? (
                <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : (
                <Video src={src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              )}
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {/* 3. Overlays (PiP) */}
      {overlays.map((clip) => {
        const src = clipSources[clip.fileName];
        if (!src) return null;
        const from = Math.round((clip.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((clip.timelineEndMs - clip.timelineStartMs) / 1000) * FPS));
        const pos = clip.overlay || { x: 0.6, y: 0.6, width: 0.35, height: 0.35 };
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <div
              style={{
                position: 'absolute',
                left: `${pos.x * 100}%`,
                top: `${pos.y * 100}%`,
                width: `${pos.width * 100}%`,
                height: `${pos.height * 100}%`,
                opacity: clip.opacity ?? 1,
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              {clip.type === 'image' ? (
                <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <Video src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              )}
            </div>
          </Sequence>
        );
      })}

      {/* 3b. Image/GIF overlays with position */}
      {imageOverlayClips.map((clip) => {
        const src = clipSources[clip.fileName];
        if (!src) return null;
        const from = Math.round((clip.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((clip.timelineEndMs - clip.timelineStartMs) / 1000) * FPS));
        const pos = clip.overlayPosition!;
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <div
              style={{
                position: 'absolute',
                left: `${(pos.x - pos.width / 2) * 100}%`,
                top: `${(pos.y - pos.width * (9 / 16) / 2) * 100}%`,
                width: `${pos.width * 100}%`,
                opacity: clip.opacity ?? 1,
              }}
            >
              <Img src={src} style={{ width: '100%', height: 'auto', objectFit: 'contain' }} />
            </div>
          </Sequence>
        );
      })}

      {/* 4. Base audio clips (merged contiguous ranges → single <Audio> per range) */}
      {audioSrc && a1Merged.map((range) => {
        const from = Math.round((range.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((range.timelineEndMs - range.timelineStartMs) / 1000) * FPS));
        const startFrom = Math.round((range.sourceInMs / 1000) * FPS);
        return (
          <Sequence key={range.id} from={from} durationInFrames={dur}>
            <Audio src={audioSrc} startFrom={startFrom} />
          </Sequence>
        );
      })}

      {/* 5. Extra audio clips */}
      {audioClips.map((clip) => {
        const src = clipSources[clip.fileName];
        if (!src) return null;
        const from = Math.round((clip.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((clip.timelineEndMs - clip.timelineStartMs) / 1000) * FPS));
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <Audio src={src} volume={clip.volume ?? 1} />
          </Sequence>
        );
      })}

      {/* 6. Text overlays */}
      {textClips.map((clip) => {
        if (!clip.textContent) return null;
        const from = Math.round((clip.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((clip.timelineEndMs - clip.timelineStartMs) / 1000) * FPS));
        const style = clip.textStyle;
        const pos = clip.overlayPosition ?? { x: 0.5, y: 0.5, width: 0.8 };
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <div
              style={{
                position: 'absolute',
                left: `${(pos.x - pos.width / 2) * 100}%`,
                top: `${pos.y * 100}%`,
                width: `${pos.width * 100}%`,
                transform: 'translateY(-50%)',
                textAlign: 'center',
                opacity: clip.opacity ?? 1,
                fontSize: style?.fontSize ?? 48,
                fontFamily: style?.fontFamily ?? 'Inter',
                fontWeight: style?.fontWeight ?? 700,
                color: style?.color ?? '#FFFFFF',
                lineHeight: style?.lineHeight ?? 1.3,
                textShadow: style?.shadowColor
                  ? `${style.shadowX ?? 2}px ${style.shadowY ?? 2}px ${style.shadowBlur ?? 8}px ${style.shadowColor}`
                  : undefined,
                backgroundColor: style?.backgroundColor ?? 'transparent',
              }}
            >
              {clip.textContent}
            </div>
          </Sequence>
        );
      })}

      {/* 7. Subtitles */}
      <SubtitleLayer segments={segments} style={subtitleStyle} />
    </AbsoluteFill>
  );
};

// --- Player Wrapper ---

interface ComposePreviewProps {
  projectId: string;
  videoSrc?: string;
  audioSrc?: string;
  subtitleStyle: SubtitleStyle;
}

export function ComposePreview({
  projectId,
  videoSrc,
  audioSrc,
  subtitleStyle,
}: ComposePreviewProps) {
  const playerRef = useRef<PlayerRef>(null);

  // The composition component reads clips/tracks/segments directly from the
  // store, so we only need durationMs and mediaBin here for the Player wrapper.
  const durationMs = useComposeStore((s) => s.durationMs);
  const mediaBin = useComposeStore((s) => s.mediaBin);

  // Refs to break the bidirectional sync loop
  const playerCausedUpdate = useRef(false);
  const isSeeking = useRef(false);

  const durationInFrames = Math.max(1, Math.ceil((durationMs / 1000) * FPS));

  // Build source URLs for compose assets
  const clipSources = useMemo(() => {
    const sources: Record<string, string> = {};
    for (const asset of mediaBin) {
      sources[asset.fileName] = `/api/projects/${projectId}/compose/file?name=${encodeURIComponent(asset.fileName)}`;
    }
    return sources;
  }, [mediaBin, projectId]);

  const inputProps = useMemo(
    () => ({
      videoSrc,
      audioSrc,
      clipSources,
      subtitleStyle,
    }),
    [videoSrc, audioSrc, clipSources, subtitleStyle]
  );

  // Subscribe to currentTimeMs changes outside of React render cycle
  // to imperatively seek the Player without causing re-renders.
  useEffect(() => {
    const unsub = useComposeStore.subscribe(
      (state, prevState) => {
        if (state.currentTimeMs === prevState.currentTimeMs) return;

        // If the player itself caused this update, skip seeking back.
        if (playerCausedUpdate.current) {
          playerCausedUpdate.current = false;
          return;
        }

        const player = playerRef.current;
        if (!player || isSeeking.current) return;

        isSeeking.current = true;
        const frame = Math.round((state.currentTimeMs / 1000) * FPS);
        player.seekTo(frame);
        // Small delay to let the seek complete before allowing more
        requestAnimationFrame(() => {
          isSeeking.current = false;
        });
      }
    );
    return unsub;
  }, []);

  // Sync play/pause imperatively via subscription (not via re-render)
  useEffect(() => {
    const unsub = useComposeStore.subscribe(
      (state, prevState) => {
        if (state.isPlaying === prevState.isPlaying) return;
        const player = playerRef.current;
        if (!player) return;
        if (state.isPlaying) {
          player.play();
        } else {
          player.pause();
        }
      }
    );
    return unsub;
  }, []);

  // Register player event listeners (player → store sync)
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onTimeUpdate = (e: any) => {
      const frame = e?.detail?.frame ?? 0;
      const ms = (frame / FPS) * 1000;
      // Flag so the store→player subscription knows to skip seeking
      playerCausedUpdate.current = true;
      useComposeStore.getState().setCurrentTime(ms);
    };

    const onPlay = () => {
      useComposeStore.getState().setIsPlaying(true);
    };
    const onPause = () => {
      useComposeStore.getState().setIsPlaying(false);
    };
    const onEnded = () => {
      useComposeStore.getState().setIsPlaying(false);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    player.addEventListener('timeupdate', onTimeUpdate as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    player.addEventListener('play', onPlay as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    player.addEventListener('pause', onPause as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    player.addEventListener('ended', onEnded as any);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      player.removeEventListener('timeupdate', onTimeUpdate as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      player.removeEventListener('play', onPlay as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      player.removeEventListener('pause', onPause as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      player.removeEventListener('ended', onEnded as any);
    };
  }, []);

  return (
    <div className="flex justify-center rounded-lg bg-black p-1">
      <Player
        ref={playerRef}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        component={ComposeComposition as React.ComponentType<any>}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        compositionWidth={1920}
        compositionHeight={1080}
        fps={FPS}
        style={{
          width: '100%',
          maxHeight: 340,
          aspectRatio: '16/9',
        }}
        controls={false}
        loop={false}
        autoPlay={false}
      />
    </div>
  );
}
