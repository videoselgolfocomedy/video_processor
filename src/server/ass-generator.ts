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

// ---------------------------------------------------------------------------
// Emoji font fallback
// ---------------------------------------------------------------------------

const EMOJI_FONT = 'Noto Emoji';

// RegExp constructor bypasses TypeScript's regex literal target check (TS1501).
// Node.js runtime supports Unicode property escapes with the 'u' flag.
const EMOJI_RE = new RegExp(
  '(?:\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F)(?:\\uFE0F|\\u200D(?:\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F))*',
  'gu'
);

/** Wrap emoji characters with ASS font override tags to use Noto Emoji */
function wrapEmojiWithFont(text: string, originalFont: string): string {
  return text.replace(EMOJI_RE, (match) =>
    `{\\fn${EMOJI_FONT}}${match}{\\fn${originalFont}}`
  );
}

/** Apply textTransform to text */
function applyTransform(text: string, transform: SubtitleStyle['textTransform']): string {
  switch (transform) {
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    default: return text;
  }
}

/**
 * Split text into words while tracking which word indices are preceded by a newline.
 * Returns the words array and a Set of indices where a newline separator should be used.
 */
function splitWordsWithNewlines(text: string): { words: string[]; newlineBefore: Set<number> } {
  const words: string[] = [];
  const newlineBefore = new Set<number>();
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const lineWords = lines[li].split(/\s+/).filter(Boolean);
    for (let wi = 0; wi < lineWords.length; wi++) {
      if (li > 0 && wi === 0 && words.length > 0) {
        newlineBefore.add(words.length);
      }
      words.push(lineWords[wi]);
    }
  }
  return { words, newlineBefore };
}

