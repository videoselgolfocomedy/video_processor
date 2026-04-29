'use client';

import React, { useMemo } from 'react';
import { Player } from '@remotion/player';
import type { PlayerRef } from '@remotion/player';
import { AbsoluteFill, Video, Sequence } from 'remotion';
import { SubtitleBlock } from '@/remotion/components/SubtitleBlock';
import type { SubtitleSegment, SubtitleStyle, CompositionClip } from '@/types/project';

const FPS = 30;

// Build a CSS transform string from a clip transform (matches compose-preview).
function transformToCss(t?: { scale: number; x: number; y: number }): string | undefined {
  if (!t) return undefined;
  const scale = t.scale ?? 1;
  const x = t.x ?? 0;
  const y = t.y ?? 0;
  if (Math.abs(scale - 1) < 0.001 && Math.abs(x) < 0.001 && Math.abs(y) < 0.001) return undefined;
  return `translate(${x * 100}%, ${y * 100}%) scale(${scale})`;
}

interface SubtitlePreviewProps {
  segments: SubtitleSegment[];
  style: SubtitleStyle;
  durationMs: number;
  videoSrc?: string;
  width?: number;
  height?: number;
  fps?: number;
  orientation?: 'horizontal' | 'vertical';
  playerRef?: React.RefObject<PlayerRef>;
  /** When provided, renders compose clips with Sequences instead of raw full video */
  composeClips?: CompositionClip[];
}

// Wrapper that matches Remotion's expected component signature
const PreviewComposition: React.FC<{
  segments: SubtitleSegment[];
  style: SubtitleStyle;
  videoSrc?: string;
  composeClips?: CompositionClip[];
  fps: number;
}> = ({ segments, style, videoSrc, composeClips, fps }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#1a1a2e' }}>
      {videoSrc && composeClips && composeClips.length > 0 ? (
        // Compose mode: render clips with Sequences
        composeClips.map((clip) => {
          const from = Math.round((clip.timelineStartMs / 1000) * fps);
          const dur = Math.max(1, Math.round(((clip.timelineEndMs - clip.timelineStartMs) / 1000) * fps));
          const startFrom = Math.round((clip.sourceInMs / 1000) * fps);
          const transformCss = transformToCss(clip.transform);
          return (
            <Sequence key={clip.id} from={from} durationInFrames={dur}>
              <AbsoluteFill style={{ overflow: 'hidden' }}>
                <Video
                  src={videoSrc}
                  startFrom={startFrom}
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
        })
      ) : videoSrc ? (
        <Video
          src={videoSrc}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ) : null}
      {segments.map((segment) => (
        <SubtitleBlock key={segment.id} segment={segment} style={style} />
      ))}
    </AbsoluteFill>
  );
};

export function SubtitlePreview({
  segments,
  style,
  durationMs,
  videoSrc,
  width = 1920,
  height = 1080,
  fps = 30,
  orientation = 'horizontal',
  playerRef,
  composeClips,
}: SubtitlePreviewProps) {
  const durationInFrames = Math.max(1, Math.ceil((durationMs / 1000) * fps));

  const compositionWidth = orientation === 'vertical' ? 1080 : width;
  const compositionHeight = orientation === 'vertical' ? 1920 : height;

  const aspectRatio = compositionWidth / compositionHeight;
  const playerHeight = orientation === 'vertical' ? 500 : 300;
  const playerWidth = Math.round(playerHeight * aspectRatio);

  const inputProps = useMemo(
    () => ({ segments, style, videoSrc, composeClips, fps }),
    [segments, style, videoSrc, composeClips, fps]
  );

  return (
    <div className="flex justify-center rounded-lg bg-black p-2">
      <Player
        ref={playerRef}
        component={PreviewComposition as React.ComponentType<Record<string, unknown>>}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        compositionWidth={compositionWidth}
        compositionHeight={compositionHeight}
        fps={fps}
        style={{
          width: playerWidth,
          height: playerHeight,
        }}
        controls
        loop
        autoPlay={false}
      />
    </div>
  );
}
