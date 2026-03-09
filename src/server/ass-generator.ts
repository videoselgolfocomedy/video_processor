/**
 * Generates ASS (Advanced SubStation Alpha) subtitle files from SubtitleSegment[] + SubtitleStyle.
 * Used by the FFmpeg render pipeline to burn subtitles directly into the video.
 */

import type { SubtitleSegment, SubtitleStyle, SubtitleWord } from '@/types/project';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert CSS color (#RRGGBB, rgba(r,g,b,a), "transparent") → ASS &HAABBGGRR */
function cssColorToASS(color: string): string {
  // ASS alpha: 00 = opaque, FF = fully transparent
  if (!color || color === 'transparent') {
    return '&HFF000000';
  }

  // rgba(r,g,b,a) or rgb(r,g,b)
  const rgbaMatch = color.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/
  );
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1], 10);
    const g = parseInt(rgbaMatch[2], 10);
    const b = parseInt(rgbaMatch[3], 10);
    const a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
    // ASS alpha: 00=opaque, FF=transparent (inverted from CSS)
    const alpha = Math.round((1 - a) * 255);
    return (
      '&H' +
      hex2(alpha) +
      hex2(b) +
      hex2(g) +
      hex2(r)
    );
  }

  // #RRGGBB or #RGB
  const hexMatch = color.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return '&H00' + hex2(b) + hex2(g) + hex2(r);
    }
    if (hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = parseInt(hex.slice(6, 8), 16);
      // CSS alpha in hex: 00=transparent, FF=opaque → invert for ASS
      const alpha = 255 - a;
      return '&H' + hex2(alpha) + hex2(b) + hex2(g) + hex2(r);
    }
  }

  // Fallback: opaque white
  return '&H00FFFFFF';
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase();
}

