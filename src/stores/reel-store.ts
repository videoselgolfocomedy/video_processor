'use client';

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { STYLE_PRESETS, REEL_DEFAULT_CONSTRAINTS } from '@/config/subtitle-styles';
import { splitSegmentsWithConstraints, clampSegmentToBounds, styleWholeSegment, fillGapFromOriginal, stripTrailingPunctuation, type SegmentStyleUpdate } from '@/lib/subtitle-utils';
import { cropAtTime, upsertCropKeyframe, clampCropToFrame } from '@/lib/crop-keyframes';
import { mapComposeRangeToSource } from '@/lib/reel-source-mapping';
import { STEM_TRACK_IDS, buildStemClipsForWindow, ensureStemTracks, hasStemTracks, stemKindOfTrack, type StemSegment } from '@/lib/audio-stems';
import { resolvePasteTrackId } from '@/lib/track-compat';
/** A split never leaves a piece shorter than this. The playhead moves in
 *  fractional frame steps (75666.666…), so splitting twice at "the same"
 *  point produced a 1.5e-11 ms clip that FFmpeg rejects at export
 *  ("Invalid duration specification for t: 1.45e-14"). */
const MIN_SPLIT_PIECE_MS = 10;
import type {
  ComposeVersion,
  ReelDefinition,
  ReelVersion,
  CompositionClip,
  CompositionTrack,

  SubtitleSegment,
  SubtitleStyle,
  SubtitleConstraints,
  CropRegion,
  CropKeyframe,
} from '@/types/project';

const defaultReelTracks: CompositionTrack[] = [
  { id: 'rv1', type: 'video', label: 'Main Video', locked: true, muted: false, visible: true },
  { id: 'rv2', type: 'video', label: 'Cutaways', locked: false, muted: false, visible: true },
  { id: 'ra1', type: 'audio', label: 'Main Audio', locked: true, muted: false, visible: true },
  { id: 'ra2', type: 'audio', label: 'Extra Audio', locked: false, muted: false, visible: true },
  { id: 'rs1', type: 'subtitle', label: 'Subtitles', locked: false, muted: false, visible: true },
];

// Module-level clipboards for copy/paste of reel clips AND subtitles. Both
// survive store resets and persist ACROSS reels (module scope), so you can
// copy in one reel and paste in another. Not serialized.
let reelClipboard: { trackId: string; offsetMs: number; clip: CompositionClip }[] = [];
let reelSubtitleClipboard: { offsetMs: number; seg: SubtitleSegment }[] = [];
// Subtitles that lived inside the span of the last CLIP copy (clamped to it).
// Used by rippleInsertAtPlayhead so an inserted piece brings its subs along —
// plain paste ignores this, so its behavior is unchanged.
let reelAttachedSubs: { offsetMs: number; seg: SubtitleSegment }[] = [];

const defaultReelStyle = STYLE_PRESETS.find((p) => p.id === 'reel-punchline')!.style;

/**
 * Effective playable duration of a reel = max(clip.timelineEndMs, subtitle.endMs).
 *
 * `reel.endMs - reel.startMs` is the SOURCE WINDOW the reel sliced from the
 * muxed video (used for the trim bar). After internal edits the user may have
 * removed content from the end, so the playable timeline can be shorter than
 * the source window. The controls' timecode display and the video-player end
 * boundary should reflect the edited length, not the original slice.
 */
export function getReelEffectiveDurationMs(reel: ReelDefinition | undefined): number {
  if (!reel) return 0;
  const sourceWindow = reel.endMs - reel.startMs;
  let maxEnd = 0;
  for (const c of reel.composition?.clips ?? []) {
    if (c.timelineEndMs > maxEnd) maxEnd = c.timelineEndMs;
  }
  for (const s of reel.subtitleSegments ?? []) {
    if (s.endMs > maxEnd) maxEnd = s.endMs;
  }
  // If the reel hasn't been edited (no clips populated yet), fall back to the
  // source-window length so a fresh reel still reports its full size.
  return maxEnd > 0 ? maxEnd : sourceWindow;
}

interface UndoEntry {
  reel: ReelDefinition;
  selectedClipIds: string[];
  selectedSubtitleIds: string[];
}

const MAX_UNDO = 50;

interface ReelStore {
  reels: ReelDefinition[];
  activeReelId: string | null;
  currentTimeMs: number;
  isPlaying: boolean;
  sourceResolution: { width: number; height: number } | null;
  baseDurationMs: number;
  baseSegments: SubtitleSegment[];
  /** The compose NAMED versions (project.composition.versions), kept live by
   * the /reels page: a reel born from a version's bits takes its subtitles
   * from here instead of `baseSegments` (see segmentsForReel). */
  composeVersions: ComposeVersion[];
  setComposeVersions: (versions: ComposeVersion[]) => void;
  dirty: boolean;
  selectedClipIds: string[];

  /** Transient: track currently highlighted as the drop target during a
   * cross-track clip drag. Not persisted. */
  dragTargetTrackId: string | null;
  setDragTargetTrackId: (trackId: string | null) => void;

  /** The "active" track — last track the user clicked or whose clip they
   * selected. Paste targets this track when the type is compatible. */
  activeTrackId: string | null;
  setActiveTrackId: (trackId: string | null) => void;

  // Phase & timeline viewport
  phase: 'setup' | 'timeline';
  zoomLevel: number;
  scrollOffsetMs: number;
  viewportWidthPx: number;
  selectedSubtitleIds: string[];

  // Undo/redo
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // Lifecycle
  loadReels: (
    reels: ReelDefinition[],
    baseSegments: SubtitleSegment[],
    durationMs: number,
    sourceRes: { width: number; height: number } | null
  ) => void;
  /**
   * Refresh ONLY `baseSegments` (and durationMs) from the parent
   * transcription, without touching any reel's saved subtitleSegments.
   * Used by the /reels page effect to keep baseSegments live so that
   * createReel always operates against the latest transcription, while
   * existing reels remain immutable to outside changes.
   */
  refreshBaseSegments: (
    baseSegments: SubtitleSegment[],
    durationMs?: number
  ) => void;
  selectReel: (id: string | null) => void;
  markClean: () => void;

  // Reel CRUD
  createReel: (name: string, startMs: number, endMs: number, sourceStartMs?: number, sourceEndMs?: number, composeClips?: CompositionClip[], origin?: { versionId: string; versionLabel: string }) => string;
  deleteReel: (id: string) => void;
  duplicateReel: (id: string) => string;
  updateReel: (id: string, updates: Partial<ReelDefinition>) => void;

  // Track management
  addTrack: (reelId: string, type: CompositionTrack['type'], label: string) => string;
  removeTrack: (reelId: string, trackId: string) => void;
  toggleTrackMute: (reelId: string, trackId: string) => void;
  /** "Mesa y ambiente como pistas separadas": for every ra1 clip, put the
   *  matching stretch of each part's processed stems on ra_mesa / ra_amb and
   *  MUTE ra1 (the baked mix). One undo entry. */
  applyStemTracks: (reelId: string, layout: StemSegment[], mainAudioFileName?: string, mainAudioOffsetMs?: number) => void;
  removeStemTracks: (reelId: string) => void;
  stemTracksActive: (reelId: string) => boolean;

  // Timeline
  addClip: (reelId: string, clip: Omit<CompositionClip, 'id'>) => string;
  updateClip: (reelId: string, clipId: string, updates: Partial<CompositionClip>) => void;
  removeClip: (reelId: string, clipId: string) => void;
  moveClip: (reelId: string, clipId: string, newStartMs: number) => void;
  /** Move a clip to a different track AND set its start in one update (used by
   * vertical drag between tracks). Caller should validate type compatibility. */
  moveClipToTrack: (reelId: string, clipId: string, newTrackId: string, newStartMs: number) => void;
  trimClip: (reelId: string, clipId: string, edge: 'in' | 'out', newMs: number) => void;
  splitClipAtPlayhead: (reelId: string) => void;
  selectClip: (clipId: string | null, addToSelection?: boolean) => void;
  moveSelectedClips: (reelId: string, deltaMs: number) => void;
  closeGapForSelected: (reelId: string) => void;

  // Crop
  updateCropRegion: (reelId: string, updates: Partial<CropRegion>) => void;
  /** Animated crop (keyframes de encuadre). Adding uses the EFFECTIVE crop at
   *  the playhead (no visual jump); dragging the rect with keyframes active
   *  upserts the keyframe at the playhead (Premiere-style auto-keyframe). */
  addCropKeyframeAtPlayhead: (reelId: string) => void;
  upsertCropKeyframeAt: (reelId: string, tMs: number, crop: CropRegion) => void;
  /** Edit ONE keyframe by id (row controls) — no playhead involved, so it
   *  can never create a stray keyframe when the playhead has drifted. */
  updateCropKeyframe: (reelId: string, kfId: string, updates: Partial<CropRegion>) => void;
  /** Hold the framing steady across [startMs,endMs) — used by the "congelar
   *  encuadre en este plano" action: drops every keyframe inside the shot
   *  and pins the entry framing at both ends. */
  freezeCropInRange: (reelId: string, startMs: number, endMs: number) => void;
  deleteCropKeyframe: (reelId: string, kfId: string) => void;
  clearCropKeyframes: (reelId: string) => void;

  // Letterbox/pillarbox fill color behind the video (default black) — shows
  // wherever the crop/transform doesn't fully cover the 9:16 canvas.
  setReelBackgroundColor: (reelId: string, color: string) => void;

  // Subtitles
  regenerateReelSubtitles: (reelId: string) => void;
  syncReelSubtitlesFromBase: (reelId: string) => void;
  updateReelSubtitleSegment: (reelId: string, segId: string, updates: Partial<SubtitleSegment>) => void;
  /** Drop the trailing .,;: of EVERY block of this reel (the "Strip .," button,
   *  same behaviour as Compose's). One undo entry; a no-op when nothing ends
   *  in punctuation. Chopped reel subtitles ("picado"/"remate") cut mid-sentence,
   *  so most blocks end on a comma the viewer does not need to read. */
  stripReelSubtitlePunctuation: (reelId: string) => void;
  styleSelectedReelSubtitles: (reelId: string, update: SegmentStyleUpdate) => void;
  setReelSubtitleStyle: (reelId: string, style: SubtitleStyle) => void;
  setReelSubtitlePreset: (reelId: string, presetId: string, style: SubtitleStyle) => void;
  setReelSubtitleConstraints: (reelId: string, constraints: SubtitleConstraints) => void;

