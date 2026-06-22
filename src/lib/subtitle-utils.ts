import { v4 as uuidv4 } from 'uuid';
import type { SubtitleSegment, SubtitleWord } from '@/types/project';

/** A style change to apply to a whole subtitle segment. `null` clears a field. */
export interface SegmentStyleUpdate {
  color?: string | null;
  fontSize?: number | null;
  bold?: boolean | null;
  /** Per-segment animation override. A string sets it, `null` clears it (back
   *  to the global animation). Word-based animations need words[], which this
   *  helper builds from the text. */
  animation?: SubtitleSegment['animation'] | null;
  /** Clear ALL per-word style on the segment(s) (keeps animation override). */
  reset?: boolean;
}

/**
 * Apply a color/size/bold change to EVERY word of a segment (creating the
 * words[] array from the text if it doesn't exist yet). This is how we style a
 * whole selected subtitle at once — same per-word mechanism the word editor
 * uses and the ASS generator already honours, so it shows in preview + export.
 */
export function styleWholeSegment(seg: SubtitleSegment, update: SegmentStyleUpdate): SubtitleSegment {
  const textWords = seg.text.split(/\s+/).filter(Boolean);
  if (textWords.length === 0) return seg;
  const src = seg.words ?? [];
  const dur = seg.endMs - seg.startMs;
  const per = textWords.length > 0 ? dur / textWords.length : dur;

  const words: SubtitleWord[] = textWords.map((tw, i) => {
    const base: SubtitleWord = i < src.length
      ? { ...src[i], text: tw }
      : { text: tw, startMs: seg.startMs + Math.round(i * per), endMs: seg.startMs + Math.round((i + 1) * per) };

    if (update.reset) return { ...base, style: undefined };

    const style: NonNullable<SubtitleWord['style']> = { ...base.style };
    if (update.color !== undefined) {
      if (update.color === null) delete style.color; else style.color = update.color;
    }
    if (update.fontSize !== undefined) {
      if (update.fontSize === null) delete style.fontSize; else style.fontSize = update.fontSize;
    }
    if (update.bold !== undefined) {
      if (update.bold) style.fontWeight = 700; else delete style.fontWeight;
    }
    const hasKeys = style.color !== undefined || style.fontSize !== undefined || style.fontWeight !== undefined;
    return { ...base, style: hasKeys ? style : undefined };
  });

  // Per-segment animation override (build words above so word-based reveals work).
  let animation = seg.animation;
  if (update.animation !== undefined) {
    animation = update.animation === null ? undefined : update.animation;
  }

  return { ...seg, words, animation };
}

/**
 * Clamp a segment's start/end to the given bounds AND keep its `words` array
 * consistent with the new bounds. Without this, a downstream consumer like
 * `splitByWords` would use stale word timings and produce sub-segments outside
 * the segment's actual time range — resulting in subtitles that "appear at the
 * wrong second" after a regenerate.
 *
 * Words completely outside the new bounds are dropped. Words that straddle a
 * bound are clamped to fit. If clamping produces an inconsistent or empty
 * words list, the words array is dropped so `splitLongSegments` falls back to
 * text-based splitting (which uses the segment's own start/end).
 */
export function clampSegmentToBounds(
  seg: SubtitleSegment,
  minMs: number,
  maxMs: number
): SubtitleSegment {
  const newStart = Math.max(seg.startMs, minMs);
  const newEnd = Math.min(seg.endMs, maxMs);

  if (!seg.words || seg.words.length === 0) {
    return { ...seg, startMs: newStart, endMs: newEnd };
  }

  const clampedWords = seg.words
    .filter((w) => w.endMs > newStart && w.startMs < newEnd)
    .map((w) => ({
      ...w,
      startMs: Math.max(newStart, w.startMs),
      endMs: Math.min(newEnd, w.endMs),
    }))
    .filter((w) => w.endMs > w.startMs);

  // If clamping removed the words, drop the words array — splitByText will be
  // used as fallback and it doesn't depend on per-word timings.
  if (clampedWords.length === 0) {
    return { ...seg, startMs: newStart, endMs: newEnd, words: undefined };
  }

  return { ...seg, startMs: newStart, endMs: newEnd, words: clampedWords };
}

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

