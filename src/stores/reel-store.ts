'use client';

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { STYLE_PRESETS, REEL_DEFAULT_CONSTRAINTS } from '@/config/subtitle-styles';
import { splitLongSegments, clampSegmentToBounds } from '@/lib/subtitle-utils';
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
  dirty: boolean;
  selectedClipIds: string[];

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
  createReel: (name: string, startMs: number, endMs: number, sourceStartMs?: number, sourceEndMs?: number) => string;
  deleteReel: (id: string) => void;
  duplicateReel: (id: string) => string;
  updateReel: (id: string, updates: Partial<ReelDefinition>) => void;

  // Track management
  addTrack: (reelId: string, type: CompositionTrack['type'], label: string) => string;
  removeTrack: (reelId: string, trackId: string) => void;

  // Timeline
  addClip: (reelId: string, clip: Omit<CompositionClip, 'id'>) => string;
  updateClip: (reelId: string, clipId: string, updates: Partial<CompositionClip>) => void;
  removeClip: (reelId: string, clipId: string) => void;
  moveClip: (reelId: string, clipId: string, newStartMs: number) => void;
  trimClip: (reelId: string, clipId: string, edge: 'in' | 'out', newMs: number) => void;
  splitClipAtPlayhead: (reelId: string) => void;
  selectClip: (clipId: string | null, addToSelection?: boolean) => void;
  moveSelectedClips: (reelId: string, deltaMs: number) => void;
  closeGapForSelected: (reelId: string) => void;

  // Crop
  updateCropRegion: (reelId: string, updates: Partial<CropRegion>) => void;

  // Subtitles
  regenerateReelSubtitles: (reelId: string) => void;
  syncReelSubtitlesFromBase: (reelId: string) => void;
  updateReelSubtitleSegment: (reelId: string, segId: string, updates: Partial<SubtitleSegment>) => void;
  setReelSubtitleStyle: (reelId: string, style: SubtitleStyle) => void;
  setReelSubtitlePreset: (reelId: string, presetId: string, style: SubtitleStyle) => void;
  setReelSubtitleConstraints: (reelId: string, constraints: SubtitleConstraints) => void;

  // Phase & timeline viewport
  setPhase: (phase: 'setup' | 'timeline') => void;
  enterTimelinePhase: (reelId: string, videoFileName?: string, audioFileName?: string, composeClips?: CompositionClip[]) => void;
  setZoom: (level: number) => void;
  setScrollOffset: (ms: number) => void;
  setViewportWidth: (px: number) => void;
  selectSubtitle: (id: string | null, addToSelection?: boolean) => void;
  selectAllSubtitles: (reelId: string) => void;
  selectSubtitlesFromPlayhead: (reelId: string, direction: 'left' | 'right') => void;
  moveSelectedSubtitles: (reelId: string, deltaMs: number) => void;
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
  dirty: false,
  selectedClipIds: [],
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
      state.baseSegments,
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

  selectReel: (id) => set({ activeReelId: id, currentTimeMs: 0, isPlaying: false, selectedClipIds: [], selectedSubtitleIds: [], phase: 'setup' }),
  markClean: () => set({ dirty: false }),

  createReel: (name, startMs, endMs, sourceStartMs, sourceEndMs) => {
    const id = uuidv4();
    const constraints = { ...REEL_DEFAULT_CONSTRAINTS };
    // startMs/endMs = compose timeline times (for display, trim bar, subtitle filtering)
    // sourceStartMs/sourceEndMs = source times (ONLY for video/audio seeking in muxed file)
    const srcStart = sourceStartMs != null ? sourceStartMs : startMs;
    const srcEnd = sourceEndMs != null ? sourceEndMs : endMs;
    console.log(`[reel-store] createReel "${name}": compose=${startMs}-${endMs}, source=${srcStart}-${srcEnd}`);
    // Subtitles filtered by COMPOSE time (baseSegments are now in compose time)
    const segments = filterSegmentsToRange(get().baseSegments, startMs, endMs, constraints);
    const reel: ReelDefinition = {
      id,
      name,
      createdAt: new Date().toISOString(),
      startMs,
      endMs,
      sourceStartMs: sourceStartMs != null ? sourceStartMs : undefined,
      sourceEndMs: sourceEndMs != null ? sourceEndMs : undefined,
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
    const resplit = splitLongSegments(segments, reel.subtitleConstraints.maxCharsPerBlock, reel.subtitleConstraints.maxDurationMs);
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

  enterTimelinePhase: (reelId, videoFileName, audioFileName, composeClips) => {
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

    if (needsRecreate && (videoFileName || audioFileName)) {
      const clips: CompositionClip[] = [];

      // Inherit cuts from compose: if composeClips were supplied (v1 clips
      // from the compose timeline that overlap the reel's compose range),
      // emit one rv1 clip per compose segment so the reel honors the same
      // cuts. The reel's local timeline is the compose range with cuts
      // removed — `outputOffset` tracks how much we've already written.
      // Without this, a reel created from a bit that contains a compose-
      // level cut plays the un-cut muxed range, ignoring the edit.
      const composeV1ClipsInRange = (composeClips ?? [])
        .filter((c) =>
          c.trackId === 'v1' &&
          c.timelineEndMs > reel.startMs &&
          c.timelineStartMs < reel.endMs
        )
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

      if (videoFileName && composeV1ClipsInRange.length > 1) {
        let outputOffset = 0;
        for (const cc of composeV1ClipsInRange) {
          // Clamp the compose clip's compose-time range to the reel's window.
          const composeStart = Math.max(cc.timelineStartMs, reel.startMs);
          const composeEnd = Math.min(cc.timelineEndMs, reel.endMs);
          const dur = composeEnd - composeStart;
          if (dur <= 0) continue;
          // Translate the clamp into source-time using the compose clip's
          // own compose→source mapping (sourceInMs is the muxed seek for
          // timelineStartMs).
          const sourceIn = cc.sourceInMs + (composeStart - cc.timelineStartMs);
          clips.push({
            id: uuidv4(),
            type: 'video',
            fileName: videoFileName,
            originalName: videoFileName,
            trackId: 'rv1',
            timelineStartMs: outputOffset,
            timelineEndMs: outputOffset + dur,
            sourceInMs: sourceIn,
            sourceOutMs: sourceIn + dur,
          });
          outputOffset += dur;
        }
        if (audioFileName) {
          // Mirror the same segmentation on ra1 so audio gaps line up with
          // compose cuts (otherwise audio runs through the cuts).
          let outputOffsetA = 0;
          for (const cc of composeV1ClipsInRange) {
            const composeStart = Math.max(cc.timelineStartMs, reel.startMs);
            const composeEnd = Math.min(cc.timelineEndMs, reel.endMs);
            const dur = composeEnd - composeStart;
            if (dur <= 0) continue;
            const sourceIn = cc.sourceInMs + (composeStart - cc.timelineStartMs);
            clips.push({
              id: uuidv4(),
              type: 'audio',
              fileName: audioFileName,
              originalName: audioFileName,
              trackId: 'ra1',
              timelineStartMs: outputOffsetA,
              timelineEndMs: outputOffsetA + dur,
              sourceInMs: sourceIn,
              sourceOutMs: sourceIn + dur,
            });
            outputOffsetA += dur;
          }
        }
        console.log(`[reel-store] enterTimelinePhase: inherited ${composeV1ClipsInRange.length} compose cuts → ${clips.length} reel clips`);
      } else if (videoFileName) {
        // Fallback: single clip spanning the whole source range (no compose
        // edits to inherit, or compose has just one continuous clip here).
        clips.push({
          id: uuidv4(),
          type: 'video',
          fileName: videoFileName,
          originalName: videoFileName,
          trackId: 'rv1',
          timelineStartMs: 0,
          timelineEndMs: reelDur,
          sourceInMs: srcStart,
          sourceOutMs: srcEnd,
        });
        if (audioFileName) {
          clips.push({
            id: uuidv4(),
            type: 'audio',
            fileName: audioFileName,
            originalName: audioFileName,
            trackId: 'ra1',
            timelineStartMs: 0,
            timelineEndMs: reelDur,
            sourceInMs: srcStart,
            sourceOutMs: srcEnd,
          });
        }
      } else if (audioFileName) {
        clips.push({
          id: uuidv4(),
          type: 'audio',
          fileName: audioFileName,
          originalName: audioFileName,
          trackId: 'ra1',
          timelineStartMs: 0,
          timelineEndMs: reelDur,
          sourceInMs: srcStart,
          sourceOutMs: srcEnd,
        });
      }

      // Subtitles filtered by COMPOSE time (baseSegments are in compose time)
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
    }

    set((s) => ({
      reels: updateReelInList(s.reels, reelId, (r) => ({
        ...r,
        composition: { ...r.composition, clips: remainingClips },
        subtitleSegments: segments,
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
    const segments = filterSegmentsToRange(state.baseSegments, reel.startMs, reel.endMs, reel.subtitleConstraints);
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
