import React, { useCallback } from 'react';
import { AbsoluteFill, Video, Audio, useCurrentFrame, useVideoConfig } from 'remotion';
import { SubtitleLayer } from './SubtitleLayer';
import type { SubtitleSegment, SubtitleStyle, VolumeCurvePoint } from '@/types/project';

export interface StandupShortProps {
  videoSrc?: string;
  audioSrc?: string;
  ambientAudioSrc?: string;
  ambientBaseVolume?: number;
  volumeMap?: VolumeCurvePoint[];
  segments: SubtitleSegment[];
  subtitleStyle: SubtitleStyle;
}

export const StandupShort: React.FC<StandupShortProps> = ({
  videoSrc,
  audioSrc,
  ambientAudioSrc,
  ambientBaseVolume = 0.7,
  volumeMap,
  segments,
  subtitleStyle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const getAmbientVolume = useCallback((f: number): number => {
    if (!volumeMap || volumeMap.length === 0) return ambientBaseVolume;
    const timeMs = (f / fps) * 1000;
    let prev = volumeMap[0];
    for (const point of volumeMap) {
      if (point.timeMs > timeMs) break;
      prev = point;
    }
    return ambientBaseVolume * Math.min(prev.volume, 3.0);
  }, [volumeMap, ambientBaseVolume, fps]);

  // Adjust style for vertical format - scale font/width, keep user's position
  const verticalStyle: SubtitleStyle = {
    ...subtitleStyle,
    fontSize: Math.round(subtitleStyle.fontSize * 0.8),
    maxWidth: 600,
  };

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {videoSrc && (
        <Video
          src={videoSrc}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}
      {audioSrc && <Audio src={audioSrc} />}
      {ambientAudioSrc && (
        <Audio src={ambientAudioSrc} volume={getAmbientVolume(frame)} />
      )}
      <SubtitleLayer segments={segments} style={verticalStyle} />
    </AbsoluteFill>
  );
};
