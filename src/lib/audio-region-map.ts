import type { BoardDuckRegion, CompositionClip, ProjectPart, ProjectState } from '@/types/project';
import { absoluteAmbientBands } from '@/lib/ambient-bands';
import { partTrims } from '@/lib/part-trims';
import { partNeedsRemix } from '@/lib/part-chain-description';

/**
 * Mapping between the AUDIO REGIONS the user edits (mesa attenuations =
 * `part.boardDuckRegions`, ambient raises = `part.ambientBoostRegions`) and the
 * COMPOSE / REEL timelines, so those edits can be shown, deleted and created
 * straight on the editing timeline instead of only inside Sync & Mix.
 *
 * Four clocks are involved, in this order:
 *
 *   wav clock       the region's own times — the mesa wav for a board region,
 *                   the camera wav for an ambient one
 *     −trim         alignment: board wav leads by max(0, offset), camera wav by
 *                   max(0, −offset)
 *   mix clock       the part's mixed audio
 *     −muxedTrim    the keyframe-snap residual the mux trims off the head
 *   part-local      time inside the part's muxed video
 *     +concatStart  parts laid back-to-back in `order`
 *   concat clock    = the muxed file = `sourceInMs` of every compose/reel clip
 *     via clips     cuts remove material and reorder it
 *   timeline clock  what the editor draws
 *
 * A region can land on several timeline spans (a cut splits it) or on none at
 * all (the user cut that stretch out) — hence spans, not a single range.
 */

/** board = mesa attenuation/boost, ambient = manual ambient raise/cut, noRaise = block the
 *  AUTOMATIC ambient raise, autoRaise = one of the engine's own raises (read-only, vetoable),
 *  keepOpen = block an automatic MESA GATE closure, autoGate = one of the gate's own closures
 *  (read-only, vetoable). The two pairs are mirror images: raise/veto on the ambient track,
 *  closure/veto on the mesa track. */
export type RegionKind = 'board' | 'ambient' | 'noRaise' | 'autoRaise' | 'keepOpen' | 'autoGate';

export interface PartWindow {
  part: ProjectPart;
  /** Start of this part in the concat (muxed) timeline. */
  concatStartMs: number;
  durationMs: number;
  /** wav → mix offsets. */
  boardTrimMs: number;
  ambientTrimMs: number;
  /** mix → part-local muxed offset. */
  muxedTrimMs: number;
}

/** Ordered parts that made it into the concat, with every clock offset resolved. */
export function partWindows(project: Pick<ProjectState, 'parts'>): PartWindow[] {
  const parts = [...(project.parts ?? [])]
    .filter((p) => p.muxedDurationMs != null && p.alignmentOffsetMs !== undefined)
    .sort((a, b) => a.order - b.order);
  const out: PartWindow[] = [];
  let acc = 0;
  for (const part of parts) {
    const trims = partTrims(part);
    out.push({
      part,
      concatStartMs: acc,
      durationMs: part.muxedDurationMs ?? 0,
      boardTrimMs: trims.boardTrimMs,
      ambientTrimMs: trims.ambientTrimMs,
      muxedTrimMs: part.muxedAudioTrimMs ?? 0,
    });
    acc += part.muxedDurationMs ?? 0;
  }
  return out;
}

/** Which wav a kind's times are stored against — get this wrong and every band
 *  of that kind is drawn (and saved) off by the whole alignment offset. */
const BOARD_KINDS = new Set<RegionKind>(['board', 'keepOpen', 'autoGate']);
const trimOf = (w: PartWindow, kind: RegionKind) => (BOARD_KINDS.has(kind) ? w.boardTrimMs : w.ambientTrimMs);

/** Region time (its own wav clock) → concat/muxed time. */
export function wavMsToConcatMs(w: PartWindow, kind: RegionKind, wavMs: number): number {
  return w.concatStartMs + (wavMs - trimOf(w, kind) - w.muxedTrimMs);
}