/**
 * Spanish words that "glue" to the next word and should never sit at the end
 * of a subtitle block. Splitting "un | partido" or "de | izquierda" reads
 * awkwardly and hurts comprehension in fast-moving reels. The list is
 * deliberately conservative (only the high-frequency cases) so the rule
 * doesn't bend split points so hard that it produces tiny orphan blocks.
 */
const SPANISH_GLUE_WORDS = new Set<string>([
  // articles + contractions
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'del', 'al',
  // prepositions
  'a', 'de', 'en', 'con', 'por', 'para', 'sin', 'hacia', 'hasta',
  'sobre', 'bajo', 'ante', 'entre', 'durante', 'tras', 'según', 'mediante', 'contra',
  // possessives
  'mi', 'tu', 'su', 'mis', 'tus', 'sus',
  'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'vuestro', 'vuestra', 'vuestros', 'vuestras',
  // demonstratives
  'este', 'esta', 'estos', 'estas',
  'ese', 'esa', 'esos', 'esas',
  'aquel', 'aquella', 'aquellos', 'aquellas',
  // quantifiers / determiners
  'todo', 'toda', 'todos', 'todas',
  'mucho', 'mucha', 'muchos', 'muchas',
  'poco', 'poca', 'pocos', 'pocas',
  'cada', 'otro', 'otra', 'otros', 'otras',
  'algún', 'alguna', 'algunos', 'algunas',
  'ningún', 'ninguna', 'mismo', 'misma',
  // relatives / interrogatives that head a phrase
  'que', 'qué', 'cual', 'cuál', 'cuyo', 'cuya',
  // negation that always glues to the next verb
  'no',
  // common auxiliary verbs (they attach to the participle/infinitive after)
  'he', 'has', 'ha', 'hemos', 'habéis', 'han',
  'voy', 'vas', 'va', 'vamos', 'vais', 'van',
  'estoy', 'estás', 'está', 'estamos', 'estáis', 'están',
  'soy', 'eres', 'es', 'somos', 'sois', 'son',
  // common conjunctions that introduce a clause AFTER them
  'y', 'o', 'u', 'e', 'ni',
]);

/**
 * Normalise a token for the glue-word lookup: lowercase, strip surrounding
 * punctuation. We keep accents and ñ — Spanish glue words depend on them
 * ("según", "más", "qué" — though only the first is in the glue set).
 */
function normaliseWord(raw: string): string {
  return raw.toLowerCase().replace(/^[^\wáéíóúüñ]+|[^\wáéíóúüñ]+$/gi, '');
}

function isGlueWord(raw: string): boolean {
  return SPANISH_GLUE_WORDS.has(normaliseWord(raw));
}

