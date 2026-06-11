'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CompositionClip, CompositionTrack, OverlayTemplate, OverlayTemplateItem } from '@/types/project';

/* ─────────────────────────── REST helpers ─────────────────────────── */

async function fetchTemplates(): Promise<OverlayTemplate[]> {
  try {
    const res = await fetch('/api/settings/overlay-templates');
    if (!res.ok) return [];
    const data = await res.json();
    return (data.templates ?? []) as OverlayTemplate[];
  } catch {
    return [];
  }
}

async function persistTemplates(templates: OverlayTemplate[]): Promise<void> {
  await fetch('/api/settings/overlay-templates', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templates }),
  }).catch(() => {});
}

/* ──────────────────── Build items from reel clips ──────────────────── */

/** Is this clip an overlay (text or image/gif on an overlay track)? */
export function isOverlayClip(c: CompositionClip): boolean {
  if (c.type === 'text') return true;
  if ((c.type === 'image' || c.type === 'gif') && c.trackId.startsWith('ri')) return true;
  return false;
}

/**
 * Content duration (ms) of a reel's timeline: the end of the last main-video
 * clip (rv1). Falls back to the max end across all clips when there are no
 * rv1 clips yet. Used to anchor template items to the reel's start/end.
 */
export function reelTimelineDurationMs(clips: CompositionClip[]): number {
  const video = clips.filter((c) => c.trackId === 'rv1');
  const pool = video.length > 0 ? video : clips;
  if (pool.length === 0) return 0;
  return Math.max(...pool.map((c) => c.timelineEndMs));
}

/**
 * Convert a set of reel composition clips into template items. Image overlays
 * have their bytes copied into the global asset store (so the template is
 * project-independent); text overlays are fully self-contained. Times are
 * normalised so the earliest overlay sits at startOffsetMs = 0.
 */
export async function buildTemplateItems(
  clips: CompositionClip[],
  projectId: string
): Promise<OverlayTemplateItem[]> {
  const overlays = clips.filter(isOverlayClip);
  if (overlays.length === 0) return [];
  const minStart = Math.min(...overlays.map((c) => c.timelineStartMs));

  const items = await Promise.all(
    overlays.map(async (c): Promise<OverlayTemplateItem | null> => {
      const startOffsetMs = c.timelineStartMs - minStart;
      const durationMs = c.timelineEndMs - c.timelineStartMs;
      if (c.type === 'text') {
        return {
          type: 'text',
          trackKind: 'text',
          startOffsetMs,
          durationMs,
          textContent: c.textContent ?? '',
          textStyle: c.textStyle,
          overlayPosition: c.overlayPosition,
        };
      }
      // image / gif — copy the underlying file into the global asset store
      try {
        const res = await fetch('/api/settings/overlay-templates/asset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, fileName: c.fileName }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return {
          type: c.type === 'gif' ? 'gif' : 'image',
          trackKind: 'image',
          startOffsetMs,
          durationMs,
          overlayPosition: c.overlayPosition,
          opacity: c.opacity,
          imageAssetId: data.assetId,
          originalName: c.originalName ?? data.originalName,
        };
      } catch {
        return null;
      }
    })
  );

  return items.filter((i): i is OverlayTemplateItem => i !== null);
}

/* ─────────────────── Apply a template onto a reel ──────────────────── */

interface ApplyContext {
  reelId: string;
  projectId: string;
  /** Timeline position (ms) where the template's start lands. */
  playheadMs: number;
  reelClips: CompositionClip[];
  reelTracks: CompositionTrack[];
  addTrack: (reelId: string, type: CompositionTrack['type'], label: string) => string;
  addClip: (reelId: string, clip: Omit<CompositionClip, 'id'>) => string;
  /** Anchored mode: instead of inserting the whole block at playheadMs,
   * items from the first half of the SOURCE reel keep their distance from
   * t=0 (intro titles land at the start) and items from the second half keep
   * their distance from the source reel's END, measured against
   * `targetDurationMs` (closing cards land at the end of THIS reel). Needs
   * the template's sourceDurationMs; legacy templates without it fall back
   * to start-anchoring everything. */
  anchorEnds?: boolean;
  /** Content duration (ms) of the target reel — see reelTimelineDurationMs. */
  targetDurationMs?: number;
}