/** Join an array of ASS-formatted word strings using \\N at newline positions, space otherwise */
function joinWordsASS(parts: string[], newlineBefore: Set<number>): string {
  return parts.map((p, i) => {
    if (i === 0) return p;
    return (newlineBefore.has(i) ? '\\N' : ' ') + p;
  }).join('');
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
// Per-word style override tags
// ---------------------------------------------------------------------------

/** Build ASS override tag string for a word's custom style */
function buildWordOverride(ws: SubtitleWord['style']): string {
  if (!ws) return '';
  const tags: string[] = [];
  if (ws.color) tags.push(`\\c${cssColorToASS(ws.color)}`);
  if (ws.fontSize) tags.push(`\\fs${ws.fontSize}`);
  if (ws.fontWeight != null && ws.fontWeight >= 700) tags.push('\\b1');
  return tags.length ? `{${tags.join('')}}` : '';
}

/** Build ASS override tag string that resets to the default subtitle style */
function buildDefaultOverride(style: SubtitleStyle): string {
  return `{\\c${cssColorToASS(style.color)}\\fs${style.fontSize}\\b${style.fontWeight >= 700 ? 1 : 0}}`;
}

/** Apply per-word style: returns override prefix + text (no suffix reset) */
function styledWord(ws: SubtitleWord | undefined, text: string, style: SubtitleStyle, hasAnyStyles: boolean): string {
  if (!hasAnyStyles) return text;
  const override = ws?.style ? (buildWordOverride(ws.style) || buildDefaultOverride(style)) : buildDefaultOverride(style);
  return override + text;
}

/**
 * Build ASS text for a segment using seg.text as source of truth.
 * Maps per-word styles from seg.words[] by index.
 * Each word gets an explicit override tag (no suffix resets needed).
 * Preserves user-entered newlines as \\N (ASS line break).
 */
function buildSegTextWithStyles(seg: SubtitleSegment, style: SubtitleStyle): string {
  const { words: displayWords, newlineBefore } = splitWordsWithNewlines(seg.text);
  const wordStyles = seg.words ?? [];
  const hasAnyStyle = wordStyles.some((w) => w.style);

  if (!hasAnyStyle) {
    return escapeASSText(applyTransform(seg.text, style.textTransform));
  }

  const defaultOverride = buildDefaultOverride(style);

  return displayWords.map((dw, i) => {
    const ws = i < wordStyles.length ? wordStyles[i] : undefined;
    const transformed = escapeASSText(applyTransform(dw, style.textTransform));
    const sep = i > 0 ? (newlineBefore.has(i) ? '\\N' : ' ') : '';
    // Each word gets explicit tags: custom style override OR default style reset
    const override = ws?.style ? (buildWordOverride(ws.style) || defaultOverride) : defaultOverride;
    return sep + override + transformed;
  }).join('');
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
    text: buildSegTextWithStyles(seg, style),
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
    text: `{\\fad(${fadeMs},0)}` + buildSegTextWithStyles(seg, style),
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
      lines.push({
        start: seg.startMs,
        end: seg.endMs,
        text: buildSegTextWithStyles(seg, style),
      });
      continue;
    }

    const { words: displayWords, newlineBefore } = splitWordsWithNewlines(seg.text);
    const wordCount = displayWords.length;
    const hasStyles = words.some((w) => w.style);

    for (let i = 0; i < wordCount; i++) {
      const accParts = displayWords.slice(0, i + 1).map((dw, j) => {
        const ws = j < words.length ? words[j] : undefined;
        const t = escapeASSText(applyTransform(dw, style.textTransform));
        return styledWord(ws, t, style, hasStyles);
      });
      const accumulated = joinWordsASS(accParts, newlineBefore);
      const wi = i < words.length ? words[i] : words[words.length - 1];
      const nextWi = i + 1 < words.length ? words[i + 1] : null;
      const start = wi.startMs;
      const end = nextWi ? nextWi.startMs : seg.endMs;
      lines.push({ start, end, text: accumulated });
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

  for (const seg of segments) {
    const words = seg.words;
    if (!words || words.length === 0) {
      lines.push({
        start: seg.startMs,
        end: seg.endMs,
        text: buildSegTextWithStyles(seg, style),
      });
      continue;
    }

    const { words: displayWords, newlineBefore } = splitWordsWithNewlines(seg.text);
    const wordCount = displayWords.length;
    const hasStyles = words.some((w) => w.style);

    for (let i = 0; i < wordCount; i++) {
      const wi = i < words.length ? words[i] : words[words.length - 1];
      const nextWi = i + 1 < words.length ? words[i + 1] : null;
      const start = wi.startMs;
      const end = nextWi ? nextWi.startMs : seg.endMs;

      const parts: string[] = [];
      for (let j = 0; j < wordCount; j++) {
        const ws = j < words.length ? words[j] : undefined;
        let w = escapeASSText(applyTransform(displayWords[j], style.textTransform));
        w = styledWord(ws, w, style, hasStyles);
        if (j === i) {
          parts.push(`{\\1c${highlightASS}}${w}`);
        } else {
          parts.push(w);
        }
      }

      lines.push({ start, end, text: joinWordsASS(parts, newlineBefore) });
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
        text: buildSegTextWithStyles(seg, style),
      });
      continue;
    }

    const { words: displayWords, newlineBefore } = splitWordsWithNewlines(seg.text);
    const wordCount = displayWords.length;
    const hasStyles = words.some((w) => w.style);

    for (let i = 0; i < wordCount; i++) {
      const wi = i < words.length ? words[i] : words[words.length - 1];
      const nextWi = i + 1 < words.length ? words[i + 1] : null;
      const start = wi.startMs;
      const end = nextWi ? nextWi.startMs : seg.endMs;

      const parts: string[] = [];
      for (let j = 0; j <= i; j++) {
        const ws = j < words.length ? words[j] : undefined;
        let w = escapeASSText(applyTransform(displayWords[j], style.textTransform));
        w = styledWord(ws, w, style, hasStyles);
        if (j === i) {
          parts.push(
            `{\\fscx50\\fscy50\\t(0,${halfMs},\\fscx120\\fscy120)\\t(${halfMs},${fullMs},\\fscx100\\fscy100)}${w}`
          );
        } else {
          parts.push(w);
        }
      }

      lines.push({ start, end, text: joinWordsASS(parts, newlineBefore) });
    }
  }
  return lines;
}