function splitByWords(
  seg: SubtitleSegment,
  maxChars: number,
  maxDurationMs: number
): SubtitleSegment[] {
  const words = seg.words!;
  const results: SubtitleSegment[] = [];
  let start = 0;

  // Defensive: if word timings are inconsistent with segment bounds (e.g. after a
  // timeline remap that didn't update the words array), fall back to text splitting.
  // Otherwise we'd produce sub-segments with timestamps outside the segment's range.
  const wordsAreWithinBounds = words.every(
    (w) => w.startMs >= seg.startMs - 1 && w.endMs <= seg.endMs + 1
  );
  if (!wordsAreWithinBounds) {
    return splitByText(seg, maxChars, maxDurationMs);
  }

  // How much over the char budget we're willing to go to avoid breaking a
  // noun phrase. 25% is the sweet spot: enough to absorb "un partido nuevo"
  // patterns, small enough that the resulting block still reads cleanly.
  const overflowBudget = Math.max(8, Math.round(maxChars * 0.25));

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

    // Lexical-cohesion pass: if the last word in this chunk "glues" to the
    // next word (article, preposition, auxiliary, etc.), extend the chunk
    // forward as long as the head keeps being glue and we stay within the
    // overflow budget + the duration limit. Without this we get awkward
    // breaks like "un | partido nuevo" or "estoy | haciendo" that hurt
    // reading on fast-scrolling vertical reels.
    while (
      end < words.length &&
      end - start > 0 &&
      isGlueWord(words[end - 1].text)
    ) {
      const tentativeText = words.slice(start, end + 1).map((w) => w.text).join(' ');
      const tentativeDur = words[end].endMs - words[start].startMs;
      if (
        tentativeText.length > maxChars + overflowBudget ||
        tentativeDur > maxDurationMs
      ) break;
      end++;
    }

    const chunkWords = words.slice(start, end);
    // Clamp the chunk's reported start/end to the segment bounds. This is a safety
    // net even when wordsAreWithinBounds passed — protects against off-by-one cases.
    const chunkStart = Math.max(seg.startMs, chunkWords[0].startMs);
    const chunkEnd = Math.min(seg.endMs, chunkWords[chunkWords.length - 1].endMs);
    results.push({
      id: uuidv4(),
      startMs: chunkStart,
      endMs: chunkEnd,
      text: chunkWords.map((w) => w.text).join(' '),
      words: chunkWords,
    });

    start = end;
  }

  // Tail-merge pass: if the final chunk is just an orphan word or two (very
  // short) AND merging it into the previous chunk stays within ~1.5× the
  // budget, do it. This stops cases like "…la tienda" + "nueva" — the
  // trailing adjective is much more readable attached than dangling.
  if (results.length >= 2) {
    const last = results[results.length - 1];
    const prev = results[results.length - 2];
    const shortThreshold = Math.max(6, Math.round(maxChars * 0.33));
    const mergedText = `${prev.text} ${last.text}`;
    const mergedDur = last.endMs - prev.startMs;
    if (
      last.text.length <= shortThreshold &&
      mergedText.length <= Math.round(maxChars * 1.5) &&
      mergedDur <= maxDurationMs
    ) {
      results.pop();
      results.pop();
      const mergedWords = [...(prev.words ?? []), ...(last.words ?? [])];
      results.push({
        id: uuidv4(),
        startMs: prev.startMs,
        endMs: last.endMs,
        text: mergedText,
        words: mergedWords.length > 0 ? mergedWords : undefined,
      });
    }
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

  const wordsArr = text.split(/\s+/);
  const wordsPerPart = Math.ceil(wordsArr.length / numParts);

  // First, pick cut indices (start word of each part). Then nudge each cut
  // forward if the preceding word is a "glue" word (article, preposition,
  // auxiliary, …) so noun phrases aren't sheared across blocks. Mirrors the
  // overflow-tolerant behaviour in splitByWords.
  const cuts: number[] = [0];
  for (let i = 1; i < numParts; i++) {
    let cut = i * wordsPerPart;
    if (cut >= wordsArr.length) break;
    // Don't shift more than overflow budget worth of words to avoid creating
    // a tiny final block.
    const maxShift = Math.max(1, Math.round(maxChars * 0.25 / 4));
    let shifts = 0;
    while (
      cut > cuts[cuts.length - 1] + 1 &&
      cut < wordsArr.length &&
      shifts < maxShift &&
      isGlueWord(wordsArr[cut - 1])
    ) {
      cut++;
      shifts++;
    }
    if (cut > cuts[cuts.length - 1]) cuts.push(cut);
  }
  cuts.push(wordsArr.length);

  const results: SubtitleSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const partWords = wordsArr.slice(cuts[i], cuts[i + 1]);
    if (partWords.length === 0) continue;

    const partText = partWords.join(' ');
    const ratio = text.length > 0 ? partText.length / text.length : 1 / (cuts.length - 1);
    const partDuration = Math.round(totalDuration * ratio);

    const startMs = i === 0
      ? seg.startMs
      : results[results.length - 1].endMs;
    const endMs = Math.min(startMs + partDuration, seg.endMs);

    results.push({
      id: uuidv4(),
      startMs,
      endMs: i === cuts.length - 2 ? seg.endMs : endMs,
      text: partText,
    });
  }

  return results;
}
