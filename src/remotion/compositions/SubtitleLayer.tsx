import React from 'react';
import { AbsoluteFill } from 'remotion';
import { SubtitleBlock } from '../components/SubtitleBlock';
import type { SubtitleSegment, SubtitleStyle } from '@/types/project';

interface SubtitleLayerProps {
  segments: SubtitleSegment[];
  style: SubtitleStyle;
}

export const SubtitleLayer: React.FC<SubtitleLayerProps> = ({
  segments,
  style,
}) => {
  return (
    <AbsoluteFill>
      {segments.map((segment) => (
        <SubtitleBlock key={segment.id} segment={segment} style={style} />
      ))}
    </AbsoluteFill>
  );
};
