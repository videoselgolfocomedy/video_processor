import React, { useCallback } from 'react';
import { AbsoluteFill, Video, Audio, useCurrentFrame, useVideoConfig } from 'remotion';
import { SubtitleLayer } from './SubtitleLayer';
import type { SubtitleSegment, SubtitleStyle, VolumeCurvePoint } from '@/types/project';

export interface StandupFullProps {
  videoSrc?: string;
  audioSrc?: string;
  ambientAudioSrc?: string;
  ambientBaseVolume?: number;
  volumeMap?: VolumeCurvePoint[];
  segments: SubtitleSegment[];
  subtitleStyle: SubtitleStyle;
}

export const StandupFull: React.FC<StandupFullProps> = ({
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
    // Find surrounding points and interpolate
    let prev = volumeMap[0];
    for (const point of volumeMap) {
      if (point.timeMs > timeMs) break;
      prev = point;
    }
    // Multiply the base volume by the curve value (curve is relative energy)
    return ambientBaseVolume * Math.min(prev.volume, 3.0);
  }, [volumeMap, ambientBaseVolume, fps]);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
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
      {audioSrc && <Audio src={audioSrc} />}
      {ambientAudioSrc && (
        <Audio src={ambientAudioSrc} volume={getAmbientVolume(frame)} />
      )}
      <SubtitleLayer segments={segments} style={subtitleStyle} />
    </AbsoluteFill>
  );
};