function generatePunchline(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
): DialogueLine[] {
  const lines: DialogueLine[] = [];

  for (const seg of segments) {
    const words = seg.words;
    if (!words || words.length === 0) {
      lines.push({
        start: seg.startMs,
        end: seg.endMs,
        text: buildSegTextWithStyles(seg, style),
      });
      continue;
    }

    // Word-by-word accumulation — preserves user newlines as \\N
    const { words: displayWords, newlineBefore } = splitWordsWithNewlines(seg.text);
    const wordCount = displayWords.length;
    const hasStyles = words.some((w) => w.style);

    for (let i = 0; i < wordCount; i++) {
      // Timing: use words[i] if available, else last known word
      const wi = i < words.length ? words[i] : words[words.length - 1];
      const start = wi.startMs;
      const nextWi = i + 1 < words.length ? words[i + 1] : null;
      const end = nextWi ? nextWi.startMs : seg.endMs;

      // Accumulate all words up to i
      const parts = displayWords.slice(0, i + 1).map((dw, j) => {
        const ws = j < words.length ? words[j] : undefined;
        const t = escapeASSText(applyTransform(dw, style.textTransform));
        return styledWord(ws, t, style, hasStyles);
      });

      lines.push({ start, end, text: joinWordsASS(parts, newlineBefore) });
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
export interface ASSTextOverlay {
  text: string;
  startMs: number;
  endMs: number;
  x: number;         // 0-1 fraction
  y: number;         // 0-1 fraction
  width?: number;    // 0-1 fraction (max width)
  fontSize: number;
  fontFamily?: string;
  fontWeight?: number;
  color: string;
  backgroundColor?: string;
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  lineHeight?: number;
}

export function generateASS(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
  fps: number,
  width: number,
  height: number,
  textOverlays?: ASSTextOverlay[],
): string {
  const PLAY_RES_X = width;
  const PLAY_RES_Y = height;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    'WrapStyle: 1',
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

  // De-overlap segments: clamp each segment's endMs to the next segment's startMs.
  // Without this, libass stacks overlapping subtitles vertically causing "dancing" heights.
  const deoverlapped = segments.map((seg, i) => {
    if (i < segments.length - 1) {
      const nextStart = segments[i + 1].startMs;
      if (seg.endMs > nextStart) {
        return { ...seg, endMs: nextStart };
      }
    }
    return seg;
  }).filter((seg) => seg.endMs > seg.startMs);

  // Generate dialogue lines based on animation type
  let dialogueLines: DialogueLine[];
  switch (style.animation) {
    case 'fade':
      dialogueLines = generateFade(deoverlapped, style, fps);
      break;
    case 'typewriter':
      dialogueLines = generateTypewriter(deoverlapped, style);
      break;
    case 'word-highlight':
      dialogueLines = generateWordHighlight(deoverlapped, style);
      break;
    case 'pop':
      dialogueLines = generatePop(deoverlapped, style, fps);
      break;
    case 'punchline':
      dialogueLines = generatePunchline(deoverlapped, style);
      break;
    default:
      dialogueLines = generateNone(deoverlapped, style);
      break;
  }

  const events = dialogueLines.map(
    (line) => {
      const text = wrapEmojiWithFont(line.text, style.fontFamily);
      return `Dialogue: 0,${msToASS(line.start)},${msToASS(line.end)},Default,,0,0,0,,${text}`;
    }
  );

  // Add text overlay styles and events if provided
  if (textOverlays && textOverlays.length > 0) {
    const overlayStyles: string[] = [];
    for (let i = 0; i < textOverlays.length; i++) {
      const ov = textOverlays[i];
      const styleName = `TextOv${i}`;
      const bold = (ov.fontWeight ?? 400) >= 700 ? -1 : 0;
      const primaryColour = cssColorToASS(ov.color);

      const hasBg = ov.backgroundColor && ov.backgroundColor !== 'transparent';
      const borderStyle = hasBg ? 3 : 1;
      const outlineVal = hasBg ? 8 : 0;
      const backColour = hasBg ? cssColorToASS(ov.backgroundColor!) : '&H00000000';
      const outlineColour = hasBg ? cssColorToASS(ov.backgroundColor!) : '&H00000000';

      let shadow = 0;
      if (ov.shadowX || ov.shadowY || ov.shadowBlur) {
        const fromOffset = Math.max(Math.abs(ov.shadowX ?? 0), Math.abs(ov.shadowY ?? 0));
        const fromBlur = ov.shadowBlur ? Math.ceil(ov.shadowBlur / 3) : 0;
        shadow = Math.max(fromOffset, fromBlur);
      }
      const shadowBackColour = ov.shadowColor ? cssColorToASS(ov.shadowColor) : backColour;

      // Position: use alignment + per-event margin overrides for proper text wrapping
      // \pos breaks text wrapping in ASS, so we use margins instead
      const maxWidthPx = Math.round((ov.width ?? 0.8) * width);
      const halfW = maxWidthPx / 2;

      // Horizontal margins: center the text area around ov.x
      const marginL = Math.max(0, Math.round(ov.x * width - halfW));
      const marginR = Math.max(0, Math.round((1 - ov.x) * width - halfW));

      // Vertical alignment and margin based on Y position
      let alignment: number;
      let marginV: number;
      if (ov.y <= 0.33) {
        // Top: alignment 8 (top-center), marginV from top
        alignment = 8;
        marginV = Math.round(ov.y * height);
      } else if (ov.y >= 0.67) {
        // Bottom: alignment 2 (bottom-center), marginV from bottom
        alignment = 2;
        marginV = Math.round((1 - ov.y) * height);
      } else {
        // Middle: alignment 5 (center), marginV adjusts center offset
        alignment = 5;
        // MarginV for center alignment doesn't offset in ASS — use \pos for Y only
        marginV = 0;
      }

      overlayStyles.push([
        `Style: ${styleName}`,
        ov.fontFamily ?? 'Inter',
        ov.fontSize,
        primaryColour,
        primaryColour,
        outlineColour,
        shadow > 0 ? shadowBackColour : backColour,
        bold,
        0, 0, 0,
        100, 100,
        0, 0,
        borderStyle,
        outlineVal,
        shadow,
        alignment,
        marginL,
        marginR,
        marginV,
        1,
      ].join(','));

      const escapedText = wrapEmojiWithFont(escapeASSText(ov.text), ov.fontFamily ?? 'Inter');

      // For center-Y positions, we need \pos for vertical placement since MarginV
      // doesn't offset center alignment. For top/bottom, margins handle everything.
      let overrideTags = '';
      if (ov.y > 0.33 && ov.y < 0.67) {
        const posX = Math.round(ov.x * width);
        const posY = Math.round(ov.y * height);
        overrideTags = `{\\pos(${posX},${posY})}`;
      }

      // Per-event margin overrides (columns 5-7 in Dialogue line)
      events.push(
        `Dialogue: 1,${msToASS(ov.startMs)},${msToASS(ov.endMs)},${styleName},,${marginL},${marginR},${marginV},,${overrideTags}${escapedText}`
      );
    }

    // Insert all overlay styles before the empty line before [Events]
    const eventsIdx = header.indexOf('[Events]');
    header.splice(eventsIdx, 0, ...overlayStyles);
  }

  return header.join('\n') + '\n' + events.join('\n') + '\n';
}
