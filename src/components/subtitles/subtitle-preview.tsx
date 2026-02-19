'use client';

import React, { useMemo } from 'react';
import { Player } from '@remotion/player';
import type { PlayerRef } from '@remotion/player';
import { AbsoluteFill, Video } from 'remotion';
import { SubtitleBlock } from '@/remotion/components/SubtitleBlock';
import type { SubtitleSegment, SubtitleStyle } from '@/types/project';

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
}

// Wrapper that matches Remotion's expected component signature
const PreviewComposition: React.FC<{
  segments: SubtitleSegment[];
  style: SubtitleStyle;
  videoSrc?: string;
}> = ({ segments, style, videoSrc }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#1a1a2e' }}>
      {videoSrc && (
        <Video
          src={videoSrc}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />
      )}
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
}: SubtitlePreviewProps) {
  const durationInFrames = Math.max(1, Math.ceil((durationMs / 1000) * fps));

  const compositionWidth = orientation === 'vertical' ? 1080 : width;
  const compositionHeight = orientation === 'vertical' ? 1920 : height;

  const aspectRatio = compositionWidth / compositionHeight;
  const playerHeight = orientation === 'vertical' ? 500 : 300;
  const playerWidth = Math.round(playerHeight * aspectRatio);

  const inputProps = useMemo(
    () => ({ segments, style, videoSrc }),
    [segments, style, videoSrc]
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
