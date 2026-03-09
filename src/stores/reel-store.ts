'use client';

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { STYLE_PRESETS, REEL_DEFAULT_CONSTRAINTS } from '@/config/subtitle-styles';
import { splitLongSegments } from '@/lib/subtitle-utils';
import type {
  ReelDefinition,
  ReelVersion,
  CompositionClip,
  CompositionTrack,

  SubtitleSegment,
  SubtitleStyle,
  SubtitleConstraints,
  CropRegion,
} from '@/types/project';

const defaultReelTracks: CompositionTrack[] = [
  { id: 'rv1', type: 'video', label: 'Main Video', locked: true, muted: false, visible: true },
  { id: 'rv2', type: 'video', label: 'Cutaways', locked: false, muted: false, visible: true },
  { id: 'ra1', type: 'audio', label: 'Main Audio', locked: true, muted: false, visible: true },
  { id: 'ra2', type: 'audio', label: 'Extra Audio', locked: false, muted: false, visible: true },
  { id: 'rs1', type: 'subtitle', label: 'Subtitles', locked: false, muted: false, visible: true },
];

const defaultReelStyle = STYLE_PRESETS.find((p) => p.id === 'reel-punchline')!.style;

interface UndoEntry {
  reel: ReelDefinition;
  selectedClipId: string | null;
  selectedSubtitleId: string | null;
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
  dirty: boolean;
  selectedClipId: string | null;

  // Phase & timeline viewport
  phase: 'setup' | 'timeline';
  zoomLevel: number;
  scrollOffsetMs: number;
  viewportWidthPx: number;
  selectedSubtitleId: string | null;

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
  selectReel: (id: string | null) => void;
  markClean: () => void;

  // Reel CRUD
  createReel: (name: string, startMs: number, endMs: number) => string;
  deleteReel: (id: string) => void;
  duplicateReel: (id: string) => string;
  updateReel: (id: string, updates: Partial<ReelDefinition>) => void;

  // Timeline
  addClip: (reelId: string, clip: Omit<CompositionClip, 'id'>) => string;
  updateClip: (reelId: string, clipId: string, updates: Partial<CompositionClip>) => void;
  removeClip: (reelId: string, clipId: string) => void;
  moveClip: (reelId: string, clipId: string, newStartMs: number) => void;
  trimClip: (reelId: string, clipId: string, edge: 'in' | 'out', newMs: number) => void;
  splitClipAtPlayhead: (reelId: string) => void;
  selectClip: (clipId: string | null) => void;

  // Crop
  updateCropRegion: (reelId: string, updates: Partial<CropRegion>) => void;

  // Subtitles
  regenerateReelSubtitles: (reelId: string) => void;
  updateReelSubtitleSegment: (reelId: string, segId: string, updates: Partial<SubtitleSegment>) => void;
  setReelSubtitleStyle: (reelId: string, style: SubtitleStyle) => void;
  setReelSubtitlePreset: (reelId: string, presetId: string, style: SubtitleStyle) => void;
  setReelSubtitleConstraints: (reelId: string, constraints: SubtitleConstraints) => void;

  // Phase & timeline viewport
  setPhase: (phase: 'setup' | 'timeline') => void;
  enterTimelinePhase: (reelId: string, videoFileName?: string, audioFileName?: string) => void;
  setZoom: (level: number) => void;
  setScrollOffset: (ms: number) => void;
  setViewportWidth: (px: number) => void;
  selectSubtitle: (id: string | null) => void;
  deleteSubtitleSegment: (reelId: string, segId: string) => void;
  deleteSelected: (reelId: string) => void;
  splitSubtitleAtPlayhead: (reelId: string) => void;
  addSubtitleSegment: (reelId: string) => void;
  splitAllAtPlayhead: (reelId: string) => void;
  rippleDeleteSelected: (reelId: string) => void;
  collapseGapAtPlayhead: (reelId: string) => void;
  clearTimeline: (reelId: string) => void;
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
  return splitLongSegments(filtered, constraints.maxCharsPerBlock, constraints.maxDurationMs);
}

