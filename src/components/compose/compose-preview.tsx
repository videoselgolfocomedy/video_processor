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
// The `key` field is derived from the merged range CONTENTS (track + bounds +
// source position), not from any underlying clip id. This is critical: after
// `splitAllAtPlayhead` the two halves get new UUIDs but merge back into the
// same contiguous range. If we keyed by id, React would unmount and remount
// the <Sequence>/<Audio> during active playback, which leaves Remotion's
// audio element in a permanently-silent state until page reload.
interface MergedRange {
  /** Stable across split-and-remerge — based on bounds, not clip ids. */
  key: string;
  timelineStartMs: number;
  timelineEndMs: number;
  sourceInMs: number;
  transform?: { scale: number; x: number; y: number };
}

interface MergeableClip {
  id: string;
  timelineStartMs: number;
  timelineEndMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  transform?: { scale: number; x: number; y: number };
}

function transformsEqual(
  a?: { scale: number; x: number; y: number },
  b?: { scale: number; x: number; y: number }
): boolean {
  const aScale = a?.scale ?? 1; const bScale = b?.scale ?? 1;
  const aX = a?.x ?? 0; const bX = b?.x ?? 0;
  const aY = a?.y ?? 0; const bY = b?.y ?? 0;
  return Math.abs(aScale - bScale) < 0.001 && Math.abs(aX - bX) < 0.001 && Math.abs(aY - bY) < 0.001;
}

function rangeKey(prefix: string, r: Pick<MergedRange, 'timelineStartMs' | 'timelineEndMs' | 'sourceInMs' | 'transform'>): string {
  const t = r.transform;
  const tStr = t ? `${t.scale.toFixed(3)}_${t.x.toFixed(3)}_${t.y.toFixed(3)}` : '0';
  return `${prefix}:${r.timelineStartMs}-${r.timelineEndMs}@${r.sourceInMs}#${tStr}`;
}

function mergeContiguousClips(trackClips: MergeableClip[], keyPrefix: string): MergedRange[] {
  if (trackClips.length === 0) return [];
  const sorted = [...trackClips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const merged: MergedRange[] = [];
  let current = {
    timelineStartMs: sorted[0].timelineStartMs,
    timelineEndMs: sorted[0].timelineEndMs,
    sourceInMs: sorted[0].sourceInMs,
    transform: sorted[0].transform,
  };

  const finalize = (r: typeof current) => ({
    key: rangeKey(keyPrefix, r),
    timelineStartMs: r.timelineStartMs,
    timelineEndMs: r.timelineEndMs,
    sourceInMs: r.sourceInMs,
    transform: r.transform,
  });

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const timeGap = next.timelineStartMs - current.timelineEndMs;
    const expectedSourceIn = current.sourceInMs + (current.timelineEndMs - current.timelineStartMs);
    const sourceGap = Math.abs(next.sourceInMs - expectedSourceIn);

    // Contiguous: timeline gap < threshold AND source position is continuous AND transforms match
    if (
      timeGap < CONTIGUOUS_THRESHOLD_MS &&
      sourceGap < CONTIGUOUS_THRESHOLD_MS &&
      transformsEqual(current.transform, next.transform)
    ) {
      current.timelineEndMs = next.timelineEndMs;
      // Keep current.sourceInMs — the Video plays continuously from the original startFrom
    } else {
      merged.push(finalize(current));
      current = {
        timelineStartMs: next.timelineStartMs,
        timelineEndMs: next.timelineEndMs,
        sourceInMs: next.sourceInMs,
        transform: next.transform,
      };
    }
  }
  merged.push(finalize(current));
  return merged;
}

