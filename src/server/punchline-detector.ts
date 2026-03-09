import { v4 as uuidv4 } from 'uuid';
import type { LaughterSegment, SubtitleSegment, PunchlineHint } from '@/types/project';

/**
 * Detect punchlines by correlating laughter segments with subtitle segments.
 *
 * Algorithm: For each laughter segment, find the subtitle segment whose endMs
 * falls within a 2s window before the laughter startMs. That subtitle is likely
 * the joke delivery (punchline). Confidence is derived from normalized peak energy.
 */
export function detectPunchlines(
  laughterSegments: LaughterSegment[],
  subtitleSegments: SubtitleSegment[]
): PunchlineHint[] {
  if (laughterSegments.length === 0 || subtitleSegments.length === 0) {
    return [];
  }

  const WINDOW_MS = 2000; // Look back up to 2s before laughter start

  // Find max peak energy for normalization
  const maxPeak = Math.max(...laughterSegments.map((l) => l.peakEnergy), 1);

  const hints: PunchlineHint[] = [];

  for (const laugh of laughterSegments) {
    const windowStart = laugh.startMs - WINDOW_MS;
    const windowEnd = laugh.startMs;

    // Find subtitle segments whose endMs falls within [windowStart, windowEnd]
    // Pick the one closest to the laughter start (most recent delivery)
    let bestSeg: SubtitleSegment | null = null;
    let bestDist = Infinity;

    for (const seg of subtitleSegments) {
      if (seg.endMs >= windowStart && seg.endMs <= windowEnd) {
        const dist = windowEnd - seg.endMs;
        if (dist < bestDist) {
          bestDist = dist;
          bestSeg = seg;
        }
      }
    }

    if (bestSeg) {
      // Avoid duplicates: don't add if we already have a hint for this subtitle segment
      const alreadyFound = hints.some(
        (h) => h.timestampMs === bestSeg!.endMs && h.suggestedLabel === bestSeg!.text.slice(0, 50)
      );
      if (!alreadyFound) {
        hints.push({
          id: uuidv4(),
          timestampMs: bestSeg.endMs,
          laughterSegmentId: laugh.id,
          confidence: Math.min(1, laugh.peakEnergy / maxPeak),
          suggestedLabel: bestSeg.text.slice(0, 50),
        });
      }
    }
  }

  // Sort by timestamp
  hints.sort((a, b) => a.timestampMs - b.timestampMs);

  return hints;
}
