'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { useReelStore } from '@/stores/reel-store';
import { ReelLayout } from '@/components/reels/reel-layout';
import { Loader2 } from 'lucide-react';

export default function ReelsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject } = useProjectStore();
  const loadReels = useReelStore((s) => s.loadReels);
  const [loaded, setLoaded] = useState(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchProject(projectId);
  }, [projectId, fetchProject]);

  useEffect(() => {
    if (!currentProject || loaded) return;

    const videoSource = currentProject.sources.find((s) => s.type === 'video');
    const sourceRes = videoSource?.resolution ?? null;

    // Transcription segments are already in compose timeline time
    // (compose saves them back to transcription.segments when editing)
    const baseSegs = currentProject.transcription.segments;

    // Use compose duration if compose clips exist, otherwise source video duration
    const composeClips = (currentProject.composition?.clips ?? [])
      .filter((c: { trackId: string }) => c.trackId === 'v1');
    const composeDurationMs = composeClips.length > 0
      ? Math.max(...composeClips.map((c: { timelineEndMs: number }) => c.timelineEndMs))
      : 0;
    const sourceDurationMs = videoSource?.duration
      ? videoSource.duration * 1000
      : currentProject.audio.extractedTracks[0]?.duration
        ? currentProject.audio.extractedTracks[0].duration * 1000
        : 60000;
    const durationMs = composeDurationMs > 0 ? composeDurationMs : sourceDurationMs;

    loadReels(
      currentProject.reels,
      baseSegs,
      durationMs,
      sourceRes
    );
    setLoaded(true);
  }, [currentProject, loaded, loadReels]);

  const handleSave = useCallback(async () => {
    const reels = useReelStore.getState().reels;
    try {
      await fetch(`/api/projects/${projectId}/reels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reels),
      });
      useReelStore.getState().markClean();
    } catch (err) {
      console.error('Failed to save reels:', err);
    }
  }, [projectId]);

  // Auto-save: debounced 3s after any change to reels data
  useEffect(() => {
    const unsub = useReelStore.subscribe((state, prev) => {
      if (state.dirty && state.reels !== prev.reels) {
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = setTimeout(() => {
          if (useReelStore.getState().dirty) {
            handleSave();
          }
        }, 3000);
      }
    });
    return () => {
      unsub();
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [handleSave]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useReelStore.getState().dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  if (!currentProject || !loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Build video/audio source URLs
  const videoSrc = getVideoSrc(currentProject, projectId);
  const audioSrc = getAudioSrc(currentProject, projectId);

  return (
    <ReelLayout
      projectId={projectId}
      videoSrc={videoSrc}
      audioSrc={audioSrc}
      onSave={handleSave}
    />
  );
}

function getVideoSrc(project: { sync: { muxedVideoPath?: string }; sources: Array<{ type?: string; storedName: string }> }, projectId: string): string | undefined {
  // Cache buster using filename to avoid stale cached video after re-mux
  if (project.sync.muxedVideoPath) {
    const name = project.sync.muxedVideoPath.split('/').pop();
    return `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(name || '')}&v=${encodeURIComponent(name || '')}`;
  }
  const videoSource = project.sources.find((s) => (s as { type: string }).type === 'video');
  if (videoSource) {
    return `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(videoSource.storedName)}`;
  }
  return undefined;
}

function getAudioSrc(project: { sync: { mixedAudioPath?: string; selectedAudioPath?: string } }, projectId: string): string | undefined {
  const audioPath = project.sync.mixedAudioPath || project.sync.selectedAudioPath;
  if (!audioPath) return undefined;
  const name = audioPath.split('/').pop();
  return `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(name || '')}`;
}
