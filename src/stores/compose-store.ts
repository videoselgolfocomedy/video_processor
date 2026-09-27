'use client';

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { splitLongSegments, clampSegmentToBounds, styleWholeSegment, fillGapFromOriginal, type SegmentStyleUpdate } from '@/lib/subtitle-utils';
import { STYLE_PRESETS, DEFAULT_CONSTRAINTS } from '@/config/subtitle-styles';
import { STEM_TRACK_IDS, buildStemClipsForWindow, ensureStemTracks, hasStemTracks, type StemSegment } from '@/lib/audio-stems';
import { resolvePasteTrackId } from '@/lib/track-compat';
/** A split never leaves a piece shorter than this. The playhead moves in
 *  fractional frame steps (75666.666…), so splitting twice at "the same"
 *  point produced a 1.5e-11 ms clip that FFmpeg rejects at export
 *  ("Invalid duration specification for t: 1.45e-14"). */
const MIN_SPLIT_PIECE_MS = 10;
import type { ComposeVersion } from '@/types/project';
import type {
  CompositionClip,
  CompositionTrack,
  MediaBinAsset,
  CompositionState,
  CompositionAspect,
  SubtitleSegment,
  SubtitleStyle,
  SubtitleConstraints,
} from '@/types/project';

export type DragType = 'move' | 'trim-in' | 'trim-out' | 'add-from-bin';

export interface DragState {
  type: DragType;
  clipId?: string;
  assetId?: string;
  trackId?: string;
  originMs: number;
  offsetMs: number; // mouse offset from clip start
}

// The type lives in types/project.ts (reels read the versions too); kept
// re-exported here for the existing importers.
export type { ComposeVersion };

// Module-level clipboard for copy/paste of compose clips. Lives outside the
// store so it survives store resets and isn't serialized into project.json.
// Each entry keeps its trackId and a timeline offset relative to the earliest
// copied clip, so a multi-clip paste preserves the layout starting at the
// playhead.
let composeClipboard: { trackId: string; offsetMs: number; clip: CompositionClip }[] = [];
// Subtitles that lived inside the span of the last clip copy (clamped to it).
// Used by rippleInsertAtPlayhead so an inserted piece brings its subs along —
// plain paste ignores this, so its behavior is unchanged.
let composeAttachedSubs: { offsetMs: number; seg: SubtitleSegment }[] = [];

interface ComposeUndoEntry {
  clips: CompositionClip[];
  subtitleSegments: SubtitleSegment[];
  selectedClipIds: string[];
  selectedSubtitleIds: string[];
}

const MAX_UNDO = 50;

const PROTECTED_TRACK_IDS = new Set(['v1', 'a1', 's1']);

const defaultComposeStyle = STYLE_PRESETS.find((p) => p.id === 'youtube-classic')!.style;

/** Split any subtitle segment that spans the given time point into two parts */
function splitSubtitlesAtTime(segments: SubtitleSegment[], timeMs: number): SubtitleSegment[] {
  const result: SubtitleSegment[] = [];
  for (const seg of segments) {
    if (timeMs > seg.startMs && timeMs < seg.endMs) {
      const totalDur = seg.endMs - seg.startMs;
      const splitRatio = (timeMs - seg.startMs) / totalDur;

      // Only trust words[] when it matches the TEXT token-for-token. A drifted
      // words array (e.g. an edge word dropped by a defensive clamp while the
      // text kept it) would silently LOSE words when the halves' text is
      // rebuilt from words — the "última palabra desaparece al dividir" bug.
      const textTokens = seg.text.split(/\s+/).filter(Boolean);
      const wordsMatchText = !!seg.words && seg.words.length === textTokens.length;

      if (seg.words && seg.words.length > 0 && wordsMatchText) {
        let splitWordIdx = 0;
        for (let i = 0; i < seg.words.length; i++) {
          if (seg.words[i].startMs >= timeMs) { splitWordIdx = i; break; }
          splitWordIdx = i + 1;
        }
        splitWordIdx = Math.max(1, Math.min(seg.words.length - 1, splitWordIdx));

        const leftWords = seg.words.slice(0, splitWordIdx);
        const rightWords = seg.words.slice(splitWordIdx);

        result.push({
          ...seg, id: uuidv4(), endMs: timeMs,
          text: leftWords.map((w) => w.text).join(' '),
          words: leftWords,
        });
        result.push({
          ...seg, id: uuidv4(), startMs: timeMs,
          text: rightWords.map((w) => w.text).join(' '),
          words: rightWords,
        });
      } else {
        const text = seg.text;
        const approxCharIdx = Math.round(text.length * splitRatio);
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
          result.push(seg);
        }
      }
    } else {
      result.push(seg);
    }
  }
  return result;
}

interface ComposeStore {
  // Viewport
  zoomLevel: number;
  scrollOffsetMs: number;
  viewportWidthPx: number;

  // Playback
  currentTimeMs: number;
  isPlaying: boolean;
  durationMs: number;

  // Selection (multi-select)
  selectedClipIds: string[];
  selectedSubtitleIds: string[];

  // Drag
  dragState: DragState | null;
  // Track a clip is being dragged over (cross-track vertical drag) — for highlight.
  dragTargetTrackId: string | null;
  /** Last track the user clicked (or whose clip they selected). Paste targets it
   *  when the type fits. UI state: never persisted, never in an undo entry. */
  activeTrackId: string | null;
  setActiveTrackId: (trackId: string | null) => void;

  // Data
  tracks: CompositionTrack[];
  clips: CompositionClip[];
  mediaBin: MediaBinAsset[];

  // Composition format
  aspectRatio: CompositionAspect;
  // Letterbox/pillarbox fill color behind the video (default black)
  backgroundColor: string;

  // Subtitles
  subtitleSegments: SubtitleSegment[];
  subtitleStyle: SubtitleStyle;
  subtitleStylePreset: string;
  subtitleConstraints: SubtitleConstraints;

  // Versions
  versions: ComposeVersion[];

  // Undo/Redo
  undoStack: ComposeUndoEntry[];
  redoStack: ComposeUndoEntry[];

  // Dirty tracking
  dirty: boolean;

  // --- Actions ---

  // Viewport
  setZoom: (level: number) => void;
  setScrollOffset: (ms: number) => void;
  setViewportWidth: (px: number) => void;