  // Phase & timeline viewport
  setPhase: (phase: 'setup' | 'timeline') => void;
  enterTimelinePhase: (reelId: string, videoFileName?: string, audioFileName?: string, composeClips?: CompositionClip[], composeTracks?: CompositionTrack[]) => void;
  setZoom: (level: number) => void;
  setScrollOffset: (ms: number) => void;
  setViewportWidth: (px: number) => void;
  selectSubtitle: (id: string | null, addToSelection?: boolean) => void;
  selectAllSubtitles: (reelId: string) => void;
  selectSubtitlesFromPlayhead: (reelId: string, direction: 'left' | 'right') => void;
  /** Shift+click: select the contiguous run of subtitles between the current
   *  selection and the clicked one (inclusive). No selection → just clicked. */
  selectSubtitleRange: (reelId: string, id: string) => void;
  /** Rebuild subtitles for the empty stretch under the playhead from the
   *  ORIGINAL transcription (source time), remapped through the rv1 clips. */
  fillSubtitleGapAtPlayhead: (reelId: string, original: SubtitleSegment[]) => { ok: boolean; added: number; reason?: string };
  moveSelectedSubtitles: (reelId: string, deltaMs: number) => void;
  deleteSubtitleSegment: (reelId: string, segId: string) => void;
  deleteSelected: (reelId: string) => void;
  splitSubtitleAtPlayhead: (reelId: string) => void;
  addSubtitleSegment: (reelId: string) => void;
  splitAllAtPlayhead: (reelId: string) => void;
  rippleDeleteSelected: (reelId: string) => void;
  collapseGapAtPlayhead: (reelId: string) => void;
  clearTimeline: (reelId: string) => void;
  copySelectedClips: (reelId: string) => void;
  /** atMs (when given) overrides the paste position — used by pasteSelection so
   *  clips and subtitles share ONE point computed before anything is inserted.
   *  skipUndo lets pasteSelection push a single undo entry for the whole paste. */
  pasteClips: (reelId: string, atEnd?: boolean, atMs?: number, skipUndo?: boolean) => void;
  canPasteClips: () => boolean;
  /** Copy the currently selected subtitle segments to a cross-reel clipboard. */
  copySelectedSubtitles: (reelId: string) => void;
  /** Paste clipboard subtitles at the playhead, or appended after the reel's
   *  content when atEnd is true ("detrás"). atMs/skipUndo as in pasteClips. */
  pasteSubtitles: (reelId: string, atEnd?: boolean, atMs?: number, skipUndo?: boolean) => void;
  canPasteSubtitles: () => boolean;
  /** Copy whatever is currently selected (clips or subtitles) — used by Ctrl+C. */
  copySelection: (reelId: string) => void;
  /** Paste clips AND subtitles from the clipboards. atEnd appends after the
   *  reel's current content instead of at the playhead. Used by Ctrl+V. */
  pasteSelection: (reelId: string, atEnd?: boolean) => void;
  /** Premiere-style INSERT paste (Ctrl+Shift+V): splits clips straddling the
   *  playhead, shifts everything at/after it right by the pasted span, and
   *  inserts the clipboard clips WITH the subtitles captured in their span
   *  (subtitle-only clipboard inserts + shifts subtitles the same way). */
  rippleInsertAtPlayhead: (reelId: string) => void;
  syncSubtitlesToClips: (reelId: string) => void;
  resetTimeline: (reelId: string) => void;
  msToPixel: (ms: number) => number;
  pixelToMs: (px: number) => number;

  // Undo/redo
  saveSnapshot: () => void;
  undo: (reelId: string) => void;
  redo: (reelId: string) => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Versions (persistent named snapshots)
  saveVersion: (reelId: string, label: string) => void;
  restoreVersion: (reelId: string, versionId: string) => void;
  deleteVersion: (reelId: string, versionId: string) => void;

  // Playback
  setCurrentTime: (ms: number) => void;
  setIsPlaying: (playing: boolean) => void;

  // Helpers
  getActiveReel: () => ReelDefinition | undefined;
}

/**
 * Build the reel's main rv1 (+ optional ra1) clips for a compose range,
 * inheriting compose cuts. Returns one segment per compose v1 clip that
 * overlaps [reelStartMs, reelEndMs], laid out back-to-back on the reel's
 * local timeline (cuts removed). Falls back to a single clip spanning
 * [srcStart, srcEnd] when there are 0 or 1 overlapping compose clips.
 *
 * Returns null when there's nothing meaningful to build (no filenames).
 */
function buildReelMainClips(params: {
  composeClips: CompositionClip[] | undefined;
  reelStartMs: number;
  reelEndMs: number;
  reelDur: number;
  srcStart: number;
  srcEnd: number;
  videoFileName?: string;
  audioFileName?: string;
}): CompositionClip[] | null {
  const { composeClips, reelStartMs, reelEndMs, reelDur, srcStart, srcEnd, videoFileName, audioFileName } = params;
  if (!videoFileName && !audioFileName) return null;

  const inRange = (composeClips ?? [])
    .filter((c) => c.trackId === 'v1' && c.timelineEndMs > reelStartMs && c.timelineStartMs < reelEndMs)
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  const clips: CompositionClip[] = [];

  if (inRange.length > 1) {
    // Multiple compose clips → segment with cuts.
    // `emit` runs per track; only the video track (rv1) carries the visual
    // transform (zoom/position/rotation) — audio has none.
    const emit = (trackId: 'rv1' | 'ra1', type: 'video' | 'audio', fileName: string) => {
      let off = 0;
      for (const cc of inRange) {
        const composeStart = Math.max(cc.timelineStartMs, reelStartMs);
        const composeEnd = Math.min(cc.timelineEndMs, reelEndMs);
        const dur = composeEnd - composeStart;
        if (dur <= 0) continue;
        const sourceIn = cc.sourceInMs + (composeStart - cc.timelineStartMs);
        clips.push({
          id: uuidv4(),
          type,
          fileName,
          originalName: fileName,
          trackId,
          timelineStartMs: off,
          timelineEndMs: off + dur,
          sourceInMs: sourceIn,
          sourceOutMs: sourceIn + dur,
          // Inherit the compose clip's motion transform (zoom/position/angle)
          // so a camera straighten / zoom set in compose carries into the reel.
          ...(type === 'video' && cc.transform ? { transform: { ...cc.transform } } : {}),
        });
        off += dur;
      }
    };
    if (videoFileName) emit('rv1', 'video', videoFileName);
    if (audioFileName) emit('ra1', 'audio', audioFileName);
  } else {
    // 0 or 1 overlapping compose clip → single continuous segment.
    // Inherit the transform from the single overlapping compose clip if present.
    const inheritedTransform = inRange.length === 1 ? inRange[0].transform : undefined;
    if (videoFileName) {
      clips.push({
        id: uuidv4(), type: 'video', fileName: videoFileName, originalName: videoFileName,
        trackId: 'rv1', timelineStartMs: 0, timelineEndMs: reelDur, sourceInMs: srcStart, sourceOutMs: srcEnd,
        ...(inheritedTransform ? { transform: { ...inheritedTransform } } : {}),
      });
    }
    if (audioFileName) {
      clips.push({
        id: uuidv4(), type: 'audio', fileName: audioFileName, originalName: audioFileName,
        trackId: 'ra1', timelineStartMs: 0, timelineEndMs: reelDur, sourceInMs: srcStart, sourceOutMs: srcEnd,
      });
    }
  }
  return clips;
}

/**
 * Tracks of a reel after carrying compose extra-audio clips: when stem clips
 * (mesa / ambiente) came along, make sure the reel has the two stem tracks
 * and mirror compose's main-audio mute onto ra1 — otherwise the reel would
 * play the baked mix UNDER the stems (triple audio).
 */
function tracksAfterCarry(
  tracks: CompositionTrack[],
  carried: CompositionClip[],
  composeTracks: CompositionTrack[] | undefined,
): CompositionTrack[] {
  if (!carried.some((c) => stemKindOfTrack(c.trackId))) return tracks;
  const composeA1Muted = composeTracks?.find((t) => t.id === 'a1')?.muted ?? true;
  return ensureStemTracks(tracks, STEM_TRACK_IDS.reel, 'ra1')
    .map((t) => (t.id === 'ra1' ? { ...t, muted: composeA1Muted } : t));
}

/**
 * Carry the compose EXTRA-audio clips (a2+ — pasted/copied layers, music, SFX)
 * overlapping [reelStartMs, reelEndMs] into the reel's Extra Audio track (ra2).
 * COMPOSE-timeline time maps to reel-local time through the same v1-derived
 * windows buildReelMainClips uses (cuts removed, back-to-back), so a layer
 * spanning a compose cut is split like the main clips. Volume and fade-in
 * carry over; the fade only survives on the piece containing the clip's start.
 */
export function buildReelExtraAudioClips(params: {
  composeClips: CompositionClip[] | undefined;
  reelStartMs: number;
  reelEndMs: number;
}): CompositionClip[] {
  const { composeClips, reelStartMs, reelEndMs } = params;
  const extras = (composeClips ?? [])
    .filter((c) => c.type === 'audio' && c.trackId !== 'a1' && c.fileName &&
      c.timelineEndMs > reelStartMs && c.timelineStartMs < reelEndMs)
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  if (extras.length === 0) return [];

  // Compose-time windows → reel-local offsets (mirror of buildReelMainClips).
  const inRange = (composeClips ?? [])
    .filter((c) => c.trackId === 'v1' && c.timelineEndMs > reelStartMs && c.timelineStartMs < reelEndMs)
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  let windows: { composeStart: number; composeEnd: number; localStart: number }[];
  if (inRange.length > 1) {
    windows = [];
    let off = 0;
    for (const cc of inRange) {
      const composeStart = Math.max(cc.timelineStartMs, reelStartMs);
      const composeEnd = Math.min(cc.timelineEndMs, reelEndMs);
      if (composeEnd - composeStart <= 0) continue;
      windows.push({ composeStart, composeEnd, localStart: off });
      off += composeEnd - composeStart;
    }
  } else {
    windows = [{ composeStart: reelStartMs, composeEnd: reelEndMs, localStart: 0 }];
  }

  const out: CompositionClip[] = [];
  for (const ea of extras) {
    for (const w of windows) {
      const oS = Math.max(ea.timelineStartMs, w.composeStart);
      const oE = Math.min(ea.timelineEndMs, w.composeEnd);
      if (oE - oS < 50) continue;
      const localStart = w.localStart + (oS - w.composeStart);
      const sourceIn = ea.sourceInMs + (oS - ea.timelineStartMs);
      const keepsStart = oS <= ea.timelineStartMs;
      // Compose stem tracks map onto the reel's stem tracks (created by the
      // caller); every other extra layer lands on ra2 as before.
      const stemKind = stemKindOfTrack(ea.trackId);
      out.push({
        id: uuidv4(),
        type: 'audio',
        fileName: ea.fileName!,
        originalName: ea.originalName ?? ea.fileName!,
        trackId: stemKind ? STEM_TRACK_IDS.reel[stemKind] : 'ra2',
        timelineStartMs: localStart,
        timelineEndMs: localStart + (oE - oS),
        sourceInMs: sourceIn,
        sourceOutMs: sourceIn + (oE - oS),
        ...(ea.volume !== undefined ? { volume: ea.volume } : {}),
        // Volume zones travel with the clip: they live in the FILE's clock, so
        // the reel's own seek needs no remapping (only the ones this piece of
        // the clip actually uses come along).
        ...(ea.gainRegions?.length
          ? { gainRegions: ea.gainRegions.filter((r) => Math.max(r.startMs, r.endMs) > sourceIn && Math.min(r.startMs, r.endMs) < sourceIn + (oE - oS)) }
          : {}),
        ...(keepsStart && ea.fadeInMs ? { fadeInMs: ea.fadeInMs, fadeInCurve: ea.fadeInCurve } : {}),
      });
    }
  }
  return out;
}

/** The subtitles a reel's compose range is cut from: the named compose
 *  version it was born from (its own subtitles, on its own timeline) when it
 *  has one and that version still exists — else the live transcription. */
function segmentsForReel(
  state: { baseSegments: SubtitleSegment[]; composeVersions: ComposeVersion[] },
  reel?: { composeVersionId?: string; versionId?: string } | null,
): SubtitleSegment[] {
  const vid = reel?.composeVersionId ?? reel?.versionId;
  if (vid) {
    const v = state.composeVersions.find((x) => x.id === vid);
    if (v) return v.subtitleSegments;
  }
  return state.baseSegments;
}

function filterSegmentsToRange(
  segments: SubtitleSegment[],
  startMs: number,
  endMs: number,
  constraints: SubtitleConstraints
): SubtitleSegment[] {
  const filtered = segments
    .filter((s) => s.endMs > startMs && s.startMs < endMs)
    .map((s) => ({
      ...s,
      id: uuidv4(),
      startMs: Math.max(0, s.startMs - startMs),
      endMs: Math.min(endMs - startMs, s.endMs - startMs),
      words: s.words?.map((w) => ({
        ...w,
        startMs: Math.max(0, w.startMs - startMs),
        endMs: w.endMs - startMs,
      })),
    }));
  return splitSegmentsWithConstraints(filtered, constraints);
}

