import React from 'react';
import { Composition } from 'remotion';
import { StandupFull } from './compositions/StandupFull';
import { StandupShort } from './compositions/StandupShort';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FullComp = StandupFull as React.ComponentType<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ShortComp = StandupShort as React.ComponentType<any>;

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="StandupFull"
        component={FullComp}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          segments: [],
          subtitleStyle: {
            fontFamily: 'Inter',
            fontSize: 48,
            fontWeight: 700,
            color: '#FFFFFF',
            strokeColor: '#000000',
            strokeWidth: 3,
            backgroundColor: 'transparent',
            backgroundPadding: 8,
            backgroundRadius: 4,
            position: 'bottom',
            marginBottom: 80,
            animation: 'none',
            highlightColor: '#FFD700',
            textTransform: 'none',
            maxWidth: 900,
            lineHeight: 1.3,
            shadowColor: 'rgba(0,0,0,0.8)',
            shadowBlur: 8,
            shadowOffsetX: 2,
            shadowOffsetY: 2,
          },
        }}
      />
      <Composition
        id="StandupShort"
        component={ShortComp}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          segments: [],
          subtitleStyle: {
            fontFamily: 'Inter',
            fontSize: 48,
            fontWeight: 700,
            color: '#FFFFFF',
            strokeColor: '#000000',
            strokeWidth: 3,
            backgroundColor: 'transparent',
            backgroundPadding: 8,
            backgroundRadius: 4,
            position: 'center',
            marginBottom: 80,
            animation: 'word-highlight',
            highlightColor: '#FFE135',
            textTransform: 'uppercase',
            maxWidth: 700,
            lineHeight: 1.3,
            shadowColor: 'rgba(0,0,0,0.8)',
            shadowBlur: 8,
            shadowOffsetX: 2,
            shadowOffsetY: 2,
          },
        }}
      />
    </>
  );
};
