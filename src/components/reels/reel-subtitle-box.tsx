'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useReelStore } from '@/stores/reel-store';

interface ReelSubtitleBoxProps {
  reelId: string;
  canvasWidth: number;
  canvasHeight: number;
}

export function ReelSubtitleBox({ reelId, canvasWidth, canvasHeight }: ReelSubtitleBoxProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const setReelSubtitleStyle = useReelStore((s) => s.setReelSubtitleStyle);

  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState<'left' | 'right' | 'bottom' | null>(null);
  const dragOrigin = useRef({ mouseY: 0, mouseX: 0, marginBottom: 0, maxWidth: 0, lineHeight: 0 });

  const style = reel?.subtitleStyle;
  const scale = canvasWidth > 0 ? canvasWidth / 1080 : 1;

  const boxWidth = style ? (style.maxWidth ?? 900) * scale : 0;
  // Height based on lineHeight * fontSize * ~number of lines (min 2 lines worth)
  const lineHeightPx = style ? style.fontSize * (style.lineHeight ?? 1.2) * scale : 30;
  const boxHeight = style ? Math.max(lineHeightPx, lineHeightPx * 2.5) : 0;
  const boxLeft = (canvasWidth - boxWidth) / 2;

  // Position Y
  const marginScaled = style ? style.marginBottom * scale : 0;
  let boxTop = 0;
  if (style) {
    if (style.position === 'top') {
      boxTop = marginScaled;
    } else if (style.position === 'center') {
      boxTop = (canvasHeight - boxHeight) / 2;
    } else {
      boxTop = canvasHeight - marginScaled - boxHeight;
    }
  }

  // Active subtitle text
  const activeSeg = reel?.subtitleSegments.find(
    (s) => currentTimeMs >= s.startMs && currentTimeMs <= s.endMs
  );

  const applyTextTransform = (text: string) => {
    if (!style) return text;
    return style.textTransform === 'uppercase'
      ? text.toUpperCase()
      : style.textTransform === 'lowercase'
        ? text.toLowerCase()
        : text;
  };

  const displayText = activeSeg && style ? applyTextTransform(activeSeg.text) : null;

  // Check if the active segment has any per-word styles
  const hasWordStyles = activeSeg?.words?.some((w) => w.style);

  // Determine current word index for animations
  const animation = style?.animation;
  let words = activeSeg?.words;

  // Fix corrupted word timing: if words exist but their timing is outside the segment range,
  // redistribute them evenly within the segment
  if (words && words.length > 0 && activeSeg) {
    const allOutside = words.every(
      (w) => w.endMs < activeSeg.startMs - 100 || w.startMs > activeSeg.endMs + 100
    );
    if (allOutside) {
      const segDur = activeSeg.endMs - activeSeg.startMs;
      const wc = words.length;
      words = words.map((w, i) => ({
        ...w,
        startMs: activeSeg.startMs + Math.round(i * segDur / wc),
        endMs: activeSeg.startMs + Math.round((i + 1) * segDur / wc),
      }));
    }
  }

  let currentWordIdx = -1;
  if (words && words.length > 0 && animation && animation !== 'none' && animation !== 'fade') {
    for (let i = 0; i < words.length; i++) {
      const nextStart = i + 1 < words.length ? words[i + 1].startMs : activeSeg!.endMs;
      if (currentTimeMs >= words[i].startMs && currentTimeMs < nextStart) {
        currentWordIdx = i;
        break;
      }
    }
    if (currentWordIdx === -1 && words.length > 0 && currentTimeMs >= words[words.length - 1].startMs) {
      currentWordIdx = words.length - 1;
    }
  }

  // Should we use word-level rendering?
  const needsWordRendering = !!(
    (animation && animation !== 'none' && animation !== 'fade' && words && words.length > 0) ||
    hasWordStyles
  );

  // For typewriter/punchline/pop: only show accumulated words up to current
  const isAccumulating = animation === 'typewriter' || animation === 'punchline' || animation === 'pop';

  // Drag vertical handler
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!reel) return;
      e.preventDefault();
      e.stopPropagation();
      dragOrigin.current = {
        mouseY: e.clientY,
        mouseX: e.clientX,
        marginBottom: reel.subtitleStyle.marginBottom,
        maxWidth: reel.subtitleStyle.maxWidth ?? 900,
        lineHeight: reel.subtitleStyle.lineHeight ?? 1.2,
      };
      setDragging(true);
    },
    [reel]
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - dragOrigin.current.mouseY;
      const deltaComp = deltaY / scale;
      const currentStyle = useReelStore.getState().reels.find((r) => r.id === reelId)?.subtitleStyle;
      if (!currentStyle) return;

      const currentBoxTop = boxTop + deltaY;
      const canvasThird = canvasHeight / 3;

      let newPosition: 'top' | 'center' | 'bottom';
      let newMargin: number;

      if (currentBoxTop < canvasThird) {
        newPosition = 'top';
        newMargin = Math.max(0, Math.min(400, currentBoxTop / scale));
      } else if (currentBoxTop > canvasThird * 2) {
        newPosition = 'bottom';
        newMargin = Math.max(0, Math.min(400, (canvasHeight - currentBoxTop - boxHeight) / scale));
      } else {
        newPosition = 'center';
        newMargin = Math.max(0, dragOrigin.current.marginBottom + deltaComp);
      }

      setReelSubtitleStyle(reelId, {
        ...currentStyle,
        position: newPosition,
        marginBottom: Math.round(newMargin),
      });
    };

    const handleMouseUp = () => setDragging(false);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, reelId, scale, canvasHeight, boxHeight, boxTop, setReelSubtitleStyle]);

  // Resize handler (horizontal + vertical)
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, side: 'left' | 'right' | 'bottom') => {
      if (!reel) return;
      e.preventDefault();
      e.stopPropagation();
      dragOrigin.current = {
        mouseY: e.clientY,
        mouseX: e.clientX,
        marginBottom: reel.subtitleStyle.marginBottom,
        maxWidth: reel.subtitleStyle.maxWidth ?? 900,
        lineHeight: reel.subtitleStyle.lineHeight ?? 1.2,
      };
      setResizing(side);
    },
    [reel]
  );

  useEffect(() => {
    if (!resizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const currentStyle = useReelStore.getState().reels.find((r) => r.id === reelId)?.subtitleStyle;
      if (!currentStyle) return;

      if (resizing === 'bottom') {
        // Vertical resize → change lineHeight
        const deltaY = e.clientY - dragOrigin.current.mouseY;
        const deltaLines = deltaY / (currentStyle.fontSize * scale);
        const newLineHeight = Math.max(0.8, Math.min(3.0, dragOrigin.current.lineHeight + deltaLines * 0.4));
        setReelSubtitleStyle(reelId, { ...currentStyle, lineHeight: Math.round(newLineHeight * 10) / 10 });
      } else {
        // Horizontal resize → change maxWidth
        const deltaX = e.clientX - dragOrigin.current.mouseX;
        const deltaWidth = (resizing === 'right' ? deltaX : -deltaX) * 2;
        const newWidthPx = dragOrigin.current.maxWidth * scale + deltaWidth;
        const newMaxWidth = Math.round(Math.max(200, Math.min(1000, newWidthPx / scale)));
        setReelSubtitleStyle(reelId, { ...currentStyle, maxWidth: newMaxWidth });
      }
    };

    const handleMouseUp = () => setResizing(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing, reelId, scale, setReelSubtitleStyle]);

  if (!reel || !style || canvasWidth <= 0) return null;

  // Shadow CSS
  const shadowCss = style.shadowBlur > 0
    ? `0 0 ${style.shadowBlur * scale}px ${style.shadowColor ?? 'rgba(0,0,0,0.8)'}`
    : 'none';

  // Background
  const hasBg = style.backgroundColor && style.backgroundColor !== 'transparent';
  const bgPadding = (style.backgroundPadding ?? 0) * scale;

  return (
    <div
      className="absolute select-none"
      style={{
        left: boxLeft,
        top: boxTop,
        width: boxWidth,
        height: boxHeight,
        border: '1px dashed rgba(255,255,255,0.5)',
        borderRadius: 4,
        cursor: dragging ? 'grabbing' : 'grab',
        zIndex: 20,
      }}
      onMouseDown={handleDragStart}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/30"
        onMouseDown={(e) => handleResizeStart(e, 'left')}
      />

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/30"
        onMouseDown={(e) => handleResizeStart(e, 'right')}
      />

      {/* Bottom resize handle */}
      <div
        className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-white/30"
        onMouseDown={(e) => handleResizeStart(e, 'bottom')}
      />

      {/* Text content — align to match ASS: bottom→items-end, top→items-start, center→items-center */}
      <div
        className={cn(
          'flex justify-center h-full px-2 pointer-events-none overflow-hidden',
          style.position === 'top' ? 'items-start' : style.position === 'center' ? 'items-center' : 'items-end'
        )}
        style={{
          fontSize: style.fontSize * scale,
          fontFamily: `${style.fontFamily}, sans-serif`,
          fontWeight: style.fontWeight,
          color: displayText ? style.color : 'rgba(255,255,255,0.3)',
          textAlign: 'center',
          lineHeight: style.lineHeight ?? 1.2,
          textShadow: shadowCss,
          WebkitTextStroke: style.strokeWidth > 0 ? `${style.strokeWidth * scale}px ${style.strokeColor}` : undefined,
        }}
      >
        <span
          className="text-center"
          style={{
            wordBreak: 'break-word',
            overflowWrap: 'break-word',
            display: 'inline-block',
            maxWidth: '100%',
            whiteSpace: 'pre-wrap',
            backgroundColor: hasBg ? style.backgroundColor : undefined,
            padding: hasBg && bgPadding > 0 ? bgPadding : undefined,
            borderRadius: hasBg ? 2 : undefined,
          }}
        >
          {!displayText && 'Subtitle area'}
          {displayText && needsWordRendering && activeSeg?.words ? (
            (() => {
              // Split preserving newline positions
              const textLines = activeSeg.text.split('\n');
              const textWords: string[] = [];
              const newlineBefore = new Set<number>();
              for (let li = 0; li < textLines.length; li++) {
                const lw = textLines[li].split(/\s+/).filter(Boolean);
                for (let wi = 0; wi < lw.length; wi++) {
                  if (li > 0 && wi === 0 && textWords.length > 0) {
                    newlineBefore.add(textWords.length);
                  }
                  textWords.push(lw[wi]);
                }
              }

              const wordStyles = activeSeg.words;
              const visibleCount = isAccumulating && currentWordIdx >= 0
                ? Math.min(textWords.length, currentWordIdx + 1)
                : textWords.length;

              return textWords.slice(0, visibleCount).map((tw, i) => {
                const ws = i < wordStyles.length ? wordStyles[i].style : undefined;
                const isCurrentWord = i === currentWordIdx;

                // Color: per-word style takes priority, then animation highlight
                let wordColor: string | undefined;
                if (ws?.color) {
                  wordColor = ws.color;
                } else if (animation === 'word-highlight' && isCurrentWord) {
                  wordColor = style?.highlightColor;
                }

                const sep = i > 0 ? (newlineBefore.has(i) ? '\n' : ' ') : '';

                return (
                  <span
                    key={i}
                    style={{
                      color: wordColor ?? undefined,
                      fontSize: ws?.fontSize != null ? ws.fontSize * scale : undefined,
                      fontWeight: ws?.fontWeight ?? undefined,
                    }}
                  >
                    {sep}{applyTextTransform(tw)}
                  </span>
                );
              });
            })()
          ) : (
            displayText
          )}
        </span>
      </div>
    </div>
  );
}