/** Split any subtitle segment that spans the given time point into two parts */
function splitSubtitlesAtTime(segments: SubtitleSegment[], timeMs: number): SubtitleSegment[] {
  const result: SubtitleSegment[] = [];
  for (const seg of segments) {
    if (timeMs > seg.startMs && timeMs < seg.endMs) {
      // Split this segment — divide text by time proportion using words if available
      const totalDur = seg.endMs - seg.startMs;
      const splitRatio = (timeMs - seg.startMs) / totalDur;

      // Only trust words[] when it matches the TEXT token-for-token. A drifted
      // words array (e.g. an edge word dropped by a defensive clamp while the
      // text kept it) would silently LOSE words when the halves' text is
      // rebuilt from words — the "última palabra desaparece al dividir" bug.
      const textTokens = seg.text.split(/\s+/).filter(Boolean);
      const wordsMatchText = !!seg.words && seg.words.length === textTokens.length;

      if (seg.words && seg.words.length > 0 && wordsMatchText) {
        // Find word boundary closest to split time
        let splitWordIdx = 0;
        for (let i = 0; i < seg.words.length; i++) {
          if (seg.words[i].startMs >= timeMs) { splitWordIdx = i; break; }
          splitWordIdx = i + 1;
        }
        // Ensure at least 1 word per side
        splitWordIdx = Math.max(1, Math.min(seg.words.length - 1, splitWordIdx));

        const leftWords = seg.words.slice(0, splitWordIdx);
        const rightWords = seg.words.slice(splitWordIdx);
        const leftText = leftWords.map((w) => w.text).join(' ');
        const rightText = rightWords.map((w) => w.text).join(' ');

        result.push({
          ...seg,
          id: uuidv4(),
          endMs: timeMs,
          text: leftText,
          words: leftWords,
        });
        result.push({
          ...seg,
          id: uuidv4(),
          startMs: timeMs,
          text: rightText,
          words: rightWords,
        });
      } else {
        // No word data — split text proportionally at nearest space
        const text = seg.text;
        const approxCharIdx = Math.round(text.length * splitRatio);
        // Find nearest space
        let splitCharIdx = approxCharIdx;
        let bestDist = Infinity;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === ' ' || text[i] === '\n') {
            const dist = Math.abs(i - approxCharIdx);
            if (dist < bestDist) { bestDist = dist; splitCharIdx = i; }
          }
        }
        const leftText = text.slice(0, splitCharIdx).trim();
        const rightText = text.slice(splitCharIdx).trim();

        if (leftText && rightText) {
          result.push({ ...seg, id: uuidv4(), endMs: timeMs, text: leftText, words: undefined });
          result.push({ ...seg, id: uuidv4(), startMs: timeMs, text: rightText, words: undefined });
        } else {
          // Can't meaningfully split text, keep original
          result.push(seg);
        }
      }
    } else {
      result.push(seg);
    }
  }
  return result;
}

function updateReelInList(
  reels: ReelDefinition[],
  reelId: string,
  updater: (reel: ReelDefinition) => ReelDefinition
): ReelDefinition[] {
  return reels.map((r) => (r.id === reelId ? updater(r) : r));
}

/** Ripple semantics for crop keyframes — same contract as subtitles: a
 * removed span drops the keyframes inside it and shifts later ones left. */
function rippleDeleteCropKeyframes(
  kfs: CropKeyframe[] | undefined,
  gapStartMs: number,
  gapEndMs: number,
): CropKeyframe[] | undefined {
  if (!kfs || kfs.length === 0) return kfs;
  const gap = gapEndMs - gapStartMs;
  return kfs
    .filter((k) => k.timeMs < gapStartMs || k.timeMs >= gapEndMs)
    .map((k) => (k.timeMs >= gapEndMs ? { ...k, timeMs: k.timeMs - gap } : k));
}

/** Ripple insert: keyframes at/after the insertion point shift right. */
function rippleShiftCropKeyframes(
  kfs: CropKeyframe[] | undefined,
  fromMs: number,
  deltaMs: number,
): CropKeyframe[] | undefined {
  if (!kfs || kfs.length === 0) return kfs;
  return kfs.map((k) => (k.timeMs >= fromMs ? { ...k, timeMs: k.timeMs + deltaMs } : k));
}

/** Save a snapshot of the active reel before a destructive action */
function pushUndo(state: ReelStore): { undoStack: UndoEntry[]; redoStack: UndoEntry[] } {
  const reel = state.activeReelId ? state.reels.find((r) => r.id === state.activeReelId) : undefined;
  if (!reel) return { undoStack: state.undoStack, redoStack: state.redoStack };
  const entry: UndoEntry = {
    reel: JSON.parse(JSON.stringify(reel)),
    selectedClipIds: [...state.selectedClipIds],
    selectedSubtitleIds: [...state.selectedSubtitleIds],
  };
  const stack = [...state.undoStack, entry];
  if (stack.length > MAX_UNDO) stack.shift();
  return { undoStack: stack, redoStack: [] };
}

