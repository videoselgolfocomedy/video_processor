'use client';

import React, { useRef, useMemo, useEffect } from 'react';
import { Player } from '@remotion/player';
import type { PlayerRef } from '@remotion/player';
import { AbsoluteFill, Video, Audio, Sequence, Img } from 'remotion';
import { SubtitleLayer } from '@/remotion/compositions/SubtitleLayer';
import { useComposeStore } from '@/stores/compose-store';
import type {
  CompositionClip,
  CompositionTrack,
  SubtitleSegment,
  SubtitleStyle,
} from '@/types/project';

const FPS = 30;

// --- Remotion Composition ---

interface ComposeCompositionProps {
  videoSrc?: string;
  audioSrc?: string;
  clips: CompositionClip[];
  clipSources: Record<string, string>;
  tracks: CompositionTrack[];
  segments: SubtitleSegment[];
  subtitleStyle: SubtitleStyle;
}

const ComposeComposition: React.FC<ComposeCompositionProps> = ({
  videoSrc,
  audioSrc,
  clips,
  clipSources,
  tracks,
  segments,
  subtitleStyle,
}) => {
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

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* 1. Base video */}
      {videoSrc && (
        <Video
          src={videoSrc}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      )}

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

      {/* 4. Base audio */}
      {audioSrc && <Audio src={audioSrc} />}

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

  // Subscribe only to data that affects the composition rendering,
  // NOT to currentTimeMs/isPlaying (those are synced imperatively via refs).
  const clips = useComposeStore((s) => s.clips);
  const tracks = useComposeStore((s) => s.tracks);
  const segments = useComposeStore((s) => s.subtitleSegments);
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
      clips,
      clipSources,
      tracks,
      segments,
      subtitleStyle,
    }),
    [videoSrc, audioSrc, clips, clipSources, tracks, segments, subtitleStyle]
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