/** Split any subtitle segment that spans the given time point into two parts */
function splitSubtitlesAtTime(segments: SubtitleSegment[], timeMs: number): SubtitleSegment[] {
  const result: SubtitleSegment[] = [];
  for (const seg of segments) {
    if (timeMs > seg.startMs && timeMs < seg.endMs) {
      // Split this segment — divide text by time proportion using words if available
      const totalDur = seg.endMs - seg.startMs;
      const splitRatio = (timeMs - seg.startMs) / totalDur;

      if (seg.words && seg.words.length > 0) {
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

/** Save a snapshot of the active reel before a destructive action */
function pushUndo(state: ReelStore): { undoStack: UndoEntry[]; redoStack: UndoEntry[] } {
  const reel = state.activeReelId ? state.reels.find((r) => r.id === state.activeReelId) : undefined;
  if (!reel) return { undoStack: state.undoStack, redoStack: state.redoStack };
  const entry: UndoEntry = {
    reel: JSON.parse(JSON.stringify(reel)),
    selectedClipId: state.selectedClipId,
    selectedSubtitleId: state.selectedSubtitleId,
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
  dirty: false,
  selectedClipId: null,
  phase: 'setup',
  zoomLevel: 0.1,
  scrollOffsetMs: 0,
  viewportWidthPx: 800,
  selectedSubtitleId: null,
  undoStack: [],
  redoStack: [],

  loadReels: (reels, baseSegments, durationMs, sourceRes) => {
    set({
      reels,
      baseSegments,
      baseDurationMs: durationMs,
      sourceResolution: sourceRes,
      activeReelId: reels[0]?.id ?? null,
      currentTimeMs: 0,
      isPlaying: false,
      dirty: false,
      selectedClipId: null,
    });
  },

  selectReel: (id) => set({ activeReelId: id, currentTimeMs: 0, isPlaying: false, selectedClipId: null, selectedSubtitleId: null, phase: 'setup' }),
  markClean: () => set({ dirty: false }),

  createReel: (name, startMs, endMs) => {
    const id = uuidv4();
    const constraints = { ...REEL_DEFAULT_CONSTRAINTS };
    const segments = filterSegmentsToRange(get().baseSegments, startMs, endMs, constraints);
    const reel: ReelDefinition = {
      id,
      name,
      createdAt: new Date().toISOString(),
      startMs,
      endMs,
      cropRegion: { centerX: 0.5, centerY: 0.5, scale: 1.0 },
      composition: { tracks: defaultReelTracks.map((t) => ({ ...t })), clips: [], mediaBin: [] },
      subtitleStyle: { ...defaultReelStyle },
      subtitleStylePreset: 'reel-punchline',
      subtitleConstraints: constraints,
      subtitleSegments: segments,
      punchlineSegmentIds: [],
    };
    set((s) => ({ reels: [...s.reels, reel], activeReelId: id, dirty: true }));
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

  // Timeline operations
  addClip: (reelId, clipData) => {
    const clipId = uuidv4();
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: {
          ...r.composition,
          clips: [...r.composition.clips, { ...clipData, id: clipId }],
        },
      })),
      selectedClipId: clipId,
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
      selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId,
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

  trimClip: (reelId, clipId, edge, newMs) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    // Upper bound: the larger of baseDurationMs or reel.endMs (safety)
    const maxSourceMs = Math.max(state.baseDurationMs, reel?.endMs ?? 0);
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
    let clip = state.selectedClipId
      ? reel.composition.clips.find((c) => c.id === state.selectedClipId)
      : undefined;
    if (!clip || t <= clip.timelineStartMs || t >= clip.timelineEndMs) {
      clip = reel.composition.clips.find((c) => t > c.timelineStartMs && t < c.timelineEndMs);
    }
    if (!clip) return;
    if (t <= clip.timelineStartMs || t >= clip.timelineEndMs) return;

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
      selectedClipId: rightId,
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
    const endMs = Math.min(reelDur, t + 2000); // 2 second default duration
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
      selectedSubtitleId: newSeg.id,
      dirty: true,
    }));
  },

  selectClip: (clipId) => set({ selectedClipId: clipId }),

  updateCropRegion: (reelId, updates) => {
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        cropRegion: { ...r.cropRegion, ...updates },
      })),
      dirty: true,
    }));
  },

  regenerateReelSubtitles: (reelId) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const segments = filterSegmentsToRange(state.baseSegments, reel.startMs, reel.endMs, reel.subtitleConstraints);
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({ ...r, subtitleSegments: segments })),
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

  enterTimelinePhase: (reelId, videoFileName, audioFileName) => {
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;

    const reelDur = reel.endMs - reel.startMs;
    const existingClips = reel.composition.clips;

    // Only recreate clips if none exist at all (first time entering timeline)
    const needsRecreate = existingClips.length === 0;

    if (needsRecreate && (videoFileName || audioFileName)) {
      const clips: CompositionClip[] = [];
      if (videoFileName) {
        clips.push({
          id: uuidv4(),
          type: 'video',
          fileName: videoFileName,
          originalName: videoFileName,
          trackId: 'rv1',
          timelineStartMs: 0,
          timelineEndMs: reelDur,
          sourceInMs: reel.startMs,
          sourceOutMs: reel.endMs,
        });
      }
      if (audioFileName) {
        clips.push({
          id: uuidv4(),
          type: 'audio',
          fileName: audioFileName,
          originalName: audioFileName,
          trackId: 'ra1',
          timelineStartMs: 0,
          timelineEndMs: reelDur,
          sourceInMs: reel.startMs,
          sourceOutMs: reel.endMs,
        });
      }

      // Also regenerate subtitles to match the new range
      const segments = filterSegmentsToRange(
        state.baseSegments, reel.startMs, reel.endMs, reel.subtitleConstraints
      );

      set((s) => ({
        reels: updateReelInList(s.reels, reelId, (r) => ({
          ...r,
          composition: {
            ...r.composition,
            // Keep non-main clips (cutaways, extra audio), replace main clips
            clips: [
              ...r.composition.clips.filter(
                (c) => c.trackId !== 'rv1' && c.trackId !== 'ra1'
              ),
              ...clips,
            ],
          },
          subtitleSegments: segments,
        })),
        dirty: true,
      }));
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
        selectedClipId: null,
        selectedSubtitleId: null,
      });
    } else {
      // Returning to timeline — preserve all state, just switch phase
      set({ phase: 'timeline', isPlaying: false });
    }
  },

  setZoom: (level) => set({ zoomLevel: Math.max(0.01, Math.min(1, level)) }),
  setScrollOffset: (ms) => set({ scrollOffsetMs: Math.max(0, ms) }),
  setViewportWidth: (px) => set({ viewportWidthPx: px }),
  selectSubtitle: (id) => {
    if (id) {
      set({ selectedSubtitleId: id, selectedClipId: null });
    } else {
      set({ selectedSubtitleId: null });
    }
  },

  deleteSubtitleSegment: (reelId, segId) => {
    set(pushUndo(get()));
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        subtitleSegments: r.subtitleSegments.filter((seg) => seg.id !== segId),
      })),
      selectedSubtitleId: s.selectedSubtitleId === segId ? null : s.selectedSubtitleId,
      dirty: true,
    }));
  },

  deleteSelected: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    if (state.selectedClipId) {
      set((s) => ({
        reels: updateReelInList(s.reels, reelId, (r) => ({
          ...r,
          composition: {
            ...r.composition,
            clips: r.composition.clips.filter((c) => c.id !== state.selectedClipId),
          },
        })),
        selectedClipId: null,
        dirty: true,
      }));
    } else if (state.selectedSubtitleId) {
      get().deleteSubtitleSegment(reelId, state.selectedSubtitleId);
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
      if (t > clip.timelineStartMs && t < clip.timelineEndMs) {
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
      selectedClipId: null,
      dirty: true,
    }));
  },

  rippleDeleteSelected: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    if (!state.selectedClipId) return;
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;
    const clip = reel.composition.clips.find((c) => c.id === state.selectedClipId);
    if (!clip) return;

    const gapStart = clip.timelineStartMs;
    const gapEnd = clip.timelineEndMs;
    const gapDuration = gapEnd - gapStart;
    const trackId = clip.trackId;

    // Remove the clip
    let remainingClips = reel.composition.clips.filter((c) => c.id !== clip.id);

    // Find which tracks can shift: a track can shift if NO clip on that track
    // overlaps the gap region (other than the deleted one, already removed)
    // We try to shift ALL tracks together. If any track has a clip blocking
    // (a clip that starts before gapEnd and ends after gapStart), we only shift
    // the tracks that are free.
    const trackIdSet: Record<string, boolean> = {};
    remainingClips.forEach((c) => { trackIdSet[c.trackId] = true; });
    const trackIds = Object.keys(trackIdSet);
    const shiftableTracks: Record<string, boolean> = {};

    for (let i = 0; i < trackIds.length; i++) {
      const tid = trackIds[i];
      const trackClips = remainingClips.filter((c) => c.trackId === tid);
      const hasBlocker = trackClips.some((c) =>
        c.timelineStartMs < gapEnd && c.timelineEndMs > gapStart && c.timelineStartMs < gapStart
      );
      if (!hasBlocker) {
        shiftableTracks[tid] = true;
      }
    }

    // Also add the deleted clip's track
    shiftableTracks[trackId] = true;

    // Shift all clips on shiftable tracks that start at or after gapEnd
    remainingClips = remainingClips.map((c) => {
      if (shiftableTracks[c.trackId] && c.timelineStartMs >= gapEnd) {
        return {
          ...c,
          timelineStartMs: c.timelineStartMs - gapDuration,
          timelineEndMs: c.timelineEndMs - gapDuration,
        };
      }
      return c;
    });

    // Also shift subtitles that start at or after gapEnd
    const shiftedSegments = reel.subtitleSegments.map((seg) => {
      if (seg.startMs >= gapEnd) {
        return {
          ...seg,
          startMs: seg.startMs - gapDuration,
          endMs: seg.endMs - gapDuration,
        };
      }
      // Segments that overlap the gap: trim or remove
      if (seg.endMs > gapStart && seg.startMs < gapEnd) {
        if (seg.startMs >= gapStart) {
          // Starts inside gap - remove
          return null;
        }
        // Ends inside gap - trim
        return { ...seg, endMs: gapStart };
      }
      return seg;
    }).filter(Boolean) as typeof reel.subtitleSegments;

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: remainingClips },
        subtitleSegments: shiftedSegments,
      })),
      selectedClipId: null,
      dirty: true,
    }));
  },

  collapseGapAtPlayhead: (reelId) => {
    set(pushUndo(get()));
    const state = get();
    const reel = state.reels.find((r) => r.id === reelId);
    if (!reel) return;

    const t = state.currentTimeMs;

    // Find the gap at playhead position across all tracks.
    // A gap exists if no clip covers time t on at least the main tracks.
    // Find the gap boundaries: gapStart = max end of clips ending before t,
    // gapEnd = min start of clips starting after t.
    const allClips = reel.composition.clips;
    if (allClips.length === 0) return;

    // Find per-track gaps at playhead
    const trackGaps: { start: number; end: number }[] = [];
    const trackIdSet: Record<string, boolean> = {};
    allClips.forEach((c) => { trackIdSet[c.trackId] = true; });
    const trackIds = Object.keys(trackIdSet);

    for (let i = 0; i < trackIds.length; i++) {
      const tid = trackIds[i];
      const trackClips = allClips
        .filter((c) => c.trackId === tid)
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

      // Check if playhead is in a gap on this track
      const clipAtT = trackClips.find((c) => t >= c.timelineStartMs && t < c.timelineEndMs);
      if (clipAtT) continue; // No gap on this track at playhead

      // Find gap boundaries
      let gapStart = 0;
      let gapEnd = reel.endMs - reel.startMs;

      for (const c of trackClips) {
        if (c.timelineEndMs <= t) {
          gapStart = Math.max(gapStart, c.timelineEndMs);
        }
        if (c.timelineStartMs > t) {
          gapEnd = Math.min(gapEnd, c.timelineStartMs);
          break;
        }
      }

      if (gapEnd > gapStart) {
        trackGaps.push({ start: gapStart, end: gapEnd });
      }
    }

    if (trackGaps.length === 0) return; // No gap found at playhead

    // Use the intersection of all gaps (the common gap region)
    let commonStart = 0;
    let commonEnd = reel.endMs - reel.startMs;
    for (const g of trackGaps) {
      commonStart = Math.max(commonStart, g.start);
      commonEnd = Math.min(commonEnd, g.end);
    }

    if (commonEnd <= commonStart) return; // No common gap

    const gapDuration = commonEnd - commonStart;

    // Shift all clips that start at or after commonEnd
    const shiftedClips = allClips.map((c) => {
      if (c.timelineStartMs >= commonEnd) {
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
      if (seg.startMs >= commonEnd) {
        return { ...seg, startMs: seg.startMs - gapDuration, endMs: seg.endMs - gapDuration };
      }
      if (seg.endMs > commonStart && seg.startMs < commonEnd) {
        if (seg.startMs >= commonStart) return null;
        return { ...seg, endMs: commonStart };
      }
      return seg;
    }).filter(Boolean) as typeof reel.subtitleSegments;

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: shiftedClips },
        subtitleSegments: shiftedSegments,
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
      selectedClipId: null,
      selectedSubtitleId: null,
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

    // Clear clips and regenerate subtitles from source
    const segments = filterSegmentsToRange(state.baseSegments, reel.startMs, reel.endMs, reel.subtitleConstraints);
    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: [] },
        subtitleSegments: segments,
      })),
      selectedClipId: null,
      selectedSubtitleId: null,
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
      selectedClipId: state.selectedClipId,
      selectedSubtitleId: state.selectedSubtitleId,
    };
    set({
      reels: state.reels.map((r) => r.id === entry.reel.id ? entry.reel : r),
      selectedClipId: entry.selectedClipId,
      selectedSubtitleId: entry.selectedSubtitleId,
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
      selectedClipId: state.selectedClipId,
      selectedSubtitleId: state.selectedSubtitleId,
    };
    set({
      reels: state.reels.map((r) => r.id === entry.reel.id ? entry.reel : r),
      selectedClipId: entry.selectedClipId,
      selectedSubtitleId: entry.selectedSubtitleId,
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
      })),
      selectedClipId: null,
      selectedSubtitleId: null,
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