/** Convert milliseconds → ASS time "H:MM:SS.CC" (centiseconds) */
function msToASS(ms: number): string {
  if (ms < 0) ms = 0;
  const totalCs = Math.round(ms / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Escape text for ASS Dialogue lines */
function escapeASSText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

/** Apply textTransform to text */
function applyTransform(text: string, transform: SubtitleStyle['textTransform']): string {
  switch (transform) {
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    default: return text;
  }
}

// ---------------------------------------------------------------------------
// Style mapping
// ---------------------------------------------------------------------------

function buildASSStyle(style: SubtitleStyle, width: number): string {
  const fontname = style.fontFamily;
  const fontsize = style.fontSize;
  const bold = style.fontWeight >= 700 ? -1 : 0;
  const italic = 0;
  const underline = 0;
  const strikeout = 0;

  const primaryColour = cssColorToASS(style.color);

  // Determine if we're using a background box (BorderStyle=3) or outline (BorderStyle=1)
  const hasBackground = style.backgroundColor && style.backgroundColor !== 'transparent';

  let borderStyle: number;
  let outline: number;
  let backColour: string;
  let outlineColour: string;

  if (hasBackground) {
    // Box mode: BorderStyle=3, Outline controls box padding, BackColour is the box color
    borderStyle = 3;
    outline = style.backgroundPadding;
    backColour = cssColorToASS(style.backgroundColor);
    outlineColour = cssColorToASS(style.backgroundColor);
  } else {
    // Outline mode: BorderStyle=1
    borderStyle = 1;
    outline = style.strokeWidth;
    outlineColour = cssColorToASS(style.strokeColor);
    backColour = cssColorToASS(style.shadowColor);
  }

  // Shadow
  let shadow = 0;
  if (!hasBackground) {
    const fromOffset = Math.max(Math.abs(style.shadowOffsetX), Math.abs(style.shadowOffsetY));
    const fromBlur = style.shadowBlur > 0 ? Math.ceil(style.shadowBlur / 3) : 0;
    shadow = Math.max(fromOffset, fromBlur);
  }

  // Alignment: bottom=2, center=5, top=8
  let alignment: number;
  switch (style.position) {
    case 'top': alignment = 8; break;
    case 'center': alignment = 5; break;
    default: alignment = 2; break;
  }

  // Margins
  const marginV = style.marginBottom;
  const marginH = Math.max(0, Math.round((width - style.maxWidth) / 2));

  // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,
  //         Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,
  //         BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  return [
    'Style: Default',
    fontname,
    fontsize,
    primaryColour,
    primaryColour,   // SecondaryColour (used for karaoke, not critical)
    outlineColour,
    backColour,
    bold,
    italic,
    underline,
    strikeout,
    100,  // ScaleX
    100,  // ScaleY
    0,    // Spacing
    0,    // Angle
    borderStyle,
    outline,
    shadow,
    alignment,
    marginH,  // MarginL
    marginH,  // MarginR
    marginV,  // MarginV
    1,    // Encoding (1 = default)
  ].join(',');
}

// ---------------------------------------------------------------------------
// Event generators per animation type
// ---------------------------------------------------------------------------

type DialogueLine = {
  start: number; // ms
  end: number;   // ms
  text: string;  // ASS-formatted text (with overrides if needed)
};

function generateNone(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
): DialogueLine[] {
  return segments.map((seg) => ({
    start: seg.startMs,
    end: seg.endMs,
    text: escapeASSText(applyTransform(seg.text, style.textTransform)),
  }));
}

function generateFade(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
  fps: number,
): DialogueLine[] {
  const fadeMs = Math.round((5 / fps) * 1000);
  return segments.map((seg) => ({
    start: seg.startMs,
    end: seg.endMs,
    text: `{\\fad(${fadeMs},0)}` + escapeASSText(applyTransform(seg.text, style.textTransform)),
  }));
}

function generateTypewriter(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
): DialogueLine[] {
  const lines: DialogueLine[] = [];
  for (const seg of segments) {
    const words = seg.words;
    if (!words || words.length === 0) {
      // Fallback to none
      lines.push({
        start: seg.startMs,
        end: seg.endMs,
        text: escapeASSText(applyTransform(seg.text, style.textTransform)),
      });
      continue;
    }

    for (let i = 0; i < words.length; i++) {
      const accumulated = words
        .slice(0, i + 1)
        .map((w) => applyTransform(w.text, style.textTransform))
        .join(' ');
      const start = words[i].startMs;
      const end = i + 1 < words.length ? words[i + 1].startMs : seg.endMs;
      lines.push({
        start,
        end,
        text: escapeASSText(accumulated),
      });
    }
  }
  return lines;
}

function generateWordHighlight(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
): DialogueLine[] {
  const lines: DialogueLine[] = [];
  const highlightASS = cssColorToASS(style.highlightColor);
  const baseASS = cssColorToASS(style.color);

  for (const seg of segments) {
    const words = seg.words;
    if (!words || words.length === 0) {
      lines.push({
        start: seg.startMs,
        end: seg.endMs,
        text: escapeASSText(applyTransform(seg.text, style.textTransform)),
      });
      continue;
    }

    for (let i = 0; i < words.length; i++) {
      const start = words[i].startMs;
      const end = i + 1 < words.length ? words[i + 1].startMs : seg.endMs;

      // Build text with override on active word
      const parts: string[] = [];
      for (let j = 0; j < words.length; j++) {
        const w = escapeASSText(applyTransform(words[j].text, style.textTransform));
        if (j === i) {
          parts.push(`{\\1c${highlightASS}}${w}{\\1c${baseASS}}`);
        } else {
          parts.push(w);
        }
      }

      lines.push({ start, end, text: parts.join(' ') });
    }
  }
  return lines;
}

function generatePop(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
  fps: number,
): DialogueLine[] {
  const lines: DialogueLine[] = [];
  const halfMs = Math.round((3 / fps) * 1000);
  const fullMs = Math.round((6 / fps) * 1000);

  for (const seg of segments) {
    const words = seg.words;
    if (!words || words.length === 0) {
      lines.push({
        start: seg.startMs,
        end: seg.endMs,
        text: escapeASSText(applyTransform(seg.text, style.textTransform)),
      });
      continue;
    }

    for (let i = 0; i < words.length; i++) {
      const start = words[i].startMs;
      const end = i + 1 < words.length ? words[i + 1].startMs : seg.endMs;

      // All words up to current
      const parts: string[] = [];
      for (let j = 0; j <= i; j++) {
        const w = escapeASSText(applyTransform(words[j].text, style.textTransform));
        if (j === i) {
          // Pop animation on the new word: scale 50→120→100
          parts.push(
            `{\\fscx50\\fscy50\\t(0,${halfMs},\\fscx120\\fscy120)\\t(${halfMs},${fullMs},\\fscx100\\fscy100)}${w}{\\fscx100\\fscy100}`
          );
        } else {
          parts.push(w);
        }
      }

      lines.push({ start, end, text: parts.join(' ') });
    }
  }
  return lines;
}

function generatePunchline(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
): DialogueLine[] {
  const lines: DialogueLine[] = [];
  // Estimate chars per line from maxWidth and average char width
  const avgCharWidth = style.fontSize * 0.55;
  const charsPerLine = Math.max(10, Math.floor(style.maxWidth / avgCharWidth));

  for (const seg of segments) {
    const words = seg.words;
    if (!words || words.length === 0) {
      lines.push({
        start: seg.startMs,
        end: seg.endMs,
        text: escapeASSText(applyTransform(seg.text, style.textTransform)),
      });
      continue;
    }

    // Group words into visual lines
    type VisualLine = { words: SubtitleWord[]; text: string; appearMs: number };
    const visualLines: VisualLine[] = [];
    let currentWords: SubtitleWord[] = [];
    let currentChars = 0;

    for (const word of words) {
      const wordLen = word.text.length + (currentWords.length > 0 ? 1 : 0);
      if (currentWords.length > 0 && currentChars + wordLen > charsPerLine) {
        const lastWord = currentWords[currentWords.length - 1];
        visualLines.push({
          words: currentWords,
          text: currentWords.map((w) => applyTransform(w.text, style.textTransform)).join(' '),
          appearMs: lastWord.startMs,
        });
        currentWords = [word];
        currentChars = word.text.length;
      } else {
        currentWords.push(word);
        currentChars += wordLen;
      }
    }
    if (currentWords.length > 0) {
      const lastWord = currentWords[currentWords.length - 1];
      visualLines.push({
        words: currentWords,
        text: currentWords.map((w) => applyTransform(w.text, style.textTransform)).join(' '),
        appearMs: lastWord.startMs,
      });
    }

    // For each visual line reveal step, emit a dialogue line that shows
    // all lines revealed so far (joined with \N for ASS line breaks).
    // Each step starts when that line's last word begins and lasts until
    // either the next line reveals or the segment ends.
    for (let i = 0; i < visualLines.length; i++) {
      const start = visualLines[i].appearMs;
      const end = i + 1 < visualLines.length ? visualLines[i + 1].appearMs : seg.endMs;
      const revealedText = visualLines
        .slice(0, i + 1)
        .map((vl) => escapeASSText(vl.text))
        .join('\\N');
      lines.push({ start, end, text: revealedText });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate an ASS subtitle file from segments and style.
 *
 * PlayRes is set to the actual output resolution so that libass does NOT need
 * to do any scaling (scale factor = 1). The caller is responsible for
 * pre-scaling all pixel-based style values to match the output resolution.
 *
 * @param segments Subtitle segments with optional word-level timing
 * @param style    Subtitle style **pre-scaled** to the target resolution
 * @param fps      Output video frame rate
 * @param width    Output video width (used as PlayResX)
 * @param height   Output video height (used as PlayResY)
 * @returns Complete ASS file content as a string
 */
export function generateASS(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
  fps: number,
  width: number,
  height: number,
): string {
  const PLAY_RES_X = width;
  const PLAY_RES_Y = height;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    buildASSStyle(style, PLAY_RES_X),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  // Generate dialogue lines based on animation type
  let dialogueLines: DialogueLine[];
  switch (style.animation) {
    case 'fade':
      dialogueLines = generateFade(segments, style, fps);
      break;
    case 'typewriter':
      dialogueLines = generateTypewriter(segments, style);
      break;
    case 'word-highlight':
      dialogueLines = generateWordHighlight(segments, style);
      break;
    case 'pop':
      dialogueLines = generatePop(segments, style, fps);
      break;
    case 'punchline':
      dialogueLines = generatePunchline(segments, style);
      break;
    default:
      dialogueLines = generateNone(segments, style);
      break;
  }

  const events = dialogueLines.map(
    (line) =>
      `Dialogue: 0,${msToASS(line.start)},${msToASS(line.end)},Default,,0,0,0,,${line.text}`
  );

  return header.join('\n') + '\n' + events.join('\n') + '\n';
}