// Build a CSS transform string from a clip transform.
// scale: 1=original, >1=zoom in. x/y: -1..1 fraction of composition size (positive = right/down).
function transformToCss(t?: { scale: number; x: number; y: number }): string | undefined {
  if (!t) return undefined;
  const scale = t.scale ?? 1;
  const x = t.x ?? 0;
  const y = t.y ?? 0;
  if (Math.abs(scale - 1) < 0.001 && Math.abs(x) < 0.001 && Math.abs(y) < 0.001) return undefined;
  // translate as percentage of element (which fills 100% of composition), then scale around center
  return `translate(${x * 100}%, ${y * 100}%) scale(${scale})`;
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
  const v1Merged = mergeContiguousClips(v1Clips, 'v1');
  const a1Merged = mergeContiguousClips(a1Clips, 'a1');

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* 1. Base video clips (merged contiguous ranges → single <Video> per range) */}
      {/* Muted because audio is handled separately via a1 clips — the muxed video
          contains embedded audio which would play on top of the separate Audio track */}
      {videoSrc && v1Merged.map((range) => {
        const from = Math.round((range.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((range.timelineEndMs - range.timelineStartMs) / 1000) * FPS));
        const startFrom = Math.round((range.sourceInMs / 1000) * FPS);
        const transformCss = transformToCss(range.transform);
        return (
          <Sequence key={range.key} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ overflow: 'hidden' }}>
              <Video
                src={videoSrc}
                startFrom={startFrom}
                volume={0}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  transform: transformCss,
                  transformOrigin: 'center center',
                }}
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {/* 2. Cutaways */}
      {cutaways.map((clip) => {
        const src = clipSources[clip.fileName];
        if (!src) return null;
        const from = Math.round((clip.timelineStartMs / 1000) * FPS);
        const dur = Math.max(1, Math.round(((clip.timelineEndMs - clip.timelineStartMs) / 1000) * FPS));
        const transformCss = transformToCss(clip.transform);
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ opacity: clip.opacity ?? 1, overflow: 'hidden' }}>
              {clip.type === 'image' ? (
                <Img
                  src={src}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    transform: transformCss,
                    transformOrigin: 'center center',
                  }}
                />
              ) : (
                <Video
                  src={src}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    transform: transformCss,
                    transformOrigin: 'center center',
                  }}
                />
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
          <Sequence key={range.key} from={from} durationInFrames={dur}>
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
                // Center on y — see comment in reel-timeline-view.tsx.
                transform: 'translateY(-50%)',
                textAlign: style?.textAlign ?? 'center',
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
  const compositionAspect = useComposeStore((s) => s.aspectRatio);
  const setCompositionAspect = useComposeStore((s) => s.setAspectRatio);

  // Composition canvas dimensions per aspect ratio (multiples of 2 required by H.264)
  const { compositionWidth, compositionHeight } = useMemo(() => {
    switch (compositionAspect) {
      case '9:16': return { compositionWidth: 1080, compositionHeight: 1920 };
      case '1:1':  return { compositionWidth: 1080, compositionHeight: 1080 };
      case '4:5':  return { compositionWidth: 1080, compositionHeight: 1350 };
      case '16:9':
      default:     return { compositionWidth: 1920, compositionHeight: 1080 };
    }
  }, [compositionAspect]);

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

  // Composition dimensions derived from aspect ratio
  const aspectRatioCss = `${compositionWidth} / ${compositionHeight}`;

  return (
    <div className="flex h-full flex-col bg-black">
      {/* Aspect ratio selector */}
      <div className="flex items-center justify-center gap-1 px-2 py-1 border-b border-border/50 bg-background/20 flex-shrink-0">
        <span className="text-[10px] text-muted-foreground mr-1">Formato:</span>
        {(['16:9', '9:16', '1:1', '4:5'] as const).map((ratio) => (
          <button
            key={ratio}
            onClick={() => setCompositionAspect(ratio)}
            className={`px-2 py-0.5 rounded text-[10px] border ${
              compositionAspect === ratio
                ? 'bg-primary/20 border-primary text-primary'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {ratio}
          </button>
        ))}
      </div>

      {/* Player — fits container by height */}
      <div className="flex flex-1 min-h-0 items-center justify-center p-1">
        <Player
          ref={playerRef}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          component={ComposeComposition as React.ComponentType<any>}
          inputProps={inputProps}
          durationInFrames={durationInFrames}
          compositionWidth={compositionWidth}
          compositionHeight={compositionHeight}
          fps={FPS}
          style={{
            height: '100%',
            maxWidth: '100%',
            aspectRatio: aspectRatioCss,
          }}
          controls={false}
          loop={false}
          autoPlay={false}
        />
      </div>
    </div>
  );
}
