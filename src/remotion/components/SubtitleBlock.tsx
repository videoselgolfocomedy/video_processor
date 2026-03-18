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

  // Punchline animation: line-by-line reveal
  if (style.animation === 'punchline' && segment.words && segment.words.length > 0) {
    // Estimate chars per line from maxWidth and average char width
    const avgCharWidth = style.fontSize * 0.55;
    const charsPerLine = Math.max(10, Math.floor(style.maxWidth / avgCharWidth));

    // Group words into visual lines
    const lines: { words: typeof segment.words; appearFrame: number }[] = [];
    let currentLine: typeof segment.words = [];
    let currentLineChars = 0;

    for (const word of segment.words) {
      const wordLen = word.text.length + (currentLine.length > 0 ? 1 : 0);
      if (currentLine.length > 0 && currentLineChars + wordLen > charsPerLine) {
        const lastWord = currentLine[currentLine.length - 1];
        lines.push({
          words: currentLine,
          appearFrame: Math.round((lastWord.startMs / 1000) * fps),
        });
        currentLine = [word];
        currentLineChars = word.text.length;
      } else {
        currentLine.push(word);
        currentLineChars += wordLen;
      }
    }
    if (currentLine.length > 0) {
      const lastWord = currentLine[currentLine.length - 1];
      lines.push({
        words: currentLine,
        appearFrame: Math.round((lastWord.startMs / 1000) * fps),
      });
    }

    return (
      <div style={containerStyle}>
        {lines.map((line, lineIdx) => {
          const visible = frame >= line.appearFrame;
          if (!visible) return null;
          return (
            <div key={lineIdx} style={{ opacity: 1 }}>
              {line.words.map((w, wi) => {
                const wordText =
                  textTransform === 'uppercase'
                    ? w.text.toUpperCase()
                    : textTransform === 'lowercase'
                      ? w.text.toLowerCase()
                      : w.text;
                if (w.style) {
                  return (
                    <span
                      key={wi}
                      style={{
                        color: w.style.color ?? undefined,
                        fontSize: w.style.fontSize ?? undefined,
                        fontWeight: w.style.fontWeight ?? undefined,
                      }}
                    >
                      {wi > 0 ? ' ' : ''}{wordText}
                    </span>
                  );
                }
                return <React.Fragment key={wi}>{wi > 0 ? ' ' : ''}{wordText}</React.Fragment>;
              })}
            </div>
          );
        })}
      </div>
    );
  }

  if (style.animation !== 'none' && style.animation !== 'punchline' && segment.words && segment.words.length > 0) {
    // Detect line break positions from segment.text
    const newlineBefore = new Set<number>();
    const textLines = segment.text.split('\n');
    let wordIdx = 0;
    for (let li = 0; li < textLines.length; li++) {
      const lw = textLines[li].split(/\s+/).filter(Boolean);
      for (let wi = 0; wi < lw.length; wi++) {
        if (li > 0 && wi === 0 && wordIdx > 0) newlineBefore.add(wordIdx);
        wordIdx++;
      }
    }

    return (
      <div style={containerStyle}>
        {segment.words.map((word, i) => {
          const wordStartFrame = Math.round((word.startMs / 1000) * fps);
          const wordEndFrame = Math.round((word.endMs / 1000) * fps);
          const isActive = frame >= wordStartFrame && frame <= wordEndFrame;

          return (
            <React.Fragment key={i}>
              {newlineBefore.has(i) && <br />}
              <AnimatedWord
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
                wordStyle={word.style}
              />
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  return <div style={{ ...containerStyle, whiteSpace: 'pre-line' }}>{displayText}</div>;
};