export const useReelStore = create<ReelStore>((set, get) => ({
  reels: [],
  activeReelId: null,
  currentTimeMs: 0,
  isPlaying: false,
  sourceResolution: null,
  baseDurationMs: 0,
  baseSegments: [],
  composeVersions: [],
  setComposeVersions: (versions) => set({ composeVersions: versions }),
  dirty: false,
  selectedClipIds: [],
  dragTargetTrackId: null,
  activeTrackId: null,
  phase: 'setup',
  zoomLevel: 0.1,
  scrollOffsetMs: 0,
  viewportWidthPx: 800,
  selectedSubtitleIds: [],
  undoStack: [],
  redoStack: [],

  loadReels: (reels, baseSegments, durationMs, sourceRes) => {
    // Load reels AS-IS from disk. Earlier I tried to auto-refresh each
    // reel's subtitleSegments from baseSegments on every load — that fixed
    // stale-snapshot reels but ALSO blew away any per-reel edits the user
    // had made (Delete + Close Gap on subs, text rewrites, etc.) every
    // time they navigated to /export and back. Manual edits matter more
    // than auto-syncing, so loading is now read-only. A stale-snapshot
    // reel can be re-synced explicitly via `syncReelSubtitlesFromBase`.
    set({
      reels,
      baseSegments,
      baseDurationMs: durationMs,
      sourceResolution: sourceRes,
      activeReelId: reels[0]?.id ?? null,
      currentTimeMs: 0,
      isPlaying: false,
      dirty: false,
      selectedClipIds: [],
    });
  },

  refreshBaseSegments: (baseSegments, durationMs) => {
    // Touch ONLY baseSegments (and optionally durationMs). Existing reels'
    // `subtitleSegments` are left exactly as they are on disk. This is the
    // hook the page uses to keep baseSegments live so that the NEXT
    // createReel call snapshots against the latest transcription — without
    // ever wiping a reel the user has already edited.
    set((s) => ({
      baseSegments,
      baseDurationMs: durationMs ?? s.baseDurationMs,
    }));
  },

  /**
   * Re-derive a reel's subtitleSegments from the current baseSegments
   * (= transcription.segments). Use when the parent transcription has
   * changed since the reel was created and the reel's snapshot is stale.
   * DESTROYS per-reel edits to those subs — the caller (UI button) should
   * confirm with the user first.
   */
  syncReelSubtitlesFromBase: (reelId: string) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const fresh = filterSegmentsToRange(
      segmentsForReel(state, reel),
      reel.startMs,
      reel.endMs,
      reel.subtitleConstraints
    );
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: fresh,
      })),
      dirty: true,
    }));
  },

  selectReel: (id) => set({ activeReelId: id, currentTimeMs: 0, isPlaying: false, selectedClipIds: [], selectedSubtitleIds: [], activeTrackId: null, phase: 'setup' }),
  markClean: () => set({ dirty: false }),

  createReel: (name, startMs, endMs, sourceStartMs, sourceEndMs, composeClips, origin) => {
    const id = uuidv4();
    const constraints = { ...REEL_DEFAULT_CONSTRAINTS };
    // startMs/endMs = compose timeline times (for display, trim bar, subtitle filtering)
    // sourceStartMs/sourceEndMs = source times (ONLY for video/audio seeking in muxed file)
    const srcStart = sourceStartMs != null ? sourceStartMs : startMs;
    const srcEnd = sourceEndMs != null ? sourceEndMs : endMs;
    console.log(`[reel-store] createReel "${name}": compose=${startMs}-${endMs}, source=${srcStart}-${srcEnd}`);
    // Subtitles filtered by COMPOSE time (baseSegments are now in compose time);
    // a reel from a named compose version takes that version's subtitles.
    const segments = filterSegmentsToRange(segmentsForReel(get(), origin), startMs, endMs, constraints);

    // When the reel's COMPOSE range spans more than one v1 clip it crosses one
    // or more compose cuts. mapComposeRangeToSource returns the per-clip source
    // segments so the SETUP preview skips the removed material (reel-video-player
    // reads reel.sourceSegments). The trim bar + crop box stay fully available;
    // only playback maps through the segments instead of a single linear span.
    const mapping = composeClips
      ? mapComposeRangeToSource(composeClips, startMs, endMs)
      : undefined;
    const sourceSegments = mapping?.sourceSegments;

    const reel: ReelDefinition = {
      id,
      name,
      createdAt: new Date().toISOString(),
      startMs,
      endMs,
      sourceStartMs: sourceStartMs != null ? sourceStartMs : undefined,
      sourceEndMs: sourceEndMs != null ? sourceEndMs : undefined,
      sourceSegments,
      ...(origin ? { composeVersionId: origin.versionId, composeVersionLabel: origin.versionLabel } : {}),
      cropRegion: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
      composition: { tracks: defaultReelTracks.map((t) => ({ ...t })), clips: [], mediaBin: [] },
      subtitleStyle: { ...defaultReelStyle },
      subtitleStylePreset: 'reel-punchline',
      subtitleConstraints: constraints,
      subtitleSegments: segments,
      punchlineSegmentIds: [],
    };
    set((s) => ({ reels: [...s.reels, reel], activeReelId: id, dirty: true, phase: 'setup' as const, currentTimeMs: 0, isPlaying: false, selectedClipIds: [], selectedSubtitleIds: [] }));
    return id;
  },

  deleteReel: (id) => {
    set((s) => ({
      reels: s.reels.filter((r) => r.id !== id),
      activeReelId: s.activeReelId === id ? (s.reels.find((r) => r.id !== id)?.id ?? null) : s.activeReelId,
      dirty: true,
    }));
  },

  duplicateReel: (id) => {
    const source = get().reels.find((r) => r.id === id);
    if (!source) return '';
    const newId = uuidv4();
    const dup: ReelDefinition = {
      ...JSON.parse(JSON.stringify(source)),
      id: newId,
      name: `${source.name} (copy)`,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ reels: [...s.reels, dup], activeReelId: newId, dirty: true }));
    return newId;
  },

  updateReel: (id, updates) => {
    set((s) => ({
      reels: updateReelInList(s.reels, id, (r) => ({ ...r, ...updates })),
      dirty: true,
    }));
  },

  // Track management
  addTrack: (reelId, type, label) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return '';
    // Generate unique track ID with prefix based on type
    const prefix = type === 'video' ? 'rv' : type === 'audio' ? 'ra' : type === 'subtitle' ? 'rs' : type === 'image' ? 'ri' : 'rt';
    const existingNums = reel.composition.tracks
      .filter((t) => t.id.startsWith(prefix))
      .map((t) => parseInt(t.id.slice(prefix.length)) || 0);
    const nextNum = Math.max(0, ...existingNums) + 1;
    const trackId = `${prefix}${nextNum}`;
    const track: CompositionTrack = {
      id: trackId,
      type,
      label,
      locked: false,
      muted: false,
      visible: true,
    };
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => {
        const tracks = [...r.composition.tracks];
        // Insert overlay tracks (image, text) above main video (rv1)
        // In NLE convention: higher layers render on top, so they go first
        if (type === 'image' || type === 'text') {
          const rv1Idx = tracks.findIndex((t) => t.id === 'rv1');
          if (rv1Idx >= 0) {
            tracks.splice(rv1Idx, 0, track);
          } else {
            tracks.unshift(track);
          }
        } else if (type === 'video') {
          // Additional video tracks go right after rv1
          const rv1Idx = tracks.findIndex((t) => t.id === 'rv1');
          if (rv1Idx >= 0) {
            tracks.splice(rv1Idx + 1, 0, track);
          } else {
            tracks.push(track);
          }
        } else if (type === 'audio') {
          // Audio tracks go after main audio (ra1)
          const ra1Idx = tracks.findIndex((t) => t.id === 'ra1');
          if (ra1Idx >= 0) {
            tracks.splice(ra1Idx + 1, 0, track);
          } else {
            tracks.push(track);
          }
        } else {
          tracks.push(track);
        }
        return {
          ...r,
          composition: { ...r.composition, tracks },
        };
      }),
      dirty: true,
    }));
    return trackId;
  },

  toggleTrackMute: (reelId, trackId) =>
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          tracks: r.composition.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
        },
      })),
      dirty: true,
    })),

  applyStemTracks: (reelId, layout, mainAudioFileName, mainAudioOffsetMs) => {
    const reel = get().reels.find((r) => r.id === reelId);
    if (!reel) return;
    set(pushUndo(get()));
    const ids = STEM_TRACK_IDS.reel;
    const ra1 = reel.composition.clips
      .filter((c) => c.trackId === 'ra1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const stemClips: CompositionClip[] = [];
    for (const ac of ra1) {
      stemClips.push(...buildStemClipsForWindow({
        layout,
        trackIds: ids,
        concatFromMs: ac.sourceInMs,
        concatToMs: ac.sourceOutMs,
        timelineStartMs: ac.timelineStartMs,
        mainAudioFileName,
        mainAudioOffsetMs,
        makeId: () => uuidv4(),
      }));
    }
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          tracks: ensureStemTracks(r.composition.tracks, ids, 'ra1').map((t) => (t.id === 'ra1' ? { ...t, muted: true } : t)),
          clips: [...r.composition.clips.filter((c) => c.trackId !== ids.board && c.trackId !== ids.ambient), ...stemClips],
        },
      })),
      selectedClipIds: [],
      dirty: true,
    }));
  },

  removeStemTracks: (reelId) => {
    set(pushUndo(get()));
    const ids = STEM_TRACK_IDS.reel;
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          tracks: r.composition.tracks
            .filter((t) => t.id !== ids.board && t.id !== ids.ambient)
            .map((t) => (t.id === 'ra1' ? { ...t, muted: false } : t)),
          clips: r.composition.clips.filter((c) => c.trackId !== ids.board && c.trackId !== ids.ambient),
        },
      })),
      selectedClipIds: [],
      dirty: true,
    }));
  },

  stemTracksActive: (reelId) => {
    const reel = get().reels.find((r) => r.id === reelId);
    return !!reel && hasStemTracks(reel.composition.tracks, STEM_TRACK_IDS.reel);
  },

  removeTrack: (reelId, trackId) => {
    // Don't allow removing default locked tracks
    if (['rv1', 'ra1', 'rs1'].includes(trackId)) return;
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          tracks: r.composition.tracks.filter((t) => t.id !== trackId),
          clips: r.composition.clips.filter((c) => c.trackId !== trackId),
        },
      })),
      dirty: true,
    }));
  },

  // Timeline operations
  addClip: (reelId, clipData) => {
    const clipId = uuidv4();
    // Default overlayPosition for image/gif clips
    const enriched = (clipData.type === 'image' || clipData.type === 'gif') && !clipData.overlayPosition
      ? { ...clipData, overlayPosition: { x: 0.5, y: 0.5, width: 0.8 } }
      : clipData;
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: [...r.composition.clips, { ...enriched, id: clipId }],
        },
      })),
      selectedClipIds: [clipId],
      dirty: true,
    }));
    return clipId;
  },

  updateClip: (reelId, clipId, updates) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: r.composition.clips.map((c) => (c.id === clipId ? { ...c, ...updates } : c)),
        },
      })),
      dirty: true,
    }));
  },

  removeClip: (reelId, clipId) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: r.composition.clips.filter((c) => c.id !== clipId),
        },
      })),
      selectedClipIds: s.selectedClipIds.filter((id) => id !== clipId),
      dirty: true,
    }));
  },

  moveClip: (reelId, clipId, newStartMs) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: r.composition.clips.map((c) => {
            if (c.id !== clipId) return c;
            const dur = c.timelineEndMs - c.timelineStartMs;
            return { ...c, timelineStartMs: Math.max(0, newStartMs), timelineEndMs: Math.max(0, newStartMs) + dur };
          }),
        },
      })),
      dirty: true,
    }));
  },

  setDragTargetTrackId: (trackId) => set({ dragTargetTrackId: trackId }),

  setActiveTrackId: (trackId) => set({ activeTrackId: trackId }),

  moveClipToTrack: (reelId, clipId, newTrackId, newStartMs) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: r.composition.clips.map((c) => {
            if (c.id !== clipId) return c;
            const dur = c.timelineEndMs - c.timelineStartMs;
            const start = Math.max(0, newStartMs);
            return { ...c, trackId: newTrackId, timelineStartMs: start, timelineEndMs: start + dur };
          }),
        },
      })),
      dirty: true,
    }));
  },

  trimClip: (reelId, clipId, edge, newMs) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    // Upper bound for source time: use the max sourceOut across all clips, or a large fallback
    // baseDurationMs is in compose time which can be much smaller than source time
    const existingMaxSource = reel ? Math.max(...reel.composition.clips.map(c => c.sourceOutMs || 0), 0) : 0;
    const maxSourceMs = Math.max(existingMaxSource * 2, state.baseDurationMs * 2, reel?.endMs ?? 0);
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: r.composition.clips.map((c) => {
            if (c.id !== clipId) return c;
            if (edge === 'in') {
              const clamped = Math.max(0, Math.min(newMs, c.timelineEndMs - 100));
              const delta = clamped - c.timelineStartMs;
              const newSourceIn = Math.max(0, c.sourceInMs + delta);
              return { ...c, timelineStartMs: clamped, sourceInMs: newSourceIn };
            } else {
              const clamped = Math.max(c.timelineStartMs + 100, newMs);
              const delta = clamped - c.timelineEndMs;
              const newSourceOut = Math.min(maxSourceMs, c.sourceOutMs + delta);
              // Clamp timeline end to match the clamped source
              const actualDelta = newSourceOut - c.sourceOutMs;
              const actualEnd = c.timelineEndMs + actualDelta;
              return { ...c, timelineEndMs: actualEnd, sourceOutMs: newSourceOut };
            }
          }),
        },
      })),
      dirty: true,
    }));
  },

  splitClipAtPlayhead: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const t = state.currentTimeMs;

    // If a clip is selected, use it; otherwise find any clip under playhead
    const firstSelected = state.selectedClipIds[0] ?? null;
    let clip = firstSelected
      ? reel.composition.clips.find((c) => c.id === firstSelected)
      : undefined;
    if (!clip || t <= clip.timelineStartMs + MIN_SPLIT_PIECE_MS || t >= clip.timelineEndMs - MIN_SPLIT_PIECE_MS) {
      clip = reel.composition.clips.find((c) => t > c.timelineStartMs + MIN_SPLIT_PIECE_MS && t < c.timelineEndMs - MIN_SPLIT_PIECE_MS);
    }
    if (!clip) return;
    if (t <= clip.timelineStartMs + MIN_SPLIT_PIECE_MS || t >= clip.timelineEndMs - MIN_SPLIT_PIECE_MS) return;

    const sourceOffset = t - clip.timelineStartMs;
    const splitSourceMs = clip.sourceInMs + sourceOffset;
    const leftId = uuidv4();
    const rightId = uuidv4();

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: [
            ...r.composition.clips.filter((c) => c.id !== clip.id),
            { ...clip, id: leftId, timelineEndMs: t, sourceOutMs: splitSourceMs },
            { ...clip, id: rightId, timelineStartMs: t, sourceInMs: splitSourceMs },
          ],
        },
      })),
      selectedClipIds: [rightId],
      dirty: true,
    }));
  },

  splitSubtitleAtPlayhead: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const t = state.currentTimeMs;
    const hasSub = reel.subtitleSegments.some((s) => t > s.startMs && t < s.endMs);
    if (!hasSub) return;
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: splitSubtitlesAtTime(r.subtitleSegments, t),
      })),
      dirty: true,
    }));
  },

  addSubtitleSegment: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const t = state.currentTimeMs;
    const reelDur = reel.endMs - reel.startMs;
    const endMs = Math.min(reelDur, t + 500); // 0.5 second default duration
    const newSeg = {
      id: uuidv4(),
      startMs: t,
      endMs,
      text: '',
    };
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: [...r.subtitleSegments, newSeg].sort((a, b) => a.startMs - b.startMs),
      })),
      selectedSubtitleIds: [newSeg.id],
      dirty: true,
    }));
  },

  selectClip: (clipId, addToSelection) => {
    if (clipId === null) {
      set({ selectedClipIds: [] });
      return;
    }
    if (addToSelection) {
      set((s) => {
        const ids = s.selectedClipIds;
        if (ids.includes(clipId)) {
          return { selectedClipIds: ids.filter((id) => id !== clipId) };
        }
        return { selectedClipIds: [...ids, clipId] };
      });
    } else {
      set({ selectedClipIds: [clipId] });
    }
  },

  moveSelectedClips: (reelId, deltaMs) => {
    const state = get();
    if (state.selectedClipIds.length === 0) return;
    const selectedSet = new Set(state.selectedClipIds);
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: r.composition.clips.map((c) => {
            if (!selectedSet.has(c.id)) return c;
            const newStart = Math.max(0, c.timelineStartMs + deltaMs);
            const dur = c.timelineEndMs - c.timelineStartMs;
            return { ...c, timelineStartMs: newStart, timelineEndMs: newStart + dur };
          }),
        },
      })),
      dirty: true,
    }));
  },

  closeGapForSelected: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel || state.selectedClipIds.length === 0) return;

    const selectedSet = new Set(state.selectedClipIds);
    const selectedClips = reel.composition.clips.filter((c) => selectedSet.has(c.id));
    if (selectedClips.length === 0) return;

    // Find the leftmost start of all selected clips
    const groupStart = Math.min(...selectedClips.map((c) => c.timelineStartMs));

    // For each track that has selected clips, find the rightmost end of
    // non-selected clips that end before groupStart
    const tracksWithSelected = Array.from(new Set(selectedClips.map((c) => c.trackId)));
    let targetStart = 0;

    for (const trackId of tracksWithSelected) {
      const nonSelectedBefore = reel.composition.clips.filter(
        (c) => c.trackId === trackId && !selectedSet.has(c.id) && c.timelineEndMs <= groupStart
      );
      if (nonSelectedBefore.length > 0) {
        const maxEnd = Math.max(...nonSelectedBefore.map((c) => c.timelineEndMs));
        targetStart = Math.max(targetStart, maxEnd);
      }
    }

    const deltaMs = groupStart - targetStart;
    if (deltaMs <= 0) return;

    // Shift all selected clips
    const shiftedClips = reel.composition.clips.map((c) => {
      if (!selectedSet.has(c.id)) return c;
      return {
        ...c,
        timelineStartMs: c.timelineStartMs - deltaMs,
        timelineEndMs: c.timelineEndMs - deltaMs,
      };
    });

    // Also shift subtitles in the affected range
    const groupEnd = Math.max(...selectedClips.map((c) => c.timelineEndMs));
    const shiftedSegments = reel.subtitleSegments.map((seg) => {
      if (seg.startMs >= groupStart && seg.endMs <= groupEnd) {
        return {
          ...seg,
          startMs: seg.startMs - deltaMs,
          endMs: seg.endMs - deltaMs,
        };
      }
      return seg;
    });

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: shiftedClips },
        subtitleSegments: shiftedSegments,
        // Keyframes within the moved group's span travel with it.
        cropKeyframes: r.cropKeyframes?.map((k) =>
          k.timeMs >= groupStart && k.timeMs <= groupEnd ? { ...k, timeMs: k.timeMs - deltaMs } : k
        ),
      })),
      dirty: true,
    }));
  },

  updateCropRegion: (reelId, updates) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        cropRegion: { ...r.cropRegion, ...updates },
      })),
      dirty: true,
    }));
  },

  addCropKeyframeAtPlayhead: (reelId) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const t = state.currentTimeMs;
    // Snapshot the EFFECTIVE crop at the playhead so adding never jumps —
    // clamped in-frame so every keyframe (and thus every interpolated window)
    // stays inside the source, matching the zoompan export exactly.
    const res = state.sourceResolution;
    const eff = clampCropToFrame(
      cropAtTime(reel.cropRegion, reel.cropKeyframes, t),
      res?.width ?? 1920,
      res?.height ?? 1080,
    );
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        cropKeyframes: upsertCropKeyframe(r.cropKeyframes, {
          id: uuidv4(), timeMs: Math.round(t), ...eff,
        }),
      })),
      dirty: true,
    }));
  },

  upsertCropKeyframeAt: (reelId, tMs, crop) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        cropKeyframes: upsertCropKeyframe(r.cropKeyframes, {
          id: uuidv4(), timeMs: Math.round(tMs), ...crop,
        }),
      })),
      dirty: true,
    }));
  },

  updateCropKeyframe: (reelId, kfId, updates) => {
    const res = get().sourceResolution;
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        cropKeyframes: (r.cropKeyframes ?? []).map((k) =>
          k.id === kfId
            ? { ...k, ...clampCropToFrame({ ...k, ...updates }, res?.width ?? 1920, res?.height ?? 1080) }
            : k
        ),
      })),
      dirty: true,
    }));
  },

  freezeCropInRange: (reelId, startMs, endMs) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel || !reel.cropKeyframes || reel.cropKeyframes.length === 0) return;
    const a = Math.round(startMs);
    const b = Math.round(Math.max(startMs + 1, endMs - 1));
    const v = cropAtTime(reel.cropRegion, reel.cropKeyframes, a);
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => {
        // Drop everything inside the shot, then pin both ends to the entry
        // framing so the window is perfectly still for its whole duration.
        const outside = (r.cropKeyframes ?? []).filter((k) => k.timeMs < a || k.timeMs > b);
        return {
          ...r,
          cropKeyframes: [
            ...outside,
            { id: uuidv4(), timeMs: a, ...v },
            { id: uuidv4(), timeMs: b, ...v },
          ].sort((x, y) => x.timeMs - y.timeMs),
        };
      }),
      dirty: true,
    }));
  },

  deleteCropKeyframe: (reelId, kfId) => {
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        cropKeyframes: (r.cropKeyframes ?? []).filter((k) => k.id !== kfId),
      })),
      dirty: true,
    }));
  },

  clearCropKeyframes: (reelId) => {
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        cropKeyframes: undefined,
      })),
      dirty: true,
    }));
  },

  setReelBackgroundColor: (reelId, color) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, backgroundColor: color },
      })),
      dirty: true,
    }));
  },

  regenerateReelSubtitles: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;

    // Work on the EXISTING edited segments (preserve user text changes, formatting, word styles)
    let segments = [...reel.subtitleSegments];

    // If timeline has clips, sync subtitles to clip boundaries (trim/remove segments in gaps)
    const videoClips = reel.composition.clips
      .filter((c) => c.trackId === 'rv1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

    if (videoClips.length > 0) {
      segments = segments
        .map((seg) => {
          for (const clip of videoClips) {
            if (seg.startMs < clip.timelineEndMs && seg.endMs > clip.timelineStartMs) {
              // Clamp segment AND its words to clip bounds. Without clamping the words
              // array, splitByWords would later use stale word timings and produce
              // sub-segments outside the clip's time range.
              return clampSegmentToBounds(seg, clip.timelineStartMs, clip.timelineEndMs);
            }
          }
          return null;
        })
        .filter((s): s is SubtitleSegment => s !== null && (s.endMs - s.startMs) > 100);
    }

    // Sort to keep monotonic startMs order through the split + final array.
    segments.sort((a, b) => a.startMs - b.startMs);

    // Re-apply splitting constraints (only splits segments that exceed limits, leaves others intact)
    const resplit = splitSegmentsWithConstraints(segments, reel.subtitleConstraints);
    resplit.sort((a, b) => a.startMs - b.startMs);

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({ ...r, subtitleSegments: resplit })),
      dirty: true,
    }));
  },

  updateReelSubtitleSegment: (reelId, segId, updates) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: r.subtitleSegments.map((seg) => (seg.id === segId ? { ...seg, ...updates } : seg)),
      })),
      dirty: true,
    }));
  },

  stripReelSubtitlePunctuation: (reelId) => {
    const reel = get().reels.find((r) => r.id === reelId);
    if (!reel) return;
    const stripped = stripTrailingPunctuation(reel.subtitleSegments);
    // stripTrailingPunctuation returns the SAME object for an untouched
    // segment, so identity tells us whether anything changed — no undo entry
    // and no autosave for a click that does nothing.
    if (stripped.every((seg, i) => seg === reel.subtitleSegments[i])) return;
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({ ...r, subtitleSegments: stripped })),
      dirty: true,
    }));
  },

  styleSelectedReelSubtitles: (reelId, update) => {
    const state = get();
    if (state.selectedSubtitleIds.length === 0) return;
    const sel = new Set(state.selectedSubtitleIds);
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: r.subtitleSegments.map((seg) =>
          sel.has(seg.id) ? styleWholeSegment(seg, update) : seg
        ),
      })),
      dirty: true,
    }));
  },

  setReelSubtitleStyle: (reelId, style) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({ ...r, subtitleStyle: style })),
      dirty: true,
    }));
  },

  setReelSubtitlePreset: (reelId, presetId, style) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleStylePreset: presetId,
        subtitleStyle: style,
      })),
      dirty: true,
    }));
  },

  setReelSubtitleConstraints: (reelId, constraints) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({ ...r, subtitleConstraints: constraints })),
      dirty: true,
    }));
  },

  // Phase & timeline viewport
  setPhase: (phase) => set({ phase }),

  enterTimelinePhase: (reelId, videoFileName, audioFileName, composeClips, composeTracks) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;

    // Reel duration comes from compose times (display times)
    const reelDur = reel.endMs - reel.startMs;
    // Source times for video/audio seeking in the muxed file
    const srcStart = reel.sourceStartMs ?? reel.startMs;
    const srcEnd = reel.sourceEndMs ?? reel.endMs;
    console.log(`[reel-store] enterTimelinePhase "${reel.name}": compose=${reel.startMs}-${reel.endMs} (dur=${reelDur}), source=${srcStart}-${srcEnd}`);
    const existingClips = reel.composition.clips;

    // Repair existing clips: if any main clip (rv1/ra1) has timelineDur > sourceDur,
    // it means the reel was extended in setup but sourceEndMs wasn't updated.
    // A clip MUST have timelineDur == sourceDur for 1:1 playback. If not, the
    // player falls outside the source range and loops back to start.
    if (existingClips.length > 0) {
      const mainTrackIds = ['rv1', 'ra1'];
      const needsRepair = existingClips.some((c) => {
        if (!mainTrackIds.includes(c.trackId)) return false;
        const timelineDur = c.timelineEndMs - c.timelineStartMs;
        const sourceDur = c.sourceOutMs - c.sourceInMs;
        return timelineDur > sourceDur + 50; // source is shorter than timeline
      });

      if (needsRepair) {
        console.log(`[reel-store] Repairing clips where timelineDur > sourceDur`);
        set((s) => ({
          reels: updateReelInList(s.reels, reelId, (r) => {
            const fixedClips = r.composition.clips.map((c) => {
              if (!mainTrackIds.includes(c.trackId)) return c;
              const timelineDur = c.timelineEndMs - c.timelineStartMs;
              const sourceDur = c.sourceOutMs - c.sourceInMs;
              if (timelineDur > sourceDur + 50) {
                // Extend source to match timeline (1:1 playback)
                const fixed = { ...c, sourceOutMs: c.sourceInMs + timelineDur };
                console.log(`  ${c.trackId}: sourceOut ${c.sourceOutMs} → ${fixed.sourceOutMs} (+${timelineDur - sourceDur}ms)`);
                return fixed;
              }
              return c;
            });
            // Also fix the reel's sourceEndMs to match the corrected clips
            const maxSourceOut = Math.max(
              ...fixedClips
                .filter((c) => mainTrackIds.includes(c.trackId))
                .map((c) => c.sourceOutMs)
            );
            return {
              ...r,
              sourceEndMs: maxSourceOut > 0 ? maxSourceOut : r.sourceEndMs,
              composition: { ...r.composition, clips: fixedClips },
            };
          }),
          dirty: true,
        }));
      }
    }

    // Only recreate clips if none exist at all (first time entering timeline)
    const needsRecreate = existingClips.length === 0;

    // Count how many compose cuts fall inside this reel's window. Used both to
    // build segmented clips on first entry AND to detect a reel that was
    // created before compose-cut inheritance existed (a single rv1 clip when
    // compose actually has multiple clips in range → it's playing through the
    // cuts). Such reels get auto-resegmented on re-entry, but ONLY when their
    // main clips look auto-generated (haven't been hand-edited).
    const composeCutCount = (composeClips ?? []).filter(
      (c) => c.trackId === 'v1' && c.timelineEndMs > reel.startMs && c.timelineStartMs < reel.endMs
    ).length;

    const rv1Clips = existingClips.filter((c) => c.trackId === 'rv1');
    // "Looks auto-generated" = a single rv1 clip starting at reel-timeline 0
    // (i.e. the old single-span fallback). If the user split/moved clips
    // themselves there'd be >1 or a non-zero start, and we leave them alone.
    const looksUnsegmented = rv1Clips.length === 1 && rv1Clips[0].timelineStartMs === 0;

    // Does the reel's current single clip's transform match what compose would
    // give it now? Detects reels created before transform inheritance — e.g.
    // the user set a rotation/zoom in compose AFTER the reel was made, and the
    // reel's clip has no (or stale) transform. Compared loosely on the fields.
    const composeClipForReel = (composeClips ?? [])
      .filter((c) => c.trackId === 'v1' && c.timelineEndMs > reel.startMs && c.timelineStartMs < reel.endMs)
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0];
    const txEq = (a?: { scale?: number; x?: number; y?: number; rotation?: number }, b?: typeof a) => {
      const aS = a?.scale ?? 1, bS = b?.scale ?? 1;
      const aX = a?.x ?? 0, bX = b?.x ?? 0;
      const aY = a?.y ?? 0, bY = b?.y ?? 0;
      const aR = a?.rotation ?? 0, bR = b?.rotation ?? 0;
      return Math.abs(aS - bS) < 0.001 && Math.abs(aX - bX) < 0.001 && Math.abs(aY - bY) < 0.001 && Math.abs(aR - bR) < 0.001;
    };
    const transformDrifted = looksUnsegmented && !txEq(rv1Clips[0]?.transform, composeClipForReel?.transform);

    const shouldResegment = !needsRecreate && looksUnsegmented && !!composeClips &&
      (composeCutCount > 1 || transformDrifted);

    if ((needsRecreate || shouldResegment) && (videoFileName || audioFileName)) {
      const clips = buildReelMainClips({
        composeClips,
        reelStartMs: reel.startMs,
        reelEndMs: reel.endMs,
        reelDur,
        srcStart,
        srcEnd,
        videoFileName,
        audioFileName,
      }) ?? [];

      if (composeCutCount > 1) {
        console.log(`[reel-store] enterTimelinePhase: ${needsRecreate ? 'created' : 're-segmented'} reel honoring ${composeCutCount} compose clips → ${clips.length} reel clips`);
      }

      // First build only: carry the compose extra-audio layers (a2+) that
      // overlap the reel's range onto ra2 — on by default, opt-out via the
      // setup-view checkbox. A resegment keeps existing ra2 clips instead
      // (the set() below preserves non-main tracks), so no duplicates.
      let carriedExtra: CompositionClip[] = [];
      if (needsRecreate && (reel.includeComposeExtraAudio ?? true)) {
        carriedExtra = buildReelExtraAudioClips({
          composeClips,
          reelStartMs: reel.startMs,
          reelEndMs: reel.endMs,
        });
        if (carriedExtra.length > 0) {
          console.log(`[reel-store] enterTimelinePhase: carried ${carriedExtra.length} compose extra-audio clip(s) (ra2 / stem tracks)`);
          clips.push(...carriedExtra);
        }
      }

      // Subtitles filtered by COMPOSE time (baseSegments are in compose time).
      // Only regenerate subtitles on first creation — a re-segment must NOT
      // wipe the user's subtitle edits.
      const segments = needsRecreate
        ? filterSegmentsToRange(segmentsForReel(state, reel), reel.startMs, reel.endMs, reel.subtitleConstraints)
        : undefined;

      set((s) => ({
        reels: updateReelInList(s.reels, reelId, (r) => ({
          ...r,
          composition: {
            ...r.composition,
            tracks: tracksAfterCarry(r.composition.tracks, carriedExtra, composeTracks),
            // Keep non-main clips (cutaways, extra audio), replace main clips
            clips: [
              ...r.composition.clips.filter(
                (c) => c.trackId !== 'rv1' && c.trackId !== 'ra1'
              ),
              ...clips,
            ],
          },
          ...(segments ? { subtitleSegments: segments } : {}),
        })),
        dirty: true,
      }));
    }

    // Backfill a missing Main Audio track. Reels created while the project had
    // no resolvable audio file (e.g. partes projects, where selectedAudioPath/
    // mixedAudioPath are cleared and the old getAudioSrc returned undefined)
    // have rv1 clips but an EMPTY ra1 — the Main Audio track shows nothing and
    // gap-muting can't be edited. Mirror the rv1 clips onto ra1 (same timeline
    // + source ranges — the main audio always follows the video's cuts).
    // Skipped when recreate/resegment already rebuilt both tracks above.
    if (!needsRecreate && !shouldResegment && audioFileName) {
      const fresh = get().reels.find((r) => r.id === reelId);
      const freshClips = fresh?.composition.clips ?? [];
      const rv1 = freshClips.filter((c) => c.trackId === 'rv1');
      const ra1 = freshClips.filter((c) => c.trackId === 'ra1');
      if (rv1.length > 0 && ra1.length === 0) {
        const audioClips: CompositionClip[] = rv1
          .slice()
          .sort((a, b) => a.timelineStartMs - b.timelineStartMs)
          .map((vc) => ({
            id: uuidv4(),
            type: 'audio',
            fileName: audioFileName,
            originalName: audioFileName,
            trackId: 'ra1',
            timelineStartMs: vc.timelineStartMs,
            timelineEndMs: vc.timelineEndMs,
            sourceInMs: vc.sourceInMs,
            sourceOutMs: vc.sourceOutMs,
          }));
        console.log(`[reel-store] Backfilled ${audioClips.length} ra1 clip(s) mirroring rv1 (Main Audio was empty)`);
        set((s) => ({
          reels: updateReelInList(s.reels, reelId, (r) => ({
            ...r,
            composition: { ...r.composition, clips: [...r.composition.clips, ...audioClips] },
          })),
          dirty: true,
        }));
      }
    }

    // Backfill compose extra-audio (ra2) for reels whose timeline was built
    // BEFORE the compose extra layer existed (or before this feature). Only
    // when the reel has NO ra2 clips at all — so re-entering the timeline
    // never duplicates; to keep them out permanently, uncheck the setup-view
    // box (persists includeComposeExtraAudio=false).
    if (!needsRecreate && !shouldResegment && (reel.includeComposeExtraAudio ?? true)) {
      const fresh = get().reels.find((r) => r.id === reelId);
      const freshClips = fresh?.composition.clips ?? [];
      if (!freshClips.some((c) => c.trackId === 'ra2' || stemKindOfTrack(c.trackId))) {
        const extraClips = buildReelExtraAudioClips({
          composeClips,
          reelStartMs: reel.startMs,
          reelEndMs: reel.endMs,
        });
        if (extraClips.length > 0) {
          console.log(`[reel-store] Backfilled ${extraClips.length} compose extra-audio clip(s) (ra2 / stem tracks)`);
          set((s) => ({
            reels: updateReelInList(s.reels, reelId, (r) => ({
              ...r,
              composition: {
                ...r.composition,
                tracks: tracksAfterCarry(r.composition.tracks, extraClips, composeTracks),
                clips: [...r.composition.clips, ...extraClips],
              },
            })),
            dirty: true,
          }));
        }
      }
    }

    // Only reset viewport when entering for the first time (clips were created)
    if (needsRecreate) {
      const zoom = reelDur > 0 ? Math.max(0.01, Math.min(1, state.viewportWidthPx / reelDur)) : 0.1;
      set({
        phase: 'timeline',
        zoomLevel: zoom,
        scrollOffsetMs: 0,
        currentTimeMs: 0,
        isPlaying: false,
        selectedClipIds: [],
        selectedSubtitleIds: [],
      });
    } else {
      // Returning to timeline — preserve all state, just switch phase
      set({ phase: 'timeline', isPlaying: false });
    }
  },

  setZoom: (level) => set({ zoomLevel: Math.max(0.01, Math.min(1, level)) }),
  setScrollOffset: (ms) => set({ scrollOffsetMs: Math.max(0, ms) }),
  setViewportWidth: (px) => set({ viewportWidthPx: px }),
  selectSubtitle: (id, addToSelection) => {
    if (!id) {
      set({ selectedSubtitleIds: [] });
      return;
    }
    if (addToSelection) {
      const current = get().selectedSubtitleIds;
      if (current.includes(id)) {
        set({ selectedSubtitleIds: current.filter((s) => s !== id), selectedClipIds: [] });
      } else {
        set({ selectedSubtitleIds: [...current, id], selectedClipIds: [] });
      }
    } else {
      set({ selectedSubtitleIds: [id], selectedClipIds: [] });
    }
  },

  selectAllSubtitles: (reelId) => {
    const reel = get().reels.find((r) => r.id === reelId);
    if (!reel) return;
    set({ selectedSubtitleIds: reel.subtitleSegments.map((s) => s.id), selectedClipIds: [] });
  },

  selectSubtitlesFromPlayhead: (reelId, direction) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const t = state.currentTimeMs;
    const ids = reel.subtitleSegments
      .filter((s) => direction === 'left' ? s.endMs <= t : s.startMs >= t)
      .map((s) => s.id);
    set({ selectedSubtitleIds: ids, selectedClipIds: [] });
  },

  selectSubtitleRange: (reelId, id) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const sorted = [...reel.subtitleSegments].sort((a, b) => a.startMs - b.startMs);
    const clickedIdx = sorted.findIndex((s) => s.id === id);
    if (clickedIdx < 0) return;
    const selectedIdxs = state.selectedSubtitleIds
      .map((sid) => sorted.findIndex((s) => s.id === sid))
      .filter((i) => i >= 0);
    if (selectedIdxs.length === 0) {
      set({ selectedSubtitleIds: [id], selectedClipIds: [] });
      return;
    }
    // Span from the whole current selection to the clicked subtitle — so with
    // one selected, Shift+click far left/right grabs everything in between.
    const lo = Math.min(clickedIdx, ...selectedIdxs);
    const hi = Math.max(clickedIdx, ...selectedIdxs);
    set({
      selectedSubtitleIds: sorted.slice(lo, hi + 1).map((s) => s.id),
      selectedClipIds: [],
    });
  },

  fillSubtitleGapAtPlayhead: (reelId, original) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return { ok: false, added: 0, reason: 'Reel no encontrado' };
    const t = state.currentTimeMs;

    const covering = reel.subtitleSegments.find((s) => s.startMs <= t && t < s.endMs);
    if (covering) {
      return { ok: false, added: 0, reason: 'El playhead está sobre un subtítulo. Colócalo en el hueco vacío que quieres rellenar.' };
    }

    const videoClips = reel.composition.clips
      .filter((c) => c.trackId === 'rv1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const reelDurMs = videoClips.length > 0
      ? Math.max(...videoClips.map((c) => c.timelineEndMs))
      : reel.endMs - reel.startMs;

    // Gap bounds: previous subtitle end → next subtitle start (or reel edges).
    let gapStart = 0;
    let gapEnd = reelDurMs;
    for (const s of reel.subtitleSegments) {
      if (s.endMs <= t && s.endMs > gapStart) gapStart = s.endMs;
      if (s.startMs >= t && s.startMs < gapEnd) gapEnd = s.startMs;
    }

    const fresh = fillGapFromOriginal(
      original, videoClips, gapStart, gapEnd,
      reel.subtitleConstraints,
    );
    if (fresh.length === 0) {
      return { ok: false, added: 0, reason: 'La transcripción original no tiene texto en ese tramo.' };
    }

    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: [...r.subtitleSegments, ...fresh].sort((a, b) => a.startMs - b.startMs),
      })),
      selectedSubtitleIds: fresh.map((f) => f.id),
      selectedClipIds: [],
      dirty: true,
    }));
    return { ok: true, added: fresh.length };
  },

  moveSelectedSubtitles: (reelId, deltaMs) => {
    const state = get();
    const ids = new Set(state.selectedSubtitleIds);
    if (ids.size === 0) return;
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: r.subtitleSegments.map((seg) =>
          ids.has(seg.id)
            ? {
                ...seg,
                startMs: Math.max(0, seg.startMs + deltaMs),
                endMs: Math.max(0, seg.endMs + deltaMs),
                words: seg.words?.map((w) => ({
                  ...w,
                  startMs: Math.max(0, w.startMs + deltaMs),
                  endMs: Math.max(0, w.endMs + deltaMs),
                })),
              }
            : seg
        ),
      })),
      dirty: true,
    }));
  },

  deleteSubtitleSegment: (reelId, segId) => {
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: r.subtitleSegments.filter((seg) => seg.id !== segId),
      })),
      selectedSubtitleIds: s.selectedSubtitleIds.filter((id) => id !== segId),
      dirty: true,
    }));
  },

  deleteSelected: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    if (state.selectedClipIds.length > 0) {
      const selectedSet = new Set(state.selectedClipIds);
      set((s) => ({
        reels: updateReelInList(s.reels, reelId, (r) => ({
          ...r,
          composition: {
            ...r.composition,
            clips: r.composition.clips.filter((c) => !selectedSet.has(c.id)),
          },
        })),
        selectedClipIds: [],
        dirty: true,
      }));
    } else if (state.selectedSubtitleIds.length > 0) {
      // Delete all selected subtitle segments
      const idsToDelete = new Set(state.selectedSubtitleIds);
      set((s) => ({
        reels: updateReelInList(s.reels, reelId, (r) => ({
          ...r,
          subtitleSegments: r.subtitleSegments.filter((seg) => !idsToDelete.has(seg.id)),
        })),
        selectedSubtitleIds: [],
        dirty: true,
      }));
    }
  },

  splitAllAtPlayhead: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const t = state.currentTimeMs;

    const newClips: CompositionClip[] = [];
    for (const clip of reel.composition.clips) {
      if (t > clip.timelineStartMs + MIN_SPLIT_PIECE_MS && t < clip.timelineEndMs - MIN_SPLIT_PIECE_MS) {
        const sourceOffset = t - clip.timelineStartMs;
        const splitSourceMs = clip.sourceInMs + sourceOffset;
        newClips.push(
          { ...clip, id: uuidv4(), timelineEndMs: t, sourceOutMs: splitSourceMs },
          { ...clip, id: uuidv4(), timelineStartMs: t, sourceInMs: splitSourceMs },
        );
      } else {
        newClips.push(clip);
      }
    }

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: newClips },
      })),
      selectedClipIds: [],
      dirty: true,
    }));
  },

  rippleDeleteSelected: (reelId) => {
    const state = get();
    if (state.selectedClipIds.length === 0) return;
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;

    const selectedClips = reel.composition.clips
      .filter((c) => state.selectedClipIds.includes(c.id));

    if (selectedClips.length === 0) return;

    set(pushUndo(get()));

    // Remove all selected clips
    let remainingClips = reel.composition.clips.filter(
      (c) => !state.selectedClipIds.includes(c.id)
    );
    let segments = [...reel.subtitleSegments];
    let cropKfs = reel.cropKeyframes;

    // Deduplicate gap ranges: multiple clips on different tracks at the same
    // time range should only cause ONE shift. Merge overlapping ranges.
    const rawGaps = selectedClips
      .map((c) => ({ start: c.timelineStartMs, end: c.timelineEndMs }))
      .sort((a, b) => a.start - b.start);

    const mergedGaps: { start: number; end: number }[] = [];
    for (const g of rawGaps) {
      const last = mergedGaps[mergedGaps.length - 1];
      if (last && g.start <= last.end) {
        last.end = Math.max(last.end, g.end);
      } else {
        mergedGaps.push({ ...g });
      }
    }

    // Process gaps from rightmost to leftmost so earlier positions stay valid.
    for (let gi = mergedGaps.length - 1; gi >= 0; gi--) {
      const gapStart = mergedGaps[gi].start;
      const gapEnd = mergedGaps[gi].end;
      const gapDuration = gapEnd - gapStart;

      // Shift clips that start at or after gapEnd
      remainingClips = remainingClips.map((c) => {
        if (c.timelineStartMs >= gapEnd) {
          return {
            ...c,
            timelineStartMs: c.timelineStartMs - gapDuration,
            timelineEndMs: c.timelineEndMs - gapDuration,
          };
        }
        return c;
      });

      // Shift/trim/remove subtitles
      segments = segments.map((seg) => {
        // Entirely after gap → shift back
        if (seg.startMs >= gapEnd) {
          return {
            ...seg,
            startMs: seg.startMs - gapDuration,
            endMs: seg.endMs - gapDuration,
            words: seg.words?.map((w) => ({
              ...w,
              startMs: w.startMs - gapDuration,
              endMs: w.endMs - gapDuration,
            })),
          };
        }
        // Overlaps with gap
        if (seg.endMs > gapStart && seg.startMs < gapEnd) {
          // Entirely within gap → remove
          if (seg.startMs >= gapStart && seg.endMs <= gapEnd) return null;
          // Starts before gap, ends within → trim end
          if (seg.startMs < gapStart && seg.endMs <= gapEnd) {
            return {
              ...seg,
              endMs: gapStart,
              words: seg.words?.filter((w) => w.startMs < gapStart),
            };
          }
          // Starts within gap, extends past → trim start and shift
          if (seg.startMs >= gapStart && seg.endMs > gapEnd) {
            return {
              ...seg,
              startMs: gapStart,
              endMs: seg.endMs - gapDuration,
              words: seg.words
                ?.filter((w) => w.endMs > gapEnd)
                .map((w) => ({
                  ...w,
                  startMs: Math.max(gapStart, w.startMs - gapDuration),
                  endMs: w.endMs - gapDuration,
                })),
            };
          }
          // Spans entire gap (starts before, ends after) → shrink by gap
          return {
            ...seg,
            endMs: seg.endMs - gapDuration,
            words: seg.words
              ?.filter((w) => w.endMs <= gapStart || w.startMs >= gapEnd)
              .map((w) => {
                if (w.startMs >= gapEnd) {
                  return { ...w, startMs: w.startMs - gapDuration, endMs: w.endMs - gapDuration };
                }
                return w;
              }),
          };
        }
        return seg;
      }).filter(Boolean) as typeof segments;

      // Crop keyframes ripple like subtitles: drop the ones inside the gap,
      // shift later ones left with the content.
      cropKfs = rippleDeleteCropKeyframes(cropKfs, gapStart, gapEnd);
    }

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: remainingClips },
        subtitleSegments: segments,
        cropKeyframes: cropKfs,
      })),
      selectedClipIds: [],
      dirty: true,
    }));
  },

  collapseGapAtPlayhead: (reelId) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;

    const t = state.currentTimeMs;
    const allClips = reel.composition.clips;
    if (allClips.length === 0) return;

    // Collect per-track gap boundaries at playhead.
    // Only tracks that have a gap at playhead contribute.
    const trackIdSet: Record<string, boolean> = {};
    allClips.forEach((c) => { trackIdSet[c.trackId] = true; });
    const trackIds = Object.keys(trackIdSet);

    let narrowestStart = 0;
    let narrowestEnd = Infinity;
    let anyTrackHasGap = false;

    for (const tid of trackIds) {
      const trackClips = allClips
        .filter((c) => c.trackId === tid)
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

      // If a clip covers playhead on this track, skip — no gap here
      const clipAtT = trackClips.find((c) => t >= c.timelineStartMs && t < c.timelineEndMs);
      if (clipAtT) continue;

      // Find gap boundaries on this track
      let gapStart = 0;
      let gapEnd = Infinity;

      for (const c of trackClips) {
        if (c.timelineEndMs <= t) {
          gapStart = Math.max(gapStart, c.timelineEndMs);
        }
        if (c.timelineStartMs > t) {
          gapEnd = Math.min(gapEnd, c.timelineStartMs);
          break;
        }
      }

      if (gapEnd <= gapStart) continue;

      anyTrackHasGap = true;
      // Use the narrowest gap across all tracks so clips don't overlap
      narrowestStart = Math.max(narrowestStart, gapStart);
      narrowestEnd = Math.min(narrowestEnd, gapEnd);
    }

    if (!anyTrackHasGap || narrowestEnd <= narrowestStart) return;

    // Now push undo only after confirming there's a gap to close
    set(pushUndo(get()));

    const gapDuration = narrowestEnd - narrowestStart;

    // Shift ALL clips on ALL tracks that start >= gapEnd
    const shiftedClips = allClips.map((c) => {
      if (c.timelineStartMs >= narrowestEnd) {
        return {
          ...c,
          timelineStartMs: c.timelineStartMs - gapDuration,
          timelineEndMs: c.timelineEndMs - gapDuration,
        };
      }
      return c;
    });

    // Shift subtitles
    const shiftedSegments = reel.subtitleSegments.map((seg) => {
      if (seg.startMs >= narrowestEnd) {
        return { ...seg, startMs: seg.startMs - gapDuration, endMs: seg.endMs - gapDuration };
      }
      if (seg.endMs > narrowestStart && seg.startMs < narrowestEnd) {
        if (seg.startMs >= narrowestStart) return null;
        return { ...seg, endMs: narrowestStart };
      }
      return seg;
    }).filter(Boolean) as typeof reel.subtitleSegments;

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: shiftedClips },
        subtitleSegments: shiftedSegments,
        cropKeyframes: rippleDeleteCropKeyframes(r.cropKeyframes, narrowestStart, narrowestEnd),
      })),
      dirty: true,
    }));
  },

  clearTimeline: (reelId) => {
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: [] },
      })),
      selectedClipIds: [],
      selectedSubtitleIds: [],
      dirty: true,
    }));
  },

  copySelectedClips: (reelId) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const selected = reel.composition.clips.filter((c) => state.selectedClipIds.includes(c.id));
    if (selected.length === 0) return;
    const earliest = Math.min(...selected.map((c) => c.timelineStartMs));
    reelClipboard = selected.map((c) => ({
      trackId: c.trackId,
      offsetMs: c.timelineStartMs - earliest,
      clip: JSON.parse(JSON.stringify(c)) as CompositionClip,
    }));
    // Capture the subtitles inside the copied span (clamped) so a ripple
    // insert can bring them along with the clips.
    const spanEnd = Math.max(...selected.map((c) => c.timelineEndMs));
    reelAttachedSubs = reel.subtitleSegments
      .filter((s) => s.endMs > earliest && s.startMs < spanEnd)
      .sort((a, b) => a.startMs - b.startMs)
      .map((s) => {
        const seg = clampSegmentToBounds(JSON.parse(JSON.stringify(s)) as SubtitleSegment, earliest, spanEnd);
        return { offsetMs: seg.startMs - earliest, seg };
      });
  },

  pasteClips: (reelId, atEnd, atMs, skipUndo) => {
    if (reelClipboard.length === 0) return;
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    // atEnd ("detrás") appends after the reel's current content; otherwise
    // paste at the playhead. atMs (from pasteSelection) wins over both — it's
    // computed BEFORE anything is inserted so clips and subtitles align.
    const contentEnd = Math.max(
      reel.composition.clips.reduce((m, c) => Math.max(m, c.timelineEndMs), 0),
      reel.subtitleSegments.reduce((m, s) => Math.max(m, s.endMs), 0)
    );
    const pasteAt = atMs != null ? atMs : atEnd ? contentEnd : state.currentTimeMs;
    if (!skipUndo) set(pushUndo(get()));
    const newClips: CompositionClip[] = reelClipboard.map((entry) => {
      const dur = entry.clip.timelineEndMs - entry.clip.timelineStartMs;
      const startMs = pasteAt + entry.offsetMs;
      return {
        ...JSON.parse(JSON.stringify(entry.clip)),
        id: uuidv4(),
        trackId: resolvePasteTrackId(entry.clip, reel.composition.tracks, state.activeTrackId),
        timelineStartMs: startMs,
        timelineEndMs: startMs + dur,
      } as CompositionClip;
    });
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: [...r.composition.clips, ...newClips] },
      })),
      selectedClipIds: newClips.map((c) => c.id),
      selectedSubtitleIds: [],
      dirty: true,
    }));
  },

  canPasteClips: () => reelClipboard.length > 0,

  copySelectedSubtitles: (reelId) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const selected = reel.subtitleSegments.filter((s) => state.selectedSubtitleIds.includes(s.id));
    if (selected.length === 0) return;
    const earliest = Math.min(...selected.map((s) => s.startMs));
    reelSubtitleClipboard = selected
      .sort((a, b) => a.startMs - b.startMs)
      .map((s) => ({ offsetMs: s.startMs - earliest, seg: JSON.parse(JSON.stringify(s)) as SubtitleSegment }));
  },

  pasteSubtitles: (reelId, atEnd, atMs, skipUndo) => {
    if (reelSubtitleClipboard.length === 0) return;
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    // Shared content-end (clips + subtitles); atMs from pasteSelection wins —
    // it's computed before the clips were inserted, so subs align with them.
    const contentEnd = Math.max(
      reel.composition.clips.reduce((m, c) => Math.max(m, c.timelineEndMs), 0),
      reel.subtitleSegments.reduce((m, s) => Math.max(m, s.endMs), 0)
    );
    const pasteAt = atMs != null ? atMs : atEnd ? contentEnd : state.currentTimeMs;
    if (!skipUndo) set(pushUndo(get()));
    const newSegs: SubtitleSegment[] = reelSubtitleClipboard.map((entry) => {
      const seg = JSON.parse(JSON.stringify(entry.seg)) as SubtitleSegment;
      const dur = seg.endMs - seg.startMs;
      const start = pasteAt + entry.offsetMs;
      const shift = start - seg.startMs;
      return {
        ...seg,
        id: uuidv4(),
        startMs: start,
        endMs: start + dur,
        words: seg.words?.map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift })),
      };
    });
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: [...r.subtitleSegments, ...newSegs].sort((a, b) => a.startMs - b.startMs),
      })),
      selectedSubtitleIds: newSegs.map((s) => s.id),
      selectedClipIds: [],
      dirty: true,
    }));
  },

  canPasteSubtitles: () => reelSubtitleClipboard.length > 0,

  copySelection: (reelId) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    // Selection is exclusive (clips XOR subtitles). Each copy REPLACES both
    // clipboards so paste always reproduces exactly the last copy:
    // - Clips selected → copy the clips AND the subtitle segments that overlap
    //   their time range (audio+video+subs travel together in one Ctrl+C).
    // - Subtitles selected → copy just those; clear the clip clipboard.
    if (state.selectedClipIds.length > 0) {
      get().copySelectedClips(reelId);
      const selected = reel.composition.clips.filter((c) => state.selectedClipIds.includes(c.id));
      const rangeStart = Math.min(...selected.map((c) => c.timelineStartMs));
      const rangeEnd = Math.max(...selected.map((c) => c.timelineEndMs));
      reelSubtitleClipboard = reel.subtitleSegments
        .filter((s) => s.endMs > rangeStart && s.startMs < rangeEnd)
        .sort((a, b) => a.startMs - b.startMs)
        .map((s) => ({
          // Same origin as the clip clipboard (rangeStart) so clips and subs
          // land aligned on paste. Clamp: a sub that starts a hair before the
          // first clip pastes at the paste point, not before it.
          offsetMs: Math.max(0, s.startMs - rangeStart),
          seg: JSON.parse(JSON.stringify(s)) as SubtitleSegment,
        }));
    } else if (state.selectedSubtitleIds.length > 0) {
      get().copySelectedSubtitles(reelId);
      reelClipboard = [];
    }
  },

  pasteSelection: (reelId, atEnd) => {
    if (reelClipboard.length === 0 && reelSubtitleClipboard.length === 0) return;
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    // Compute the paste point ONCE, before inserting anything — otherwise the
    // subtitle paste would see the just-pasted clips as "content" and land
    // after them instead of aligned with them.
    const contentEnd = Math.max(
      reel.composition.clips.reduce((m, c) => Math.max(m, c.timelineEndMs), 0),
      reel.subtitleSegments.reduce((m, s) => Math.max(m, s.endMs), 0)
    );
    const pasteAt = atEnd ? contentEnd : state.currentTimeMs;
    // One undo entry for the combined paste (clips + subs revert together).
    set(pushUndo(get()));
    get().pasteClips(reelId, atEnd, pasteAt, true);
    get().pasteSubtitles(reelId, atEnd, pasteAt, true);
  },

  rippleInsertAtPlayhead: (reelId) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const hasClips = reelClipboard.length > 0;
    if (!hasClips && reelSubtitleClipboard.length === 0) return;
    const T = state.currentTimeMs;

    // Span of the inserted material = everything shifts right by this much.
    const D = hasClips
      ? Math.max(...reelClipboard.map((e) => e.offsetMs + (e.clip.timelineEndMs - e.clip.timelineStartMs)))
      : Math.max(...reelSubtitleClipboard.map((e) => e.offsetMs + (e.seg.endMs - e.seg.startMs)));
    if (!(D > 0)) return;

    set(pushUndo(get()));

    // 1) Split clips straddling T so their right halves can shift cleanly
    //    (same math as splitAllAtPlayhead). The left half drops any
    //    transition — it now cuts into the inserted material.
    const splitClips: CompositionClip[] = [];
    for (const c of reel.composition.clips) {
      if (hasClips && T > c.timelineStartMs && T < c.timelineEndMs) {
        const off = T - c.timelineStartMs;
        const splitSrc = c.sourceInMs + off;
        splitClips.push(
          { ...c, id: uuidv4(), timelineEndMs: T, sourceOutMs: splitSrc, transitionAfter: undefined },
          { ...c, id: uuidv4(), timelineStartMs: T, sourceInMs: splitSrc },
        );
      } else {
        splitClips.push(c);
      }
    }

    // 2) Ripple: shift clips and subtitles at/after T right by D. A subtitle
    //    straddling T stays put (it belongs to the material before the cut).
    const shiftedClips = hasClips
      ? splitClips.map((c) => c.timelineStartMs >= T
          ? { ...c, timelineStartMs: c.timelineStartMs + D, timelineEndMs: c.timelineEndMs + D }
          : c)
      : splitClips;
    const shiftedSubs = reel.subtitleSegments.map((s) => s.startMs >= T
      ? { ...s, startMs: s.startMs + D, endMs: s.endMs + D, words: s.words?.map((w) => ({ ...w, startMs: w.startMs + D, endMs: w.endMs + D })) }
      : s);

    // 3) Insert the clipboard clips at T, on the active track when it takes
    //    them (same rule as Ctrl+V — the two must not disagree).
    const newClips: CompositionClip[] = hasClips
      ? reelClipboard.map((entry) => {
          const dur = entry.clip.timelineEndMs - entry.clip.timelineStartMs;
          const startMs = T + entry.offsetMs;
          return {
            ...JSON.parse(JSON.stringify(entry.clip)),
            id: uuidv4(),
            trackId: resolvePasteTrackId(entry.clip, reel.composition.tracks, state.activeTrackId),
            timelineStartMs: startMs,
            timelineEndMs: startMs + dur,
          } as CompositionClip;
        })
      : [];

    // 4) Insert the subtitles that came with the copied span (or the subtitle
    //    clipboard itself for a subtitle-only insert).
    const subSource = hasClips ? reelAttachedSubs : reelSubtitleClipboard;
    const newSegs: SubtitleSegment[] = subSource.map((entry) => {
      const seg = JSON.parse(JSON.stringify(entry.seg)) as SubtitleSegment;
      const dur = seg.endMs - seg.startMs;
      const start = T + entry.offsetMs;
      const shift = start - seg.startMs;
      return {
        ...seg,
        id: uuidv4(),
        startMs: start,
        endMs: start + dur,
        words: seg.words?.map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift })),
      };
    });

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: [...shiftedClips, ...newClips] },
        subtitleSegments: [...shiftedSubs, ...newSegs].sort((a, b) => a.startMs - b.startMs),
        // Keyframes ripple right with the content (only when clips shifted).
        cropKeyframes: hasClips ? rippleShiftCropKeyframes(r.cropKeyframes, T, D) : r.cropKeyframes,
      })),
      selectedClipIds: newClips.map((c) => c.id),
      selectedSubtitleIds: newClips.length > 0 ? [] : newSegs.map((sg) => sg.id),
      dirty: true,
    }));
  },

  syncSubtitlesToClips: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;

    // Get video clips sorted by timeline position
    const videoClips = reel.composition.clips
      .filter((c) => c.trackId === 'rv1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

    if (videoClips.length === 0) return;

    // Remove subtitles that fall in gaps (where no video clip exists)
    // and trim subtitles that partially overlap clip boundaries
    const synced = reel.subtitleSegments
      .map((seg) => {
        // Find if this subtitle overlaps any clip
        for (const clip of videoClips) {
          if (seg.startMs >= clip.timelineStartMs && seg.endMs <= clip.timelineEndMs) {
            // Fully inside a clip — keep as is
            return seg;
          }
          if (seg.startMs < clip.timelineEndMs && seg.endMs > clip.timelineStartMs) {
            // Partially overlaps — trim to clip boundaries
            return {
              ...seg,
              startMs: Math.max(seg.startMs, clip.timelineStartMs),
              endMs: Math.min(seg.endMs, clip.timelineEndMs),
            };
          }
        }
        // No overlap with any clip — remove
        return null;
      })
      .filter((s): s is SubtitleSegment => s !== null && (s.endMs - s.startMs) > 100);

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: synced,
      })),
      dirty: true,
    }));
  },

  resetTimeline: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;

    // Clear clips and regenerate subtitles from compose time range
    const segments = filterSegmentsToRange(segmentsForReel(state, reel), reel.startMs, reel.endMs, reel.subtitleConstraints);
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: [] },
        subtitleSegments: segments,
      })),
      selectedClipIds: [],
      selectedSubtitleIds: [],
      phase: 'setup',
      dirty: true,
    }));
  },

  msToPixel: (ms) => {
    const s = get();
    return (ms - s.scrollOffsetMs) * s.zoomLevel;
  },

  pixelToMs: (px) => {
    const s = get();
    return px / s.zoomLevel + s.scrollOffsetMs;
  },

  saveSnapshot: () => {
    const state = get();
    set(pushUndo(state));
  },

  undo: (reelId) => {
    const state = get();
    if (state.undoStack.length === 0) return;
    const entry = state.undoStack[state.undoStack.length - 1];
    // Save current state to redo
    const currentReel = state.reels.find((r) => r.id === reelId);
    if (!currentReel) return;
    const redoEntry: UndoEntry = {
      reel: JSON.parse(JSON.stringify(currentReel)),
      selectedClipIds: [...state.selectedClipIds],
      selectedSubtitleIds: [...state.selectedSubtitleIds],
    };
    set({
      reels: state.reels.map((r) => r.id === entry.reel.id ? entry.reel : r),
      selectedClipIds: entry.selectedClipIds,
      selectedSubtitleIds: entry.selectedSubtitleIds,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, redoEntry],
      dirty: true,
    });
  },

  redo: (reelId) => {
    const state = get();
    if (state.redoStack.length === 0) return;
    const entry = state.redoStack[state.redoStack.length - 1];
    const currentReel = state.reels.find((r) => r.id === reelId);
    if (!currentReel) return;
    const undoEntry: UndoEntry = {
      reel: JSON.parse(JSON.stringify(currentReel)),
      selectedClipIds: [...state.selectedClipIds],
      selectedSubtitleIds: [...state.selectedSubtitleIds],
    };
    set({
      reels: state.reels.map((r) => r.id === entry.reel.id ? entry.reel : r),
      selectedClipIds: entry.selectedClipIds,
      selectedSubtitleIds: entry.selectedSubtitleIds,
      undoStack: [...state.undoStack, undoEntry],
      redoStack: state.redoStack.slice(0, -1),
      dirty: true,
    });
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  // Versions (persistent named snapshots)
  saveVersion: (reelId, label) => {
    const reel = get().reels.find((r) => r.id === reelId);
    if (!reel) return;
    const version: ReelVersion = {
      id: uuidv4(),
      label,
      createdAt: new Date().toISOString(),
      clips: JSON.parse(JSON.stringify(reel.composition.clips)),
      subtitleSegments: JSON.parse(JSON.stringify(reel.subtitleSegments)),
      subtitleStyle: JSON.parse(JSON.stringify(reel.subtitleStyle)),
      cropRegion: JSON.parse(JSON.stringify(reel.cropRegion)),
      cropKeyframes: reel.cropKeyframes ? JSON.parse(JSON.stringify(reel.cropKeyframes)) : undefined,
    };
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        versions: [...(r.versions ?? []), version],
      })),
      dirty: true,
    }));
  },

  restoreVersion: (reelId, versionId) => {
    set(pushUndo(get()));
    const reel = get().reels.find((r) => r.id === reelId);
    if (!reel) return;
    const version = (reel.versions ?? []).find((v) => v.id === versionId);
    if (!version) return;
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: JSON.parse(JSON.stringify(version.clips)) },
        subtitleSegments: JSON.parse(JSON.stringify(version.subtitleSegments)),
        subtitleStyle: JSON.parse(JSON.stringify(version.subtitleStyle)),
        // Older versions predate crop snapshots — keep the current framing then.
        cropRegion: version.cropRegion ? JSON.parse(JSON.stringify(version.cropRegion)) : r.cropRegion,
        cropKeyframes: version.cropRegion
          ? (version.cropKeyframes ? JSON.parse(JSON.stringify(version.cropKeyframes)) : undefined)
          : r.cropKeyframes,
      })),
      selectedClipIds: [],
      selectedSubtitleIds: [],
      dirty: true,
    }));
  },

  deleteVersion: (reelId, versionId) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        versions: (r.versions ?? []).filter((v) => v.id !== versionId),
      })),
      dirty: true,
    }));
  },

  setCurrentTime: (ms) => set({ currentTimeMs: Math.max(0, ms) }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),

  getActiveReel: () => {
    const s = get();
    return s.reels.find((r) => r.id === s.activeReelId);
  },
}));