/** Concat/muxed time → region time on the wav the region is stored against. */
export function concatMsToWavMs(w: PartWindow, kind: RegionKind, concatMs: number): number {
  return concatMs - w.concatStartMs + trimOf(w, kind) + w.muxedTrimMs;
}

export function partWindowAtConcatMs(wins: PartWindow[], concatMs: number): PartWindow | null {
  for (const w of wins) {
    if (concatMs >= w.concatStartMs && concatMs < w.concatStartMs + w.durationMs) return w;
  }
  return null;
}

/**
 * Source (concat/muxed) range → the timeline spans that actually show it.
 * `clips` must already be filtered to the editor's main VIDEO track (v1 in
 * Compose, rv1 in a reel) and carries the cuts.
 */
export function sourceRangeToTimelineSpans(
  clips: CompositionClip[],
  srcStartMs: number,
  srcEndMs: number,
): Array<{ startMs: number; endMs: number; srcStartMs: number }> {
  const out: Array<{ startMs: number; endMs: number; srcStartMs: number }> = [];
  if (srcEndMs <= srcStartMs) return out;
  for (const c of clips) {
    const a = Math.max(srcStartMs, c.sourceInMs);
    const b = Math.min(srcEndMs, c.sourceOutMs);
    if (b <= a) continue;
    const t0 = c.timelineStartMs + (a - c.sourceInMs);
    // srcStartMs: the source time at the span's left edge, so anything drawn
    // INSIDE the span is placed by this clip's own mapping.
    out.push({ startMs: t0, endMs: t0 + (b - a), srcStartMs: a });
  }
  return out.sort((x, y) => x.startMs - y.startMs);
}

/** Source (concat/muxed) time → timeline time on the first clip showing it, or null if cut out. */
export function sourceMsToTimelineMs(clips: CompositionClip[], srcMs: number): number | null {
  for (const c of clips) {
    if (srcMs >= c.sourceInMs && srcMs < c.sourceOutMs) return c.timelineStartMs + (srcMs - c.sourceInMs);
  }
  return null;
}

/** Timeline time → source (concat/muxed) time, or null in a gap. */
export function timelineMsToSourceMs(clips: CompositionClip[], timelineMs: number): number | null {
  for (const c of clips) {
    if (timelineMs >= c.timelineStartMs && timelineMs < c.timelineEndMs) {
      return c.sourceInMs + (timelineMs - c.timelineStartMs);
    }
  }
  return null;
}

export interface PlacedRegion {
  region: BoardDuckRegion;
  kind: RegionKind;
  partId: string;
  partName: string;
  /** Where it lands on the editor timeline (possibly split by cuts). */
  spans: Array<{ startMs: number; endMs: number }>;
  /** dB applied: negative attenuates the mesa, positive raises the ambient. */
  db: number;
}

/**
 * Every enabled region of every part, placed on the editor timeline.
 * `videoClips` = the editor's main video track clips (they carry the cuts).
 */
