import { v4 as uuidv4 } from 'uuid';
import type { SubtitleConstraints, SubtitleSegment, SubtitleWord } from '@/types/project';

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

/**
 * Rebuild subtitles for a TIMELINE gap from the ORIGINAL transcription.
 *
 * `original` segments are in SOURCE (muxed-file) time — the raw Whisper/Groq
 * output. `videoClips` are the editor's main video clips (compose v1 or reel
 * rv1), whose sourceInMs also references the muxed file, so each clip gives a
 * linear source→timeline mapping: timeline = clip.timelineStartMs + (source -
 * clip.sourceInMs). For every clip stretch overlapping [gapStartMs, gapEndMs]
 * we pull the original segments in the matching SOURCE window, shift them onto
 * the timeline (words included), clamp to the gap, and re-split to the
 * constraints. Deleted subtitles are thus recoverable even after cuts moved
 * the timeline around — used by the "fill subtitle gap" toolbar action in BOTH
 * composition editors.
 */
export function fillGapFromOriginal(
  original: SubtitleSegment[],
  videoClips: Array<{ timelineStartMs: number; timelineEndMs: number; sourceInMs: number }>,
  gapStartMs: number,
  gapEndMs: number,
  constraints: SubtitleConstraints,
): SubtitleSegment[] {
  if (gapEndMs - gapStartMs < 100 || original.length === 0) return [];

  const clips = [...videoClips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  // No clips (e.g. subtitles-only project): identity mapping over the gap.
  const effective = clips.length > 0
    ? clips
    : [{ timelineStartMs: gapStartMs, timelineEndMs: gapEndMs, sourceInMs: gapStartMs }];

  const out: SubtitleSegment[] = [];
  for (const clip of effective) {
    const oS = Math.max(clip.timelineStartMs, gapStartMs);
    const oE = Math.min(clip.timelineEndMs, gapEndMs);
    if (oE - oS < 100) continue;
    const off = clip.timelineStartMs - clip.sourceInMs; // source → timeline shift
    const sS = oS - off;
    const sE = oE - off;
    for (const seg of original) {
      if (seg.endMs <= sS || seg.startMs >= sE) continue;
      const shifted: SubtitleSegment = {
        ...seg,
        id: uuidv4(),
        startMs: seg.startMs + off,
        endMs: seg.endMs + off,
        words: seg.words?.map((w) => ({ ...w, startMs: w.startMs + off, endMs: w.endMs + off })),
      };
      const clamped = clampSegmentToBounds(shifted, oS, oE);
      if (clamped.endMs - clamped.startMs > 100 && clamped.text.trim()) out.push(clamped);
    }
  }

  out.sort((a, b) => a.startMs - b.startMs);
  const split = splitSegmentsWithConstraints(out, constraints);
  split.sort((a, b) => a.startMs - b.startMs);
  return split;
}

/* ── Phrase-aligned chopping for reels ──────────────────────────────────── */

export const REEL_DEFAULT_MAX_WORDS = 3;

/** Extra words that glue to what FOLLOWS (beyond SPANISH_GLUE_WORDS): degree
 *  adverbs, subordinators and the clitic pronouns that sit before a verb. A
 *  token that carries closing punctuation ("más,") is never glue — the
 *  punctuation says the phrase ends there. */
const EXTRA_GLUE_WORDS = new Set<string>([
  'muy', 'más', 'menos', 'tan', 'casi', 'como', 'cuando', 'donde', 'porque', 'pero', 'aunque', 'si', 'sino',
  'se', 'me', 'te', 'le', 'nos', 'os', 'les',
]);

interface Tok { text: string; startMs: number; endMs: number; word?: SubtitleWord }

const CLOSING_PUNCT = /[.?!…]["»)\]]*$/;
const WEAK_PUNCT = /[,;:]["»)\]]*$/;
const OPENING_PUNCT = /^[¿¡"«(\[—-]/;

function tokenIsGlue(t: Tok): boolean {
  if (CLOSING_PUNCT.test(t.text) || WEAK_PUNCT.test(t.text)) return false;
  const w = normaliseWord(t.text);
  return SPANISH_GLUE_WORDS.has(w) || EXTRA_GLUE_WORDS.has(w);
}

const isCapitalized = (t: Tok) => /^[¿¡"«(]*[A-ZÁÉÍÓÚÑ]/.test(t.text);

/** No break between `a` and the token after it: a glue word, or two
 *  capitalised words in a row (a name — "Diego Dueño", "El Golfo"). */
function gluedTo(a: Tok, next: Tok | undefined): boolean {
  if (!next) return false;
  if (tokenIsGlue(a)) return true;
  return isCapitalized(a) && isCapitalized(next) && !CLOSING_PUNCT.test(a.text) && !WEAK_PUNCT.test(a.text);
}

type Boundary = 'strong' | 'weak' | 'none';

/** What separates token i from token i+1: end of sentence / long pause,
 *  comma-level break / short pause, or nothing. */
function boundaryAfter(toks: Tok[], i: number): Boundary {
  const t = toks[i], nx = toks[i + 1];
  if (!nx) return 'strong';
  const gap = nx.startMs - t.endMs;
  if (CLOSING_PUNCT.test(t.text) || gap >= 700) return 'strong';
  if (WEAK_PUNCT.test(t.text) || gap >= 300 || OPENING_PUNCT.test(nx.text)) return 'weak';
  return 'none';
}

/** Word tokens of a segment: its timed words when they are consistent with
 *  the segment, else the text split on spaces with times spread by character
 *  count. Pure-punctuation tokens are merged into their neighbour. */
function tokensOf(seg: SubtitleSegment): { toks: Tok[]; timed: boolean } {
  const raw: Tok[] = [];
  const words = seg.words ?? [];
  const consistent = words.length > 0 && words.every((w) => w.startMs >= seg.startMs - 1 && w.endMs <= seg.endMs + 1 && w.endMs >= w.startMs);
  if (consistent) {
    for (const w of words) { const text = w.text.trim(); if (text) raw.push({ text, startMs: w.startMs, endMs: w.endMs, word: w }); }
  } else {
    const parts = seg.text.split(/\s+/).filter(Boolean);
    const total = parts.reduce((a, t) => a + t.length + 1, 0) || 1;
    const dur = Math.max(1, seg.endMs - seg.startMs);
    let acc = 0;
    for (const text of parts) {
      const a = seg.startMs + (acc / total) * dur;
      acc += text.length + 1;
      const b = seg.startMs + (acc / total) * dur;
      raw.push({ text, startMs: Math.round(a), endMs: Math.round(b) });
    }
  }
  // Merge tokens without letters/digits ("-", "…") into the previous one.
  const toks: Tok[] = [];
  for (const t of raw) {
    if (!/[A-Za-z0-9\u00C0-\u024F]/.test(t.text) && toks.length > 0) {
      const prev = toks[toks.length - 1];
      prev.text = `${prev.text}${t.text}`;
      prev.endMs = Math.max(prev.endMs, t.endMs);
      if (prev.word) prev.word = { ...prev.word, text: prev.text, endMs: prev.endMs };
    } else {
      toks.push({ ...t });
    }
  }
  return { toks, timed: consistent };
}

const joinToks = (toks: Tok[], a: number, b: number) => toks.slice(a, b).map((t) => t.text).join(' ');

/**
 * Best chunking of one sentence into blocks of 1..maxWords words: dynamic
 * programming over the break positions. Costs: breaking right after a glue
 * word +40 (only when nothing else fits), breaking at a comma / pause −6,
 * fuller blocks preferred (+2 per missing word), a lone word mid-sentence
 * that is not at a pause +6. Hard limits: a block of ≥2 words never exceeds
 * maxChars (one line) nor maxDurationMs.
 */
function chunkSentence(toks: Tok[], maxWords: number, maxChars: number, maxDurationMs: number): Array<[number, number]> {
  const n = toks.length;
  if (n === 0) return [];
  const INF = 1e9;
  const best = new Array<number>(n + 1).fill(INF);
  const prev = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  // One word over the limit is allowed at a price (+14): cheaper than
  // breaking a verbal unit like "Te lo ha dicho" (+40), dearer than an
  // orphan word — it only happens when the alternative reads worse.
  const kMax = maxWords >= 2 ? maxWords + 1 : 1;
  for (let e = 1; e <= n; e++) {
    for (let k = 1; k <= kMax && e - k >= 0; k++) {
      const st = e - k;
      if (best[st] >= INF) continue;
      if (k > 1) {
        if (joinToks(toks, st, e).length > maxChars) continue;
        if (toks[e - 1].endMs - toks[st].startMs > maxDurationMs) continue;
      }
      let cost = best[st] + Math.max(0, maxWords - k) * 2 + (k > maxWords ? 14 : 0);
      if (e < n) {
        const b = boundaryAfter(toks, e - 1);
        if (b === 'weak') cost -= 6;
        else if (gluedTo(toks[e - 1], toks[e])) cost += 40;
        if (k === 1 && b === 'none') cost += 6;
      }
      if (cost < best[e]) { best[e] = cost; prev[e] = st; }
    }
  }
  const out: Array<[number, number]> = [];
  let e = n;
  while (e > 0) { const st = prev[e]; if (st < 0) break; out.unshift([st, e]); e = st; }
  return out;
}

/** The punchline unit of a sentence: its last word plus the glue words stuck
 *  to it ("de mierda", "en la cara"), never longer than maxWords. */
function punchUnitStart(toks: Tok[], maxWords: number): number {
  let u = toks.length - 1;
  while (u > 0 && gluedTo(toks[u - 1], toks[u]) && toks.length - (u - 1) <= maxWords) u--;
  return u;
}

function chopOne(seg: SubtitleSegment, maxWords: number, maxChars: number, maxDurationMs: number, punch: boolean): SubtitleSegment[] {
  const { toks, timed } = tokensOf(seg);
  if (toks.length === 0) return [seg];
  // Sentences first (end punctuation / long pause), then blocks inside each.
  const ranges: Array<[number, number]> = [];
  let s0 = 0;
  for (let i = 0; i < toks.length; i++) {
    if (i === toks.length - 1 || boundaryAfter(toks, i) === 'strong') {
      const sent = toks.slice(s0, i + 1);
      let head = sent, tail: Tok[] = [];
      if (punch && sent.length >= 4) {
        const u = punchUnitStart(sent, maxWords);
        if (u >= 2 && sent.length - u <= maxWords) { head = sent.slice(0, u); tail = sent.slice(u); }
      }
      for (const [a, b] of chunkSentence(head, maxWords, maxChars, maxDurationMs)) ranges.push([s0 + a, s0 + b]);
      if (tail.length > 0) ranges.push([s0 + head.length, s0 + sent.length]);
      s0 = i + 1;
    }
  }
  const out: SubtitleSegment[] = ranges.map(([a, b]) => {
    const chunk = toks.slice(a, b);
    const words = timed ? chunk.map((t) => t.word!).filter(Boolean) : undefined;
    return {
      id: uuidv4(),
      startMs: Math.max(seg.startMs, chunk[0].startMs),
      endMs: Math.min(seg.endMs, chunk[chunk.length - 1].endMs),
      text: chunk.map((t) => t.text).join(' '),
      ...(words && words.length > 0 ? { words } : {}),
    };
  });
  // Hold each block on screen until the next one starts (no flicker inside a
  // phrase); a real pause (≥ 500 ms) or the duration cap ends it.
  for (let i = 0; i + 1 < out.length; i++) {
    const gap = out[i + 1].startMs - out[i].endMs;
    if (gap > 0 && gap < 500) out[i].endMs = Math.min(out[i + 1].startMs, out[i].startMs + maxDurationMs);
  }
  return out;
}

const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Does a segment already respect the constraints (so a re-split leaves it alone)? */
export function segmentViolates(seg: SubtitleSegment, c: SubtitleConstraints): boolean {
  if (seg.text.length > c.maxCharsPerBlock || (seg.endMs - seg.startMs) > c.maxDurationMs) return true;
  const mode = c.splitMode ?? 'clasico';
  return mode !== 'clasico' && countWords(seg.text) > (c.maxWordsPerBlock ?? REEL_DEFAULT_MAX_WORDS);
}

/**
 * Split segments the way the constraints say: 'clasico' = splitLongSegments
 * (by characters, the long-form behaviour); 'picado' / 'remate' = phrase-
 * aligned blocks of at most `maxWordsPerBlock` words (see chunkSentence),
 * 'remate' also isolating the last unit of each sentence. Segments already
 * within the limits are returned untouched, so user edits survive a re-split.
 */
export function splitSegmentsWithConstraints(segments: SubtitleSegment[], c: SubtitleConstraints): SubtitleSegment[] {
  const mode = c.splitMode ?? 'clasico';
  if (mode === 'clasico') return splitLongSegments(segments, c.maxCharsPerBlock, c.maxDurationMs);
  const maxWords = Math.max(1, Math.min(8, c.maxWordsPerBlock ?? REEL_DEFAULT_MAX_WORDS));
  const out: SubtitleSegment[] = [];
  for (const seg of segments) {
    if (!segmentViolates(seg, c)) { out.push(seg); continue; }
    out.push(...chopOne(seg, maxWords, c.maxCharsPerBlock, c.maxDurationMs, mode === 'remate'));
  }
  return out;
}
