import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { AnimatedWord } from './AnimatedWord';
import type { SubtitleSegment, SubtitleStyle } from '@/types/project';

interface SubtitleBlockProps {
  segment: SubtitleSegment;
  style: SubtitleStyle;
}

export const SubtitleBlock: React.FC<SubtitleBlockProps> = ({
  segment,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const startFrame = Math.round((segment.startMs / 1000) * fps);
  const endFrame = Math.round((segment.endMs / 1000) * fps);

  // Only show during segment time
  if (frame < startFrame || frame > endFrame) return null;

  const textTransform = style.textTransform as React.CSSProperties['textTransform'];
  const displayText =
    textTransform === 'uppercase'
      ? segment.text.toUpperCase()
      : textTransform === 'lowercase'
        ? segment.text.toLowerCase()
        : segment.text;

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: style.maxWidth,
    textAlign: 'center',
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    color: style.color,
    WebkitTextStroke: style.strokeWidth > 0
      ? `${style.strokeWidth}px ${style.strokeColor}`
      : undefined,
    textShadow:
      style.shadowBlur > 0
        ? `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${style.shadowBlur}px ${style.shadowColor}`
        : undefined,
    padding: style.backgroundPadding,
    borderRadius: style.backgroundRadius,
    backgroundColor:
      style.backgroundColor !== 'transparent'
        ? style.backgroundColor
        : undefined,
  };

  // Position
  if (style.position === 'bottom') {
    containerStyle.bottom = style.marginBottom;
  } else if (style.position === 'top') {
    containerStyle.top = style.marginBottom;
  } else {
    containerStyle.top = '50%';
    containerStyle.transform = 'translate(-50%, -50%)';
  }

  if (style.animation !== 'none' && segment.words && segment.words.length > 0) {
    return (
      <div style={containerStyle}>
        {segment.words.map((word, i) => {
          const wordStartFrame = Math.round((word.startMs / 1000) * fps);
          const wordEndFrame = Math.round((word.endMs / 1000) * fps);
          const isActive = frame >= wordStartFrame && frame <= wordEndFrame;

          return (
            <AnimatedWord
              key={i}
              text={
                textTransform === 'uppercase'
                  ? word.text.toUpperCase()
                  : textTransform === 'lowercase'
                    ? word.text.toLowerCase()
                    : word.text
              }
              startFrame={wordStartFrame}
              endFrame={wordEndFrame}
              isActive={isActive}
              style={style}
              animation={style.animation}
            />
          );
        })}
      </div>
    );
  }

  return <div style={containerStyle}>{displayText}</div>;
};