/**
 * Insert every item of a template into the reel at `playheadMs`. Items are
 * lane-packed onto overlay tracks of the right kind so two overlays never
 * collide in time on the same track — reusing existing rt / ri tracks first,
 * creating new ones only when needed. Image assets are copied into the project
 * before their clips are added.
 *
 * Returns the number of overlays inserted.
 */
export async function applyTemplate(template: OverlayTemplate, ctx: ApplyContext): Promise<number> {
  const { reelId, projectId, playheadMs, reelClips, reelTracks, addTrack, addClip, anchorEnds, targetDurationMs } = ctx;

  /**
   * Where does this item start on the TARGET timeline?
   * - Default: the whole block is inserted at playheadMs, keeping relative
   *   spacing (startOffsetMs).
   * - Anchored: reconstruct the item's absolute position in the source reel
   *   (sourceFirstStartMs + startOffsetMs), then anchor by which half of the
   *   source reel its CENTER sat in. Start-half items keep their distance
   *   from t=0; end-half items keep their distance from the source end,
   *   re-measured against the target reel's duration.
   */
  const computeStartMs = (item: OverlayTemplateItem): number => {
    if (!anchorEnds) return Math.max(0, playheadMs + item.startOffsetMs);
    const srcDur = template.sourceDurationMs;
    const firstStart = template.sourceFirstStartMs ?? 0;
    const offsetFromStart = firstStart + item.startOffsetMs;
    if (!srcDur || srcDur <= 0) {
      // Legacy template without span metadata: best effort = everything to
      // the start of the reel, preserving original distances from t=0.
      return Math.max(0, offsetFromStart);
    }
    const center = offsetFromStart + item.durationMs / 2;
    if (center <= srcDur / 2) {
      return Math.max(0, offsetFromStart);
    }
    // Clamp to 0: if the item stuck out past the source video's end (common
    // after trimming the video with overlays already placed), treat it as
    // ending exactly at the end — end-anchored items must FINISH with the
    // video, never start after it.
    const distFromEnd = Math.max(0, srcDur - (offsetFromStart + item.durationMs));
    const targetDur = targetDurationMs && targetDurationMs > 0 ? targetDurationMs : srcDur;
    return Math.max(0, targetDur - distFromEnd - item.durationMs);
  };

  // Pre-resolve image assets → project-local fileNames (network first).
  const resolved = await Promise.all(
    template.items.map(async (item) => {
      if (item.trackKind === 'image' && item.imageAssetId) {
        try {
          const res = await fetch(`/api/projects/${projectId}/reels/import-template-asset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId: item.imageAssetId, originalName: item.originalName }),
          });
          if (!res.ok) return { item, fileName: null as string | null, originalName: item.originalName };
          const data = await res.json();
          return { item, fileName: data.fileName as string, originalName: data.originalName as string };
        } catch {
          return { item, fileName: null as string | null, originalName: item.originalName };
        }
      }
      return { item, fileName: null as string | null, originalName: item.originalName };
    })
  );

  // Lane packing: per track kind, track each lane's last-used end time.
  type Lane = { trackId: string; endMs: number };
  const lanes: Record<'text' | 'image', Lane[]> = { text: [], image: [] };
  const trackType: Record<'text' | 'image', CompositionTrack['type']> = { text: 'text', image: 'image' };
  const trackLabel: Record<'text' | 'image', string> = { text: 'Text Overlay', image: 'Image/Photo' };

  // Seed lanes from existing overlay tracks. Each lane's initial end time is
  // the latest existing clip on that track, so we never drop a template clip
  // on top of an overlay the reel already has — a track is only reused if its
  // current content ends before the new clip starts.
  const lastEndOnTrack = (trackId: string): number => {
    const ends = reelClips.filter((c) => c.trackId === trackId).map((c) => c.timelineEndMs);
    return ends.length ? Math.max(...ends) : -Infinity;
  };
  for (const t of reelTracks) {
    if (t.type === 'text') lanes.text.push({ trackId: t.id, endMs: lastEndOnTrack(t.id) });
    else if (t.type === 'image') lanes.image.push({ trackId: t.id, endMs: lastEndOnTrack(t.id) });
  }

  const pickLane = (kind: 'text' | 'image', startMs: number): string => {
    const pool = lanes[kind];
    const free = pool.find((l) => l.endMs <= startMs);
    if (free) return free.trackId;
    const trackId = addTrack(reelId, trackType[kind], trackLabel[kind]);
    pool.push({ trackId, endMs: -Infinity });
    return trackId;
  };

  // Compute each item's target position first, then insert in chronological
  // TARGET order so lane packing is stable (with anchoring, an end-anchored
  // item can land before a start-anchored one saved later).
  const placed = resolved.map((r) => ({ ...r, startMs: computeStartMs(r.item) }));
  const ordered = placed.sort((a, b) => a.startMs - b.startMs);

  let inserted = 0;
  for (const { item, fileName, originalName, startMs } of ordered) {
    const endMs = startMs + Math.max(100, item.durationMs);
    const kind = item.trackKind;
    const trackId = pickLane(kind, startMs);

    if (item.type === 'text') {
      addClip(reelId, {
        type: 'text',
        fileName: '',
        originalName: 'Text',
        trackId,
        timelineStartMs: startMs,
        timelineEndMs: endMs,
        sourceInMs: 0,
        sourceOutMs: item.durationMs,
        textContent: item.textContent ?? '',
        textStyle: item.textStyle,
        overlayPosition: item.overlayPosition,
      });
    } else {
      // image / gif — skip if the asset failed to import
      if (!fileName) continue;
      addClip(reelId, {
        type: item.type,
        fileName,
        originalName: originalName ?? 'overlay',
        trackId,
        timelineStartMs: startMs,
        timelineEndMs: endMs,
        sourceInMs: 0,
        sourceOutMs: item.durationMs,
        overlayPosition: item.overlayPosition,
        opacity: item.opacity,
      });
    }

    // Advance the chosen lane's end time.
    const lane = lanes[kind].find((l) => l.trackId === trackId);
    if (lane) lane.endMs = endMs;
    inserted++;
  }

  return inserted;
}

/* ───────────────────────────── Hook ────────────────────────────────── */

/**
 * Reactive access to the global overlay-template library. CRUD on the metadata
 * list; image-asset copying is handled by buildTemplateItems / applyTemplate.
 */
export function useOverlayTemplates() {
  const [templates, setTemplates] = useState<OverlayTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const list = await fetchTemplates();
    setTemplates(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await fetchTemplates();
      if (!cancelled) {
        setTemplates(list);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveTemplate = useCallback(
    async (
      name: string,
      kind: 'single' | 'set',
      items: OverlayTemplateItem[],
      /** Source-reel span info enabling anchored apply (see OverlayTemplate). */
      meta?: { sourceDurationMs?: number; sourceFirstStartMs?: number }
    ) => {
      const tpl: OverlayTemplate = {
        id: `ovl-${Date.now()}`,
        name,
        createdAt: new Date().toISOString(),
        kind,
        items,
        ...(meta ?? {}),
      };
      const current = await fetchTemplates();
      const updated = [tpl, ...current];
      await persistTemplates(updated);
      setTemplates(updated);
      return tpl;
    },
    []
  );

  const deleteTemplate = useCallback(async (id: string) => {
    const current = await fetchTemplates();
    const updated = current.filter((t) => t.id !== id);
    await persistTemplates(updated);
    setTemplates(updated);
  }, []);

  const renameTemplate = useCallback(async (id: string, name: string) => {
    const current = await fetchTemplates();
    const updated = current.map((t) => (t.id === id ? { ...t, name } : t));
    await persistTemplates(updated);
    setTemplates(updated);
  }, []);

  return { templates, loading, refresh, saveTemplate, deleteTemplate, renameTemplate };
}