export function placeRegions(
  wins: PartWindow[],
  videoClips: CompositionClip[],
  opts?: { includeDisabled?: boolean },
): PlacedRegion[] {
  const out: PlacedRegion[] = [];
  for (const w of wins) {
    const pairs: Array<[RegionKind, BoardDuckRegion[]]> = [
      ['board', w.part.boardDuckRegions ?? []],
      ['ambient', absoluteAmbientBands(w.part)],
      // A veto OWNED by a manual zone (the zone took over that automatic raise)
      // is never drawn: the zone is the visible thing, and deleting the zone
      // deletes the veto with it.
      ['noRaise', (w.part.ambientNoRaiseRegions ?? []).filter((r) => !r.ownerId)],
      ['keepOpen', w.part.boardKeepOpenRegions ?? []],
    ];
    for (const [kind, regions] of pairs) {
      for (const r of regions) {
        if (!r.enabled && !opts?.includeDisabled) continue;
        const a = wavMsToConcatMs(w, kind, Math.min(r.startMs, r.endMs));
        const b = wavMsToConcatMs(w, kind, Math.max(r.startMs, r.endMs));
        const spans = sourceRangeToTimelineSpans(videoClips, a, b);
        if (spans.length === 0) continue;
        out.push({
          region: r,
          kind,
          partId: w.part.id,
          partName: w.part.name,
          spans,
          db: r.attenuationDb ?? 0,
        });
      }
    }
    // The engine's own raises (as persisted by its last run), minus the ones
    // the user already vetoed — a "no raise" zone covering at least half of a
    // raise speaks for it.
    if (w.part.ambientDuckOnVoice) {
      const vetoes = (w.part.ambientNoRaiseRegions ?? []).filter((r) => r.enabled);
      // While the part still awaits a re-mix its persisted raises predate the
      // vetoes: the engine used to leave 100–500 ms slivers of a taken-over
      // raise beside the veto (they came back as their own "+4 dB auto" boxes
      // next to the zone that replaced it). Hide those until the next mix
      // rewrites the list — once mixed, whatever is persisted is what sounds.
      const stale = partNeedsRemix(w.part);
      (w.part.ambientAutoRaises ?? []).forEach((ar, i) => {
        const a0 = Math.min(ar.startMs, ar.endMs), a1 = Math.max(ar.startMs, ar.endMs);
        if (a1 - a0 < 50) return;
        let covered = 0, nearBoxVeto = false;
        for (const v of vetoes) {
          const vs = Math.min(v.startMs, v.endMs), ve = Math.max(v.startMs, v.endMs);
          covered += Math.max(0, Math.min(a1, ve) - Math.max(a0, vs));
          if ((v.retiresAuto || v.ownerId) && vs - a1 <= 150 && a0 - ve <= 150) nearBoxVeto = true;
        }
        if (covered >= (a1 - a0) / 2) return;
        if (stale && nearBoxVeto && a1 - a0 <= 600) return;
        const spans = sourceRangeToTimelineSpans(videoClips, wavMsToConcatMs(w, 'autoRaise', a0), wavMsToConcatMs(w, 'autoRaise', a1));
        if (spans.length === 0) return;
        out.push({
          region: { id: `auto:${w.part.id}:${i}`, startMs: a0, endMs: a1, attenuationDb: ar.db, source: 'manual', enabled: true },
          kind: 'autoRaise',
          partId: w.part.id,
          partName: w.part.name,
          spans,
          db: ar.db,
        });
      });
    }
    // The mesa GATE's own closures, same rule: what the engine decided on its
    // last run, minus what the user already vetoed with a keep-open zone.
    if (w.part.boardSpeechLevel && w.part.boardGate) {
      const vetoes = (w.part.boardKeepOpenRegions ?? []).filter((r) => r.enabled);
      (w.part.boardAutoGates ?? []).forEach((g, i) => {
        const a0 = Math.min(g.startMs, g.endMs), a1 = Math.max(g.startMs, g.endMs);
        if (a1 - a0 < 50) return;
        let covered = 0;
        for (const v of vetoes) {
          covered += Math.max(0, Math.min(a1, Math.max(v.startMs, v.endMs)) - Math.max(a0, Math.min(v.startMs, v.endMs)));
        }
        if (covered >= (a1 - a0) / 2) return;
        const spans = sourceRangeToTimelineSpans(videoClips, wavMsToConcatMs(w, 'autoGate', a0), wavMsToConcatMs(w, 'autoGate', a1));
        if (spans.length === 0) return;
        out.push({
          region: { id: `gate:${w.part.id}:${i}`, startMs: a0, endMs: a1, attenuationDb: g.db, source: 'manual', enabled: true },
          kind: 'autoGate',
          partId: w.part.id,
          partName: w.part.name,
          spans,
          db: g.db,
        });
      });
    }
  }
  return out.sort((x, y) => x.spans[0].startMs - y.spans[0].startMs);
}
