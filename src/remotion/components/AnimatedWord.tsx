import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import type { SubtitleStyle } from '@/types/project';

interface AnimatedWordProps {
  text: string;
  startFrame: number;
  endFrame?: number;
  isActive: boolean;
  style: SubtitleStyle;
  animation: SubtitleStyle['animation'];
  wordStyle?: { color?: string; fontSize?: number; fontWeight?: number };
}

export const AnimatedWord: React.FC<AnimatedWordProps> = ({
  text,
  startFrame,
  isActive,
  style,
  animation,
  wordStyle,
}) => {
  const frame = useCurrentFrame();

  let opacity = 1;
  let scale = 1;
  let color = style.color;

  switch (animation) {
    case 'fade': {
      const fadeIn = interpolate(frame, [startFrame, startFrame + 5], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
      opacity = fadeIn;
      break;
    }
    case 'typewriter': {
      opacity = frame >= startFrame ? 1 : 0;
      break;
    }
    case 'word-highlight': {
      color = isActive ? style.highlightColor : style.color;
      break;
    }
    case 'pop': {
      if (frame >= startFrame && frame <= startFrame + 6) {
        scale = interpolate(
          frame,
          [startFrame, startFrame + 3, startFrame + 6],
          [0.5, 1.2, 1],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );
      }
      opacity = frame >= startFrame ? 1 : 0;
      break;
    }
    default:
      break;
  }

  // Apply per-word style overrides
  const finalColor = wordStyle?.color ?? color;
  const finalFontSize = wordStyle?.fontSize != null ? wordStyle.fontSize : undefined;
  const finalFontWeight = wordStyle?.fontWeight != null ? wordStyle.fontWeight : undefined;

  return (
    <span
      style={{
        opacity,
        color: finalColor,
        fontSize: finalFontSize,
        fontWeight: finalFontWeight,
        transform: `scale(${scale})`,
        display: 'inline-block',
        transition: 'color 0.1s',
        WebkitTextStroke: style.strokeWidth > 0
          ? `${style.strokeWidth}px ${style.strokeColor}`
          : undefined,
        textShadow:
          style.shadowBlur > 0
            ? `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${style.shadowBlur}px ${style.shadowColor}`
            : undefined,
      }}
    >
      {text}{' '}
    </span>
  );
};
