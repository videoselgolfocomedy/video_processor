'use client';

import { useRef, useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useComposeStore } from '@/stores/compose-store';
import { useProjectStore } from '@/stores/project-store';
import { AudioRegionsLane } from '@/components/parts/audio-regions-lane';
import { AudioRegionsProvider, RegionsApplyBar } from '@/components/parts/audio-regions-context';
import { TimelineRuler } from './timeline-ruler';
import { TimelinePlayhead } from './timeline-playhead';
import { TimelineTrack } from './timeline-track';
import { TimelineControls } from './timeline-controls';

interface MultiTrackTimelineProps {
  onSave: () => void;
  saving: boolean;
}

export function MultiTrackTimeline({ onSave, saving }: MultiTrackTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tracks = useComposeStore((s) => s.tracks);
  const zoomLevel = useComposeStore((s) => s.zoomLevel);
  const scrollOffsetMs = useComposeStore((s) => s.scrollOffsetMs);
  const durationMs = useComposeStore((s) => s.durationMs);
  const setZoom = useComposeStore((s) => s.setZoom);
  const setScrollOffset = useComposeStore((s) => s.setScrollOffset);
  const setViewportWidth = useComposeStore((s) => s.setViewportWidth);
  const viewportWidthPx = useComposeStore((s) => s.viewportWidthPx);
  // Audio-region lane: the mesa attenuations / ambient raises of the parts,
  // drawn on this same time axis so they can be deleted and added here.
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const clips = useComposeStore((s) => s.clips);
  const currentTimeMs = useComposeStore((s) => s.currentTimeMs);
  const setCurrentTime = useComposeStore((s) => s.setCurrentTime);
  const hasParts = useProjectStore((s) => (s.currentProject?.parts?.length ?? 0) > 0);
  const v1Clips = useMemo(() => clips.filter((c) => c.trackId === 'v1'), [clips]);

  // Measure viewport width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportWidth(entry.contentRect.width - 120); // minus track header
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [setViewportWidth]);

  // Auto-scroll timeline when playhead moves outside the visible range
  // (e.g. clicking a subtitle, pressing arrows, navigating next/prev)
  useEffect(() => {
    const unsub = useComposeStore.subscribe(
      (state, prevState) => {
        if (state.currentTimeMs === prevState.currentTimeMs) return;
        if (state.isPlaying) return; // During playback, the playhead follows naturally

        const { scrollOffsetMs: offset, viewportWidthPx: vpW, zoomLevel: zoom } = state;
        const visibleMs = vpW / zoom;
        const margin = visibleMs * 0.1; // 10% margin
        const playheadMs = state.currentTimeMs;

        // If playhead is outside the visible window (with margin), re-center
        if (playheadMs < offset + margin || playheadMs > offset + visibleMs - margin) {
          const newOffset = Math.max(0, playheadMs - visibleMs / 2);
          useComposeStore.getState().setScrollOffset(newOffset);
        }
      }
    );
    return unsub;
  }, []);

  // Ctrl+scroll = zoom (centered on playhead), plain scroll = horizontal pan
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.85 : 1.18;
        const newZoom = Math.max(0.01, Math.min(1, zoomLevel * delta));

        // Keep playhead at the same viewport position after zoom
        const store = useComposeStore.getState();
        const playheadMs = store.currentTimeMs;
        const vpWidth = store.viewportWidthPx;
        const visibleMs = vpWidth / newZoom;
        // Center playhead in the viewport
        const newOffset = Math.max(0, Math.min(durationMs, playheadMs - visibleMs / 2));
        setZoom(newZoom);
        setScrollOffset(newOffset);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Horizontal scroll
        const deltaMs = (e.deltaX || e.deltaY) / zoomLevel;
        const newOffset = Math.max(0, Math.min(durationMs, scrollOffsetMs + deltaMs));
        setScrollOffset(newOffset);
      } else {
        // Normal vertical scroll → horizontal pan — unless the tracks overflow
        // the pane: then the wheel scrolls them like any list (Shift+wheel and
        // sideways trackpad still pan).
        const el = containerRef.current;
        if (el && el.scrollHeight > el.clientHeight + 1) return;
        const deltaMs = e.deltaY / zoomLevel;
        const newOffset = Math.max(0, Math.min(durationMs, scrollOffsetMs + deltaMs));
        setScrollOffset(newOffset);
      }
    },
    [zoomLevel, scrollOffsetMs, durationMs, setZoom, setScrollOffset]
  );

  const stemTracksPresent = tracks.some((t) => t.id === 'a_mesa' || t.id === 'a_amb');
  const body = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-shrink-0">
        <TimelineControls onSave={onSave} saving={saving} />
      </div>

      {/* Fills the bottom half of the screen; scrolls vertically only when
          there are more tracks than fit, with the ruler pinned on top. */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden select-none"
        onWheel={handleWheel}
      >
        <div className="sticky top-0 z-40 bg-background">
          <TimelineRuler />
        </div>

        {/* Tracks */}
        <div className="relative">
          {tracks.map((track) => (
            <TimelineTrack key={track.id} track={track} />
          ))}

          {/* Fallback lane for mesa/ambiente regions while the stems are not separated */}
          <AudioRegionsLane />

          {/* Playhead line spanning all tracks */}
          <TimelinePlayhead />
        </div>
        <RegionsApplyBar />
      </div>
    </div>
  );
  if (!hasParts || !projectId) return body;
  return (
    <AudioRegionsProvider
      projectId={projectId}
      videoClips={v1Clips}
      scrollOffsetMs={scrollOffsetMs}
      zoomLevel={zoomLevel}
      playheadMs={currentTimeMs}
      viewportWidthPx={viewportWidthPx}
      onSeek={setCurrentTime}
      stemTracksPresent={stemTracksPresent}
    >
      {body}
    </AudioRegionsProvider>
  );
}
