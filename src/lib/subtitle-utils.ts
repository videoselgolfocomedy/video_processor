import { v4 as uuidv4 } from 'uuid';
import type { SubtitleSegment } from '@/types/project';

/**
 * Split segments that exceed maxChars or maxDurationMs.
 * Splits at word boundaries when word-level timing is available,
 * otherwise splits text at the nearest space to the midpoint.
 */
export function splitLongSegments(
  segments: SubtitleSegment[],
  maxChars: number,
  maxDurationMs: number
): SubtitleSegment[] {
  const result: SubtitleSegment[] = [];

  for (const seg of segments) {
    const needsSplit =
      seg.text.length > maxChars ||
      (seg.endMs - seg.startMs) > maxDurationMs;

    if (!needsSplit) {
      result.push(seg);
      continue;
    }

    // Try word-level splitting first
    if (seg.words && seg.words.length >= 2) {
      const parts = splitByWords(seg, maxChars, maxDurationMs);
      result.push(...parts);
    } else {
      // Fallback: split text at midpoint space
      const parts = splitByText(seg, maxChars, maxDurationMs);
      result.push(...parts);
    }
  }

  return result;
}

function splitByWords(
  seg: SubtitleSegment,
  maxChars: number,
  maxDurationMs: number
): SubtitleSegment[] {
  const words = seg.words!;
  const results: SubtitleSegment[] = [];
  let start = 0;

  while (start < words.length) {
    let end = start + 1;
    let currentText = words[start].text;

    while (end < words.length) {
      const nextText = currentText + ' ' + words[end].text;
      const nextDuration = words[end].endMs - words[start].startMs;

      if (nextText.length > maxChars || nextDuration > maxDurationMs) {
        break;
      }
      currentText = nextText;
      end++;
    }

    // Ensure we take at least one word
    if (end === start) end = start + 1;

    const chunkWords = words.slice(start, end);
    results.push({
      id: uuidv4(),
      startMs: chunkWords[0].startMs,
      endMs: chunkWords[chunkWords.length - 1].endMs,
      text: chunkWords.map((w) => w.text).join(' '),
      words: chunkWords,
    });

    start = end;
  }

  return results;
}

/**
 * Convert segments to standard SRT format string.
 */
export function segmentsToSrt(segments: SubtitleSegment[]): string {
  return segments
    .map((seg, i) => {
      const start = msToSrtTime(seg.startMs);
      const end = msToSrtTime(seg.endMs);
      return `${i + 1}\n${start} --> ${end}\n${seg.text}`;
    })
    .join('\n\n');
}

function msToSrtTime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return (
    String(hours).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0') +
    ',' +
    String(millis).padStart(3, '0')
  );
}

/**
 * Generate a human-readable diff showing only segments that changed.
 */
export function segmentsToDiff(
  original: SubtitleSegment[],
  corrected: SubtitleSegment[]
): string {
  const lines: string[] = [];
  const maxLen = Math.max(original.length, corrected.length);

  for (let i = 0; i < maxLen; i++) {
    const orig = original[i];
    const corr = corrected[i];

    if (!orig && corr) {
      lines.push(`[+${i + 1}] NEW: ${corr.text}`);
      continue;
    }
    if (orig && !corr) {
      lines.push(`[-${i + 1}] REMOVED: ${orig.text}`);
      continue;
    }
    if (orig.text !== corr.text) {
      lines.push(`[#${i + 1}] ${msToSrtTime(orig.startMs)} --> ${msToSrtTime(orig.endMs)}`);
      lines.push(`- ${orig.text}`);
      lines.push(`+ ${corr.text}`);
      lines.push('');
    }
  }

  if (lines.length === 0) {
    return 'No changes detected.';
  }

  const changed = original.filter((o, i) => corrected[i] && o.text !== corrected[i].text).length;
  return `${changed} segment(s) changed out of ${original.length}\n\n${lines.join('\n')}`;
}

/**
 * Remove trailing punctuation (.,;:) from each segment's text.
 * Preserves punctuation mid-sentence (e.g. "hola, ¿qué tal?" stays,
 * but "hola, qué tal." becomes "hola, qué tal").
 * Also strips trailing punctuation from the last word in the words array.
 */
export function stripTrailingPunctuation(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments.map((seg) => {
    const newText = seg.text.replace(/[.,;:]+$/, '').trimEnd();
    if (newText === seg.text) return seg;

    // Also update the last word if words array exists
    let newWords = seg.words;
    if (newWords && newWords.length > 0) {
      const lastIdx = newWords.length - 1;
      const lastWord = newWords[lastIdx];
      const newWordText = lastWord.text.replace(/[.,;:]+$/, '').trimEnd();
      if (newWordText !== lastWord.text) {
        newWords = [...newWords];
        newWords[lastIdx] = { ...lastWord, text: newWordText };
      }
    }

    return { ...seg, text: newText, words: newWords };
  });
}

/**
 * Trigger a file download in the browser.
 */
export function downloadAsFile(
  content: string,
  filename: string,
  mime = 'text/plain'
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function splitByText(
  seg: SubtitleSegment,
  maxChars: number,
  maxDurationMs: number
): SubtitleSegment[] {
  const text = seg.text;
  const totalDuration = seg.endMs - seg.startMs;

  // Determine how many parts we need
  const charParts = Math.ceil(text.length / maxChars);
  const durationParts = Math.ceil(totalDuration / maxDurationMs);
  const numParts = Math.max(charParts, durationParts, 2);

  const results: SubtitleSegment[] = [];
  const wordsArr = text.split(/\s+/);
  const wordsPerPart = Math.ceil(wordsArr.length / numParts);

  for (let i = 0; i < numParts; i++) {
    const partWords = wordsArr.slice(i * wordsPerPart, (i + 1) * wordsPerPart);
    if (partWords.length === 0) continue;

    const partText = partWords.join(' ');
    const ratio = text.length > 0 ? partText.length / text.length : 1 / numParts;
    const partDuration = Math.round(totalDuration * ratio);

    const startMs = i === 0
      ? seg.startMs
      : results[results.length - 1].endMs;
    const endMs = Math.min(startMs + partDuration, seg.endMs);

    results.push({
      id: uuidv4(),
      startMs,
      endMs: i === numParts - 1 ? seg.endMs : endMs,
      text: partText,
    });
  }

  return results;
}
