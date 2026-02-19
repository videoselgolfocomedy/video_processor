'use client';

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type {
  CompositionClip,
  CompositionTrack,
  MediaBinAsset,
  CompositionState,
  SubtitleSegment,
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

interface ComposeStore {
  // Viewport
  zoomLevel: number;       // px per ms (0.1 = 100px/s)
  scrollOffsetMs: number;
  viewportWidthPx: number;

  // Playback
  currentTimeMs: number;
  isPlaying: boolean;
  durationMs: number;

  // Selection
  selectedClipId: string | null;

  // Drag
  dragState: DragState | null;

  // Data
  tracks: CompositionTrack[];
  clips: CompositionClip[];
  mediaBin: MediaBinAsset[];

  // Subtitles (read from project, editable here)
  subtitleSegments: SubtitleSegment[];

  // Undo/Redo
  undoStack: CompositionClip[][];
  redoStack: CompositionClip[][];

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
  selectClip: (id: string | null) => void;

  // Drag
  setDragState: (state: DragState | null) => void;

  // Clips
  addClip: (clip: Omit<CompositionClip, 'id'>) => string;
  updateClip: (id: string, updates: Partial<CompositionClip>) => void;
  removeClip: (id: string) => void;
  moveClip: (id: string, newStartMs: number, newTrackId?: string) => void;
  trimClip: (id: string, edge: 'in' | 'out', newMs: number) => void;

  // Tracks
  addTrack: (track: CompositionTrack) => void;
  toggleTrackMute: (id: string) => void;
  toggleTrackLock: (id: string) => void;
  toggleTrackVisible: (id: string) => void;

  // Media bin
  addToBin: (asset: MediaBinAsset) => void;
  removeFromBin: (id: string) => void;

  // Subtitles
  setSubtitleSegments: (segments: SubtitleSegment[]) => void;
  updateSubtitleSegment: (id: string, updates: Partial<SubtitleSegment>) => void;

  // Undo/Redo
  pushUndo: () => void;
  undo: () => void;
  redo: () => void;

  // Persistence
  loadComposition: (state: CompositionState, subtitles: SubtitleSegment[], durationMs: number) => void;
  getCompositionState: () => CompositionState;
  markClean: () => void;

  // Helpers
  msToPixel: (ms: number) => number;
  pixelToMs: (px: number) => number;
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
  selectedClipId: null,

  // Drag
  dragState: null,

  // Data
  tracks: [],
  clips: [],
  mediaBin: [],

  // Subtitles
  subtitleSegments: [],

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

  selectClip: (id) => set({ selectedClipId: id }),

  setDragState: (state) => set({ dragState: state }),

  addClip: (clipData) => {
    const id = uuidv4();
    const clip: CompositionClip = { ...clipData, id };
    get().pushUndo();
    set((s) => ({ clips: [...s.clips, clip], dirty: true, selectedClipId: id }));
    return id;
  },

  updateClip: (id, updates) => {
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...updates } : c)),
      dirty: true,
    }));
  },

  removeClip: (id) => {
    get().pushUndo();
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
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
            sourceInMs: c.sourceInMs + trimDelta,
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

  addTrack: (track) => set((s) => ({ tracks: [...s.tracks, track], dirty: true })),

  toggleTrackMute: (id) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, muted: !t.muted } : t)),
      dirty: true,
    })),

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

  pushUndo: () =>
    set((s) => ({
      undoStack: [...s.undoStack.slice(-49), [...s.clips.map((c) => ({ ...c }))]],
      redoStack: [],
    })),

  undo: () =>
    set((s) => {
      if (s.undoStack.length === 0) return s;
      const prev = s.undoStack[s.undoStack.length - 1];
      return {
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, [...s.clips.map((c) => ({ ...c }))]],
        clips: prev,
        dirty: true,
      };
    }),

  redo: () =>
    set((s) => {
      if (s.redoStack.length === 0) return s;
      const next = s.redoStack[s.redoStack.length - 1];
      return {
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, [...s.clips.map((c) => ({ ...c }))]],
        clips: next,
        dirty: true,
      };
    }),

  loadComposition: (state, subtitles, durationMs) =>
    set({
      tracks: state.tracks,
      clips: state.clips,
      mediaBin: state.mediaBin,
      subtitleSegments: subtitles,
      durationMs,
      undoStack: [],
      redoStack: [],
      dirty: false,
      selectedClipId: null,
      currentTimeMs: 0,
      scrollOffsetMs: 0,
    }),

  getCompositionState: () => {
    const s = get();
    return { tracks: s.tracks, clips: s.clips, mediaBin: s.mediaBin };
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