  // Playback
  setCurrentTime: (ms: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setDuration: (ms: number) => void;

  // Selection
  selectClip: (id: string | null, addToSelection?: boolean) => void;
  selectSubtitle: (id: string | null, addToSelection?: boolean) => void;
  selectAllSubtitles: () => void;
  selectSubtitlesFromPlayhead: (direction: 'left' | 'right') => void;
  /** Shift+click: select the contiguous run of subtitles between the current
   *  selection and the clicked one (inclusive). No selection → just clicked. */
  selectSubtitleRange: (id: string) => void;

  // Drag
  setDragState: (state: DragState | null) => void;
  setDragTargetTrackId: (trackId: string | null) => void;

  // Clips
  addClip: (clip: Omit<CompositionClip, 'id'>) => string;
  updateClip: (id: string, updates: Partial<CompositionClip>) => void;
  removeClip: (id: string) => void;
  moveClip: (id: string, newStartMs: number, newTrackId?: string) => void;
  moveSelectedClips: (deltaMs: number) => void;
  trimClip: (id: string, edge: 'in' | 'out', newMs: number) => void;
  splitClipAtPlayhead: () => void;
  splitAllAtPlayhead: () => void;
  deleteSelected: () => void;
  rippleDeleteSelected: () => void;
  collapseGapAtPlayhead: () => void;
  closeGapForSelected: () => void;
  clearTimeline: () => void;
  copySelectedClips: () => void;
  pasteClips: () => void;
  canPasteClips: () => boolean;
  /** Premiere-style INSERT paste (Ctrl+Shift+V): splits clips straddling the
   *  playhead, shifts everything at/after it right by the pasted span, and
   *  inserts the clipboard clips WITH the subtitles captured in their span. */
  rippleInsertAtPlayhead: () => void;

  // Tracks
  addTrack: (type: CompositionTrack['type'], label: string) => string;
  removeTrack: (trackId: string) => void;
  toggleTrackMute: (id: string) => void;
  toggleTrackLock: (id: string) => void;
  toggleTrackVisible: (id: string) => void;
  /** "Mesa y ambiente como pistas separadas": put every part's processed
   *  stems on the a_mesa / a_amb tracks (created after a1) and MUTE a1 (the
   *  baked mix) — one undo entry. */
  applyStemTracks: (layout: StemSegment[], mainAudioFileName?: string, mainAudioOffsetMs?: number) => void;
  /** Back to the single mix: drop the stem tracks (+ clips) and unmute a1. */
  removeStemTracks: () => void;
  stemTracksActive: () => boolean;

  // Media bin
  addToBin: (asset: MediaBinAsset) => void;
  removeFromBin: (id: string) => void;

  // Subtitles
  setSubtitleSegments: (segments: SubtitleSegment[]) => void;
  updateSubtitleSegment: (id: string, updates: Partial<SubtitleSegment>) => void;
  styleSelectedSubtitles: (update: SegmentStyleUpdate) => void;
  moveSelectedSubtitles: (deltaMs: number) => void;
  deleteSubtitleSegment: (segId: string) => void;
  splitSubtitleAtPlayhead: () => void;
  addSubtitleSegment: () => void;
  syncSubtitlesToClips: () => void;
  regenerateSubtitles: () => void;
  /** Rebuild subtitles for the empty stretch under the playhead from the
   *  ORIGINAL transcription (source time), remapped to the edited timeline. */
  fillSubtitleGapAtPlayhead: (original: SubtitleSegment[]) => { ok: boolean; added: number; reason?: string };

  // Composition format
  setAspectRatio: (ratio: CompositionAspect) => void;
  setBackgroundColor: (color: string) => void;

  // Style
  setSubtitleStyle: (style: SubtitleStyle) => void;
  setSubtitlePreset: (presetId: string, style: SubtitleStyle) => void;
  setSubtitleConstraints: (constraints: SubtitleConstraints) => void;

  // Versions
  saveVersion: (label: string) => void;
  restoreVersion: (id: string) => void;
  deleteVersion: (id: string) => void;

  // Undo/Redo
  saveSnapshot: () => void;
  pushUndo: () => void;
  undo: () => void;
  redo: () => void;

  // Persistence
  loadComposition: (
    state: CompositionState,
    subtitles: SubtitleSegment[],
    durationMs: number,
    subtitleStyle?: SubtitleStyle,
    subtitleStylePreset?: string,
    subtitleConstraints?: SubtitleConstraints,
    versions?: ComposeVersion[],
    videoFileName?: string,
    audioFileName?: string,
    audioSourceOffsetMs?: number,
  ) => void;
  getCompositionState: () => CompositionState;
  markClean: () => void;

  // Backward compat
  /** @deprecated use selectedClipIds[0] */
  selectedClipId: string | null;

  // Helpers
  msToPixel: (ms: number) => number;
  pixelToMs: (px: number) => number;
}

function makeUndoEntry(state: {
  clips: CompositionClip[];
  subtitleSegments: SubtitleSegment[];
  selectedClipIds: string[];
  selectedSubtitleIds: string[];
}): ComposeUndoEntry {
  return {
    clips: JSON.parse(JSON.stringify(state.clips)),
    subtitleSegments: JSON.parse(JSON.stringify(state.subtitleSegments)),
    selectedClipIds: [...state.selectedClipIds],
    selectedSubtitleIds: [...state.selectedSubtitleIds],
  };
}

export const useComposeStore = create<ComposeStore>((set, get) => ({
  // Viewport
  zoomLevel: 0.1,
  scrollOffsetMs: 0,
  viewportWidthPx: 1000,

  // Playback
  currentTimeMs: 0,
  isPlaying: false,
  durationMs: 0,

  // Selection
  selectedClipIds: [],
  selectedSubtitleIds: [],
  get selectedClipId() {
    return get().selectedClipIds[0] ?? null;
  },

  // Drag
  dragState: null,
  dragTargetTrackId: null,
  activeTrackId: null,

  // Data
  tracks: [],
  clips: [],
  mediaBin: [],

  // Composition format
  aspectRatio: '16:9',
  backgroundColor: '#000000',

  // Subtitles
  subtitleSegments: [],
  subtitleStyle: { ...defaultComposeStyle },
  subtitleStylePreset: 'youtube-classic',
  subtitleConstraints: { ...DEFAULT_CONSTRAINTS },

  // Versions
  versions: [],

  // Undo/Redo
  undoStack: [],
  redoStack: [],

  // Dirty
  dirty: false,

  // --- Actions ---

  setZoom: (level) => set({ zoomLevel: Math.max(0.01, Math.min(1, level)) }),
  setScrollOffset: (ms) => set({ scrollOffsetMs: Math.max(0, ms) }),
  setViewportWidth: (px) => set({ viewportWidthPx: px }),

  setCurrentTime: (ms) => set({ currentTimeMs: Math.max(0, ms) }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setDuration: (ms) => set({ durationMs: ms }),

  selectClip: (id, addToSelection) => {
    if (id === null) {
      set({ selectedClipIds: [] });
      return;
    }
    if (addToSelection) {
      set((s) => {
        const ids = s.selectedClipIds;
        if (ids.includes(id)) {
          return { selectedClipIds: ids.filter((i) => i !== id) };
        }
        return { selectedClipIds: [...ids, id], selectedSubtitleIds: [] };
      });
    } else {
      set({ selectedClipIds: [id], selectedSubtitleIds: [] });
    }
  },

  selectSubtitle: (id, addToSelection) => {
    if (!id) {
      set({ selectedSubtitleIds: [] });
      return;
    }
    if (addToSelection) {
      set((s) => {
        const current = s.selectedSubtitleIds;
        if (current.includes(id)) {
          return { selectedSubtitleIds: current.filter((i) => i !== id), selectedClipIds: [] };
        }
        return { selectedSubtitleIds: [...current, id], selectedClipIds: [] };
      });
    } else {
      set({ selectedSubtitleIds: [id], selectedClipIds: [] });
    }
  },

  selectAllSubtitles: () => {
    set((s) => ({
      selectedSubtitleIds: s.subtitleSegments.map((seg) => seg.id),
      selectedClipIds: [],
    }));
  },

  selectSubtitlesFromPlayhead: (direction) => {
    const state = get();
    const t = state.currentTimeMs;
    const ids = state.subtitleSegments
      .filter((s) => direction === 'left' ? s.endMs <= t : s.startMs >= t)
      .map((s) => s.id);
    set({ selectedSubtitleIds: ids, selectedClipIds: [] });
  },

  selectSubtitleRange: (id) => {
    const state = get();
    const sorted = [...state.subtitleSegments].sort((a, b) => a.startMs - b.startMs);
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

  setDragState: (state) => set({ dragState: state }),
  setDragTargetTrackId: (trackId) => set({ dragTargetTrackId: trackId }),
  setActiveTrackId: (trackId) => set({ activeTrackId: trackId }),

  addClip: (clipData) => {
    const id = uuidv4();
    const enriched = (clipData.type === 'image' || clipData.type === 'gif') && !clipData.overlayPosition
      ? { ...clipData, overlayPosition: { x: 0.5, y: 0.5, width: 0.8 } }
      : clipData;
    const clip: CompositionClip = { ...enriched, id };
    get().saveSnapshot();
    set((s) => ({ clips: [...s.clips, clip], dirty: true, selectedClipIds: [id], selectedSubtitleIds: [] }));
    return id;
  },

  updateClip: (id, updates) => {
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...updates } : c)),
      dirty: true,
    }));
  },

  removeClip: (id) => {
    get().saveSnapshot();
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selectedClipIds: s.selectedClipIds.filter((i) => i !== id),
      dirty: true,
    }));
  },

  moveClip: (id, newStartMs, newTrackId) => {
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== id) return c;
        const duration = c.timelineEndMs - c.timelineStartMs;
        return {
          ...c,
          timelineStartMs: Math.max(0, newStartMs),
          timelineEndMs: Math.max(0, newStartMs) + duration,
          trackId: newTrackId ?? c.trackId,
        };
      }),
      dirty: true,
    }));
  },

  moveSelectedClips: (deltaMs) => {
    const state = get();
    if (state.selectedClipIds.length === 0) return;
    const selectedSet = new Set(state.selectedClipIds);
    set((s) => ({
      clips: s.clips.map((c) => {
        if (!selectedSet.has(c.id)) return c;
        const newStart = Math.max(0, c.timelineStartMs + deltaMs);
        const dur = c.timelineEndMs - c.timelineStartMs;
        return { ...c, timelineStartMs: newStart, timelineEndMs: newStart + dur };
      }),
      dirty: true,
    }));
  },

  trimClip: (id, edge, newMs) => {
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== id) return c;
        if (edge === 'in') {
          const clamped = Math.max(0, Math.min(newMs, c.timelineEndMs - 100));
          const trimDelta = clamped - c.timelineStartMs;
          return {
            ...c,
            timelineStartMs: clamped,
            sourceInMs: Math.max(0, c.sourceInMs + trimDelta),
          };
        } else {
          const clamped = Math.max(c.timelineStartMs + 100, newMs);
          const trimDelta = clamped - c.timelineEndMs;
          return {
            ...c,
            timelineEndMs: clamped,
            sourceOutMs: c.sourceOutMs + trimDelta,
          };
        }
      }),
      dirty: true,
    }));
  },

  splitClipAtPlayhead: () => {
    const state = get();
    const t = state.currentTimeMs;
    // If a clip is selected, use it; otherwise find any clip under playhead
    const firstSelected = state.selectedClipIds[0] ?? null;
    let clip = firstSelected ? state.clips.find((c) => c.id === firstSelected) : undefined;
    if (!clip || t <= clip.timelineStartMs + MIN_SPLIT_PIECE_MS || t >= clip.timelineEndMs - MIN_SPLIT_PIECE_MS) {
      clip = state.clips.find((c) => t > c.timelineStartMs + MIN_SPLIT_PIECE_MS && t < c.timelineEndMs - MIN_SPLIT_PIECE_MS);
    }
    if (!clip || t <= clip.timelineStartMs + MIN_SPLIT_PIECE_MS || t >= clip.timelineEndMs - MIN_SPLIT_PIECE_MS) return;

    state.saveSnapshot();
    const sourceOffset = t - clip.timelineStartMs;
    const splitSourceMs = clip.sourceInMs + sourceOffset;
    const leftId = uuidv4();
    const rightId = uuidv4();

    set((s) => ({
      clips: [
        ...s.clips.filter((c) => c.id !== clip.id),
        { ...clip, id: leftId, timelineEndMs: t, sourceOutMs: splitSourceMs },
        { ...clip, id: rightId, timelineStartMs: t, sourceInMs: splitSourceMs },
      ],
      selectedClipIds: [rightId],
      dirty: true,
    }));
  },

  splitAllAtPlayhead: () => {
    const state = get();
    const t = state.currentTimeMs;
    const toSplit = state.clips.filter(
      (c) => t > c.timelineStartMs + MIN_SPLIT_PIECE_MS && t < c.timelineEndMs - MIN_SPLIT_PIECE_MS
    );
    if (toSplit.length === 0) return;
    state.saveSnapshot();
    const newClips: CompositionClip[] = [];
    const removeIds = new Set(toSplit.map((c) => c.id));
    for (const clip of toSplit) {
      const sourceOffset = t - clip.timelineStartMs;
      const splitSourceMs = clip.sourceInMs + sourceOffset;
      newClips.push({ ...clip, id: uuidv4(), timelineEndMs: t, sourceOutMs: splitSourceMs });
      newClips.push({ ...clip, id: uuidv4(), timelineStartMs: t, sourceInMs: splitSourceMs });
    }
    set((s) => ({
      clips: [...s.clips.filter((c) => !removeIds.has(c.id)), ...newClips],
      selectedClipIds: [],
      dirty: true,
    }));
  },

  deleteSelected: () => {
    const state = get();
    if (state.selectedClipIds.length > 0) {
      state.saveSnapshot();
      const selectedSet = new Set(state.selectedClipIds);
      set((s) => ({
        clips: s.clips.filter((c) => !selectedSet.has(c.id)),
        selectedClipIds: [],
        dirty: true,
      }));
    } else if (state.selectedSubtitleIds.length > 0) {
      state.saveSnapshot();
      const idsToDelete = new Set(state.selectedSubtitleIds);
      set((s) => ({
        subtitleSegments: s.subtitleSegments.filter((seg) => !idsToDelete.has(seg.id)),
        selectedSubtitleIds: [],
        dirty: true,
      }));
    }
  },

  rippleDeleteSelected: () => {
    const state = get();
    if (state.selectedClipIds.length === 0) return;

    const selectedClips = state.clips.filter((c) => state.selectedClipIds.includes(c.id));
    if (selectedClips.length === 0) return;

    state.saveSnapshot();

    let remainingClips = state.clips.filter((c) => !state.selectedClipIds.includes(c.id));
    let segments = [...state.subtitleSegments];

    // Merge overlapping gap ranges
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

    // Process from right to left
    for (let gi = mergedGaps.length - 1; gi >= 0; gi--) {
      const gapStart = mergedGaps[gi].start;
      const gapEnd = mergedGaps[gi].end;
      const gapDuration = gapEnd - gapStart;

      remainingClips = remainingClips.map((c) => {
        if (c.timelineStartMs >= gapEnd) {
          return { ...c, timelineStartMs: c.timelineStartMs - gapDuration, timelineEndMs: c.timelineEndMs - gapDuration };
        }
        return c;
      });

      segments = segments.map((seg) => {
        if (seg.startMs >= gapEnd) {
          return {
            ...seg, startMs: seg.startMs - gapDuration, endMs: seg.endMs - gapDuration,
            words: seg.words?.map((w) => ({ ...w, startMs: w.startMs - gapDuration, endMs: w.endMs - gapDuration })),
          };
        }
        if (seg.endMs > gapStart && seg.startMs < gapEnd) {
          if (seg.startMs >= gapStart && seg.endMs <= gapEnd) return null;
          if (seg.startMs < gapStart && seg.endMs <= gapEnd) {
            return { ...seg, endMs: gapStart, words: seg.words?.filter((w) => w.startMs < gapStart) };
          }
          if (seg.startMs >= gapStart && seg.endMs > gapEnd) {
            return {
              ...seg, startMs: gapStart, endMs: seg.endMs - gapDuration,
              words: seg.words?.filter((w) => w.endMs > gapEnd).map((w) => ({
                ...w, startMs: Math.max(gapStart, w.startMs - gapDuration), endMs: w.endMs - gapDuration,
              })),
            };
          }
          return {
            ...seg, endMs: seg.endMs - gapDuration,
            words: seg.words?.filter((w) => w.endMs <= gapStart || w.startMs >= gapEnd).map((w) => {
              if (w.startMs >= gapEnd) return { ...w, startMs: w.startMs - gapDuration, endMs: w.endMs - gapDuration };
              return w;
            }),
          };
        }
        return seg;
      }).filter(Boolean) as SubtitleSegment[];
    }

    set({
      clips: remainingClips,
      subtitleSegments: segments,
      selectedClipIds: [],
      dirty: true,
    });
  },

  collapseGapAtPlayhead: () => {
    const state = get();
    const t = state.currentTimeMs;
    const allClips = state.clips;
    if (allClips.length === 0) return;

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

      const clipAtT = trackClips.find((c) => t >= c.timelineStartMs && t < c.timelineEndMs);
      if (clipAtT) continue;

      let gapStart = 0;
      let gapEnd = Infinity;
      for (const c of trackClips) {
        if (c.timelineEndMs <= t) gapStart = Math.max(gapStart, c.timelineEndMs);
        if (c.timelineStartMs > t) { gapEnd = Math.min(gapEnd, c.timelineStartMs); break; }
      }

      if (gapEnd <= gapStart) continue;
      anyTrackHasGap = true;
      narrowestStart = Math.max(narrowestStart, gapStart);
      narrowestEnd = Math.min(narrowestEnd, gapEnd);
    }

    if (!anyTrackHasGap || narrowestEnd <= narrowestStart) return;
    state.saveSnapshot();

    const gapDuration = narrowestEnd - narrowestStart;
    const shiftedClips = allClips.map((c) => {
      if (c.timelineStartMs >= narrowestEnd) {
        return { ...c, timelineStartMs: c.timelineStartMs - gapDuration, timelineEndMs: c.timelineEndMs - gapDuration };
      }
      return c;
    });

    const shiftedSegments = state.subtitleSegments.map((seg) => {
      if (seg.startMs >= narrowestEnd) {
        return { ...seg, startMs: seg.startMs - gapDuration, endMs: seg.endMs - gapDuration };
      }
      if (seg.endMs > narrowestStart && seg.startMs < narrowestEnd) {
        if (seg.startMs >= narrowestStart) return null;
        return { ...seg, endMs: narrowestStart };
      }
      return seg;
    }).filter(Boolean) as SubtitleSegment[];

    set({ clips: shiftedClips, subtitleSegments: shiftedSegments, dirty: true });
  },

  closeGapForSelected: () => {
    const state = get();
    if (state.selectedClipIds.length === 0) return;

    const selectedSet = new Set(state.selectedClipIds);
    const selectedClips = state.clips.filter((c) => selectedSet.has(c.id));
    if (selectedClips.length === 0) return;

    const groupStart = Math.min(...selectedClips.map((c) => c.timelineStartMs));
    const tracksWithSelected = Array.from(new Set(selectedClips.map((c) => c.trackId)));
    let targetStart = 0;

    for (const trackId of tracksWithSelected) {
      const nonSelectedBefore = state.clips.filter(
        (c) => c.trackId === trackId && !selectedSet.has(c.id) && c.timelineEndMs <= groupStart
      );
      if (nonSelectedBefore.length > 0) {
        targetStart = Math.max(targetStart, Math.max(...nonSelectedBefore.map((c) => c.timelineEndMs)));
      }
    }

    const deltaMs = groupStart - targetStart;
    if (deltaMs <= 0) return;

    state.saveSnapshot();
    const groupEnd = Math.max(...selectedClips.map((c) => c.timelineEndMs));

    set((s) => ({
      clips: s.clips.map((c) => {
        if (!selectedSet.has(c.id)) return c;
        return { ...c, timelineStartMs: c.timelineStartMs - deltaMs, timelineEndMs: c.timelineEndMs - deltaMs };
      }),
      subtitleSegments: s.subtitleSegments.map((seg) => {
        if (seg.startMs >= groupStart && seg.endMs <= groupEnd) {
          return { ...seg, startMs: seg.startMs - deltaMs, endMs: seg.endMs - deltaMs };
        }
        return seg;
      }),
      dirty: true,
    }));
  },

  clearTimeline: () => {
    get().saveSnapshot();
    set({ clips: [], selectedClipIds: [], selectedSubtitleIds: [], dirty: true });
  },

  copySelectedClips: () => {
    const state = get();
    const selected = state.clips.filter((c) => state.selectedClipIds.includes(c.id));
    if (selected.length === 0) return;
    const earliest = Math.min(...selected.map((c) => c.timelineStartMs));
    composeClipboard = selected.map((c) => ({
      trackId: c.trackId,
      offsetMs: c.timelineStartMs - earliest,
      clip: JSON.parse(JSON.stringify(c)) as CompositionClip,
    }));
    // Capture the subtitles inside the copied span (clamped) so a ripple
    // insert can bring them along with the clips.
    const spanEnd = Math.max(...selected.map((c) => c.timelineEndMs));
    composeAttachedSubs = state.subtitleSegments
      .filter((s) => s.endMs > earliest && s.startMs < spanEnd)
      .sort((a, b) => a.startMs - b.startMs)
      .map((s) => {
        const seg = clampSegmentToBounds(JSON.parse(JSON.stringify(s)) as SubtitleSegment, earliest, spanEnd);
        return { offsetMs: seg.startMs - earliest, seg };
      });
  },

  pasteClips: () => {
    if (composeClipboard.length === 0) return;
    const state = get();
    const pasteAt = state.currentTimeMs;
    get().saveSnapshot();
    // Onto the ACTIVE track when it takes the clip's type, else its own track
    // (see resolvePasteTrackId) — same rule as the reel editor.
    const newClips: CompositionClip[] = composeClipboard.map((entry) => {
      const dur = entry.clip.timelineEndMs - entry.clip.timelineStartMs;
      const startMs = pasteAt + entry.offsetMs;
      return {
        ...JSON.parse(JSON.stringify(entry.clip)),
        id: uuidv4(),
        trackId: resolvePasteTrackId(entry.clip, state.tracks, state.activeTrackId),
        timelineStartMs: startMs,
        timelineEndMs: startMs + dur,
      } as CompositionClip;
    });
    set((s) => ({
      clips: [...s.clips, ...newClips],
      selectedClipIds: newClips.map((c) => c.id),
      selectedSubtitleIds: [],
      dirty: true,
    }));
  },

  canPasteClips: () => composeClipboard.length > 0,

  rippleInsertAtPlayhead: () => {
    if (composeClipboard.length === 0) return;
    const state = get();
    const T = state.currentTimeMs;

    // Span of the inserted material = everything shifts right by this much.
    const D = Math.max(...composeClipboard.map((e) => e.offsetMs + (e.clip.timelineEndMs - e.clip.timelineStartMs)));
    if (!(D > 0)) return;

    get().saveSnapshot();

    // 1) Split clips straddling T so their right halves can shift cleanly
    //    (same math as splitAllAtPlayhead). The left half drops any
    //    transition — it now cuts into the inserted material.
    const splitClips: CompositionClip[] = [];
    for (const c of state.clips) {
      if (T > c.timelineStartMs && T < c.timelineEndMs) {
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
    const shiftedClips = splitClips.map((c) => c.timelineStartMs >= T
      ? { ...c, timelineStartMs: c.timelineStartMs + D, timelineEndMs: c.timelineEndMs + D }
      : c);
    const shiftedSubs = state.subtitleSegments.map((s) => s.startMs >= T
      ? { ...s, startMs: s.startMs + D, endMs: s.endMs + D, words: s.words?.map((w) => ({ ...w, startMs: w.startMs + D, endMs: w.endMs + D })) }
      : s);

    // 3) Insert the clipboard clips at T, on the active track when it takes
    //    them (same rule as Ctrl+V — the two must not disagree).
    const newClips: CompositionClip[] = composeClipboard.map((entry) => {
      const dur = entry.clip.timelineEndMs - entry.clip.timelineStartMs;
      const startMs = T + entry.offsetMs;
      return {
        ...JSON.parse(JSON.stringify(entry.clip)),
        id: uuidv4(),
        trackId: resolvePasteTrackId(entry.clip, state.tracks, state.activeTrackId),
        timelineStartMs: startMs,
        timelineEndMs: startMs + dur,
      } as CompositionClip;
    });

    // 4) Insert the subtitles that came with the copied span.
    const newSegs: SubtitleSegment[] = composeAttachedSubs.map((entry) => {
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

    set({
      clips: [...shiftedClips, ...newClips],
      subtitleSegments: [...shiftedSubs, ...newSegs].sort((a, b) => a.startMs - b.startMs),
      selectedClipIds: newClips.map((c) => c.id),
      selectedSubtitleIds: [],
      dirty: true,
    });
  },

  addTrack: (type, label) => {
    const state = get();
    const prefix = type === 'video' ? 'v' : type === 'audio' ? 'a' : type === 'subtitle' ? 's' : type === 'image' ? 'i' : 't';
    const existingNums = state.tracks
      .filter((t) => t.id.startsWith(prefix))
      .map((t) => parseInt(t.id.slice(prefix.length)) || 0);
    const nextNum = Math.max(0, ...existingNums) + 1;
    const trackId = `${prefix}${nextNum}`;
    const track: CompositionTrack = { id: trackId, type, label, locked: false, muted: false, visible: true };

    set((s) => {
      const tracks = [...s.tracks];
      if (type === 'image' || type === 'text') {
        const v1Idx = tracks.findIndex((t) => t.id === 'v1');
        if (v1Idx >= 0) { tracks.splice(v1Idx, 0, track); }
        else { tracks.unshift(track); }
      } else if (type === 'video') {
        const v1Idx = tracks.findIndex((t) => t.id === 'v1');
        if (v1Idx >= 0) { tracks.splice(v1Idx + 1, 0, track); }
        else { tracks.push(track); }
      } else if (type === 'audio') {
        const a1Idx = tracks.findIndex((t) => t.id === 'a1');
        if (a1Idx >= 0) { tracks.splice(a1Idx + 1, 0, track); }
        else { tracks.push(track); }
      } else {
        tracks.push(track);
      }
      return { tracks, dirty: true };
    });
    return trackId;
  },

  removeTrack: (trackId) => {
    if (PROTECTED_TRACK_IDS.has(trackId)) return;
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== trackId),
      clips: s.clips.filter((c) => c.trackId !== trackId),
      dirty: true,
    }));
  },

  toggleTrackMute: (id) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, muted: !t.muted } : t)),
      dirty: true,
    })),

  applyStemTracks: (layout, mainAudioFileName, mainAudioOffsetMs) => {
    get().saveSnapshot();
    const ids = STEM_TRACK_IDS.compose;
    const s = get();
    const totalMs = layout.reduce((m, seg) => Math.max(m, seg.concatStartMs + seg.durationMs), 0);
    const stemClips = buildStemClipsForWindow({
      layout,
      trackIds: ids,
      concatFromMs: 0,
      concatToMs: totalMs,
      timelineStartMs: 0,
      mainAudioFileName,
      mainAudioOffsetMs,
      makeId: () => uuidv4(),
    });
    const tracks = ensureStemTracks(s.tracks, ids, 'a1').map((t) => (t.id === 'a1' ? { ...t, muted: true } : t));
    set({
      tracks,
      clips: [...s.clips.filter((c) => c.trackId !== ids.board && c.trackId !== ids.ambient), ...stemClips],
      selectedClipIds: [],
      dirty: true,
    });
  },

  removeStemTracks: () => {
    get().saveSnapshot();
    const ids = STEM_TRACK_IDS.compose;
    set((s) => ({
      tracks: s.tracks
        .filter((t) => t.id !== ids.board && t.id !== ids.ambient)
        .map((t) => (t.id === 'a1' ? { ...t, muted: false } : t)),
      clips: s.clips.filter((c) => c.trackId !== ids.board && c.trackId !== ids.ambient),
      selectedClipIds: [],
      dirty: true,
    }));
  },

  stemTracksActive: () => hasStemTracks(get().tracks, STEM_TRACK_IDS.compose),

  toggleTrackLock: (id) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, locked: !t.locked } : t)),
      dirty: true,
    })),

  toggleTrackVisible: (id) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, visible: !t.visible } : t)),
      dirty: true,
    })),

  addToBin: (asset) =>
    set((s) => ({ mediaBin: [...s.mediaBin, asset], dirty: true })),

  removeFromBin: (id) =>
    set((s) => ({
      mediaBin: s.mediaBin.filter((a) => a.id !== id),
      clips: s.clips.filter((c) => {
        const asset = s.mediaBin.find((a) => a.id === id);
        return !(asset && c.fileName === asset.fileName);
      }),
      dirty: true,
    })),

  setSubtitleSegments: (segments) => set({ subtitleSegments: segments }),

  updateSubtitleSegment: (id, updates) =>
    set((s) => ({
      subtitleSegments: s.subtitleSegments.map((seg) =>
        seg.id === id ? { ...seg, ...updates } : seg
      ),
      dirty: true,
    })),

  styleSelectedSubtitles: (update) => {
    const state = get();
    if (state.selectedSubtitleIds.length === 0) return;
    const sel = new Set(state.selectedSubtitleIds);
    get().saveSnapshot();
    set((s) => ({
      subtitleSegments: s.subtitleSegments.map((seg) =>
        sel.has(seg.id) ? styleWholeSegment(seg, update) : seg
      ),
      dirty: true,
    }));
  },

  moveSelectedSubtitles: (deltaMs) => {
    const state = get();
    const ids = new Set(state.selectedSubtitleIds);
    if (ids.size === 0) return;
    set((s) => ({
      subtitleSegments: s.subtitleSegments.map((seg) =>
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
      dirty: true,
    }));
  },

  deleteSubtitleSegment: (segId) => {
    get().saveSnapshot();
    set((s) => ({
      subtitleSegments: s.subtitleSegments.filter((seg) => seg.id !== segId),
      selectedSubtitleIds: s.selectedSubtitleIds.filter((id) => id !== segId),
      dirty: true,
    }));
  },

  splitSubtitleAtPlayhead: () => {
    const state = get();
    const t = state.currentTimeMs;
    const hasSub = state.subtitleSegments.some((s) => t > s.startMs && t < s.endMs);
    if (!hasSub) return;
    state.saveSnapshot();
    set((s) => ({
      subtitleSegments: splitSubtitlesAtTime(s.subtitleSegments, t),
      dirty: true,
    }));
  },

  addSubtitleSegment: () => {
    get().saveSnapshot();
    const state = get();
    const t = state.currentTimeMs;
    const endMs = Math.min(state.durationMs, t + 500); // 0.5 second default duration
    const newSeg: SubtitleSegment = { id: uuidv4(), startMs: t, endMs, text: '' };
    set((s) => ({
      subtitleSegments: [...s.subtitleSegments, newSeg].sort((a, b) => a.startMs - b.startMs),
      selectedSubtitleIds: [newSeg.id],
      dirty: true,
    }));
  },

  syncSubtitlesToClips: () => {
    get().saveSnapshot();
    const state = get();
    const videoClips = state.clips
      .filter((c) => c.trackId === 'v1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    if (videoClips.length === 0) return;

    const synced = state.subtitleSegments
      .map((seg) => {
        for (const clip of videoClips) {
          if (seg.startMs >= clip.timelineStartMs && seg.endMs <= clip.timelineEndMs) return seg;
          if (seg.startMs < clip.timelineEndMs && seg.endMs > clip.timelineStartMs) {
            return clampSegmentToBounds(seg, clip.timelineStartMs, clip.timelineEndMs);
          }
        }
        return null;
      })
      .filter((s): s is SubtitleSegment => s !== null && (s.endMs - s.startMs) > 100)
      .sort((a, b) => a.startMs - b.startMs);

    set({ subtitleSegments: synced, dirty: true });
  },

  regenerateSubtitles: () => {
    get().saveSnapshot();
    const state = get();
    let segments = [...state.subtitleSegments];

    const videoClips = state.clips
      .filter((c) => c.trackId === 'v1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

    if (videoClips.length > 0) {
      segments = segments
        .map((seg) => {
          for (const clip of videoClips) {
            if (seg.startMs < clip.timelineEndMs && seg.endMs > clip.timelineStartMs) {
              return clampSegmentToBounds(seg, clip.timelineStartMs, clip.timelineEndMs);
            }
          }
          return null;
        })
        .filter((s): s is SubtitleSegment => s !== null && (s.endMs - s.startMs) > 100);
    }

    // Sort BEFORE split so the resulting array stays monotonic by startMs.
    segments.sort((a, b) => a.startMs - b.startMs);

    const resplit = splitLongSegments(segments, state.subtitleConstraints.maxCharsPerBlock, state.subtitleConstraints.maxDurationMs);
    // Final sort just in case splitLongSegments produced something out of order
    // (e.g. defensively-clamped sub-segments).
    resplit.sort((a, b) => a.startMs - b.startMs);
    set({ subtitleSegments: resplit, dirty: true });
  },

  fillSubtitleGapAtPlayhead: (original) => {
    const state = get();
    const t = state.currentTimeMs;

    const covering = state.subtitleSegments.find((s) => s.startMs <= t && t < s.endMs);
    if (covering) {
      return { ok: false, added: 0, reason: 'El playhead está sobre un subtítulo. Colócalo en el hueco vacío que quieres rellenar.' };
    }

    // Gap bounds: previous subtitle end → next subtitle start (or timeline edges).
    let gapStart = 0;
    let gapEnd = state.durationMs;
    for (const s of state.subtitleSegments) {
      if (s.endMs <= t && s.endMs > gapStart) gapStart = s.endMs;
      if (s.startMs >= t && s.startMs < gapEnd) gapEnd = s.startMs;
    }

    const videoClips = state.clips
      .filter((c) => c.trackId === 'v1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

    const fresh = fillGapFromOriginal(
      original, videoClips, gapStart, gapEnd,
      state.subtitleConstraints,
    );
    if (fresh.length === 0) {
      return { ok: false, added: 0, reason: 'La transcripción original no tiene texto en ese tramo.' };
    }

    get().saveSnapshot();
    set((s) => ({
      subtitleSegments: [...s.subtitleSegments, ...fresh].sort((a, b) => a.startMs - b.startMs),
      selectedSubtitleIds: fresh.map((f) => f.id),
      selectedClipIds: [],
      dirty: true,
    }));
    return { ok: true, added: fresh.length };
  },

  // Style
  setSubtitleStyle: (style) => set({ subtitleStyle: style, dirty: true }),

  setSubtitlePreset: (presetId, style) => set({
    subtitleStylePreset: presetId,
    subtitleStyle: style,
    dirty: true,
  }),

  setSubtitleConstraints: (constraints) => set({ subtitleConstraints: constraints, dirty: true }),

  setAspectRatio: (ratio) => set({ aspectRatio: ratio, dirty: true }),
  setBackgroundColor: (color) => set({ backgroundColor: color, dirty: true }),

  // Versions
  saveVersion: (label) => {
    const state = get();
    const version: ComposeVersion = {
      id: uuidv4(),
      label,
      createdAt: new Date().toISOString(),
      clips: JSON.parse(JSON.stringify(state.clips)),
      subtitleSegments: JSON.parse(JSON.stringify(state.subtitleSegments)),
      subtitleStyle: JSON.parse(JSON.stringify(state.subtitleStyle)),
    };
    set((s) => ({ versions: [...s.versions, version], dirty: true }));
  },

  restoreVersion: (versionId) => {
    const state = get();
    const version = state.versions.find((v) => v.id === versionId);
    if (!version) return;
    state.saveSnapshot();
    set({
      clips: JSON.parse(JSON.stringify(version.clips)),
      subtitleSegments: JSON.parse(JSON.stringify(version.subtitleSegments)),
      subtitleStyle: JSON.parse(JSON.stringify(version.subtitleStyle)),
      selectedClipIds: [],
      selectedSubtitleIds: [],
      dirty: true,
    });
  },

  deleteVersion: (versionId) => {
    set((s) => ({
      versions: s.versions.filter((v) => v.id !== versionId),
      dirty: true,
    }));
  },

  // Undo/Redo
  saveSnapshot: () => {
    const state = get();
    const entry = makeUndoEntry(state);
    set((s) => ({
      undoStack: [...s.undoStack.slice(-(MAX_UNDO - 1)), entry],
      redoStack: [],
    }));
  },

  pushUndo: () => get().saveSnapshot(),

  undo: () => {
    const state = get();
    if (state.undoStack.length === 0) return;
    const entry = state.undoStack[state.undoStack.length - 1];
    const redoEntry = makeUndoEntry(state);
    set({
      clips: entry.clips,
      subtitleSegments: entry.subtitleSegments,
      selectedClipIds: entry.selectedClipIds,
      selectedSubtitleIds: entry.selectedSubtitleIds,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, redoEntry],
      dirty: true,
    });
  },

  redo: () => {
    const state = get();
    if (state.redoStack.length === 0) return;
    const entry = state.redoStack[state.redoStack.length - 1];
    const undoEntry = makeUndoEntry(state);
    set({
      clips: entry.clips,
      subtitleSegments: entry.subtitleSegments,
      selectedClipIds: entry.selectedClipIds,
      selectedSubtitleIds: entry.selectedSubtitleIds,
      undoStack: [...state.undoStack, undoEntry],
      redoStack: state.redoStack.slice(0, -1),
      dirty: true,
    });
  },

  loadComposition: (state, subtitles, durationMs, subtitleStyle, subtitleStylePreset, subtitleConstraints, versions, videoFileName, audioFileName, audioSourceOffsetMs) => {
    // Auto-create main video/audio clips if none exist on v1/a1.
    //
    // audioSourceOffsetMs accounts for the keyframe-snap that the mux step
    // applies to the video when the camera started before the audio. The
    // muxed video's t=0 is `audioSourceOffsetMs` AFTER the standalone audio
    // file's t=0 (in real time). To keep the Compose player synced — Video
    // muted + standalone Audio playing alongside — we start the a1 clip at
    // that same offset into the audio file. Without this, video and audio
    // drift by typically 100-500 ms which is enough to notice.
    const hasMainVideo = state.clips.some((c) => c.trackId === 'v1');
    const hasMainAudio = state.clips.some((c) => c.trackId === 'a1');
    const autoClips: CompositionClip[] = [];
    const audioOffset = audioSourceOffsetMs ?? 0;
    // A composition saved while the project had no separate audio file put the
    // MUXED VIDEO itself on a1 (its embedded track). Parts projects now keep an
    // audio MASTER wav (sync.mixedAudioPath) that every re-mix refreshes
    // without touching the video — whose embedded track goes stale — so point
    // those clips at the wav, shifted like the auto-created clip (0 for parts
    // projects). Idempotent; persisted with the next Save.
    const retargetTo = videoFileName && audioFileName && audioFileName !== videoFileName ? audioFileName : null;
    const baseClips = retargetTo
      ? state.clips.map((c) => (c.trackId === 'a1' && c.type === 'audio' && c.fileName === videoFileName
        ? { ...c, fileName: retargetTo, originalName: retargetTo, sourceInMs: c.sourceInMs + audioOffset, sourceOutMs: c.sourceOutMs + audioOffset }
        : c))
      : state.clips;

    if (!hasMainVideo && videoFileName) {
      autoClips.push({
        id: uuidv4(),
        type: 'video',
        fileName: videoFileName,
        originalName: videoFileName,
        trackId: 'v1',
        timelineStartMs: 0,
        timelineEndMs: durationMs,
        sourceInMs: 0,
        sourceOutMs: durationMs,
      });
    }
    if (!hasMainAudio && audioFileName) {
      autoClips.push({
        id: uuidv4(),
        type: 'audio',
        fileName: audioFileName,
        originalName: audioFileName,
        trackId: 'a1',
        timelineStartMs: 0,
        timelineEndMs: durationMs,
        sourceInMs: audioOffset,
        sourceOutMs: audioOffset + durationMs,
      });
    }

    const clips = [...baseClips, ...autoClips];
    // A stale id would silently redirect the first paste of the next project.
    set({ activeTrackId: null });

    // Remove empty legacy tracks (v2/Cutaways, a2/Extra Audio) that have no clips
    const usedTrackIds = new Set(clips.map((c) => c.trackId));
    const tracks = state.tracks.filter((t) => {
      // Always keep protected tracks
      if (PROTECTED_TRACK_IDS.has(t.id)) return true;
      // Keep tracks that have clips on them
      if (usedTrackIds.has(t.id)) return true;
      // Remove empty non-protected tracks
      return false;
    });

    // Auto-repair subtitles loaded from disk: drop words[] arrays whose timings
    // fall outside the segment's startMs/endMs (legacy bug — words weren't kept
    // in sync when segments were clamped to clip bounds, causing splitByWords
    // to later produce sub-segments at wrong times).
    const repairedSubtitles = subtitles.map((seg) => {
      if (!seg.words || seg.words.length === 0) return seg;
      const allWithinBounds = seg.words.every(
        (w) => w.startMs >= seg.startMs - 1 && w.endMs <= seg.endMs + 1
      );
      if (allWithinBounds) return seg;
      // Drop the corrupt words array — the text is intact and splitByText is used as fallback.
      return { ...seg, words: undefined };
    });
    const sortedSubtitles = [...repairedSubtitles].sort((a, b) => a.startMs - b.startMs);

    set({
      tracks,
      clips,
      mediaBin: state.mediaBin,
      aspectRatio: state.aspectRatio ?? '16:9',
      backgroundColor: state.backgroundColor ?? '#000000',
      subtitleSegments: sortedSubtitles,
      durationMs,
      subtitleStyle: subtitleStyle ?? defaultComposeStyle,
      subtitleStylePreset: subtitleStylePreset ?? 'youtube-classic',
      subtitleConstraints: subtitleConstraints ?? { ...DEFAULT_CONSTRAINTS },
      versions: versions ?? [],
      undoStack: [],
      redoStack: [],
      dirty: false,
      selectedClipIds: [],
      selectedSubtitleIds: [],
      currentTimeMs: 0,
      scrollOffsetMs: 0,
    });
  },

  getCompositionState: () => {
    const s = get();
    return { tracks: s.tracks, clips: s.clips, mediaBin: s.mediaBin, aspectRatio: s.aspectRatio, backgroundColor: s.backgroundColor };
  },

  markClean: () => set({ dirty: false }),

  msToPixel: (ms) => {
    const s = get();
    return (ms - s.scrollOffsetMs) * s.zoomLevel;
  },

  pixelToMs: (px) => {
    const s = get();
    return px / s.zoomLevel + s.scrollOffsetMs;
  },
}));

// Auto-recompute durationMs whenever clips or subtitle segments change.
//
// `durationMs` was originally set once at loadComposition() and then left
// stale through all mutations — so after ripple-delete / split / clip removal
// the timeline ruler and Player's durationInFrames kept reporting the
// original (longer) duration. The "go to end" button + Player end-of-stream
// behaviour got stuck way past the actual content.
//
// Strategy: subscribe to the store and re-derive durationMs from the max of
// (clip.timelineEndMs, subtitleSegment.endMs). The guard `state.clips ===
// prevState.clips && state.subtitleSegments === prevState.subtitleSegments`
// prevents this firing on unrelated state changes (playback time, selection,
// zoom). The `state.durationMs === next` check avoids a feedback loop where
// our own setState would re-trigger the subscription.
useComposeStore.subscribe((state, prevState) => {
  if (
    state.clips === prevState.clips &&
    state.subtitleSegments === prevState.subtitleSegments
  ) return;

  let next = 0;
  for (const c of state.clips) if (c.timelineEndMs > next) next = c.timelineEndMs;
  for (const s of state.subtitleSegments) if (s.endMs > next) next = s.endMs;

  if (state.durationMs === next) return;
  useComposeStore.setState({ durationMs: next });
});
