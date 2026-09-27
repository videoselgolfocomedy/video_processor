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
  const refreshBaseSegments = useReelStore((s) => s.refreshBaseSegments);
  const setComposeVersions = useReelStore((s) => s.setComposeVersions);
  const [loaded, setLoaded] = useState(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchProject(projectId);
  }, [projectId, fetchProject]);

  useEffect(() => {
    if (!currentProject) return;

    const videoSource = currentProject.sources.find((s) => s.type === 'video');
    const sourceRes = videoSource?.resolution ?? null;

    // Transcription segments are already in compose timeline time
    // (compose saves them back to transcription.segments when editing).
    const baseSegs = currentProject.transcription.segments;

    // Use compose duration if compose clips exist, otherwise source video duration
    const composeClips = (currentProject.composition?.clips ?? [])
      .filter((c: { trackId: string }) => c.trackId === 'v1');
    // The trim bar's ceiling: the live compose timeline, or the longest NAMED
    // version when a reel built from one reaches further (its startMs/endMs
    // live on that version's timeline).
    const composeVersions = currentProject.composition?.versions ?? [];
    const versionEnds = composeVersions.flatMap((v) => v.clips.filter((c) => c.trackId === 'v1').map((c) => c.timelineEndMs));
    const composeDurationMs = composeClips.length > 0 || versionEnds.length > 0
      ? Math.max(...composeClips.map((c: { timelineEndMs: number }) => c.timelineEndMs), ...versionEnds)
      : 0;
    setComposeVersions(composeVersions);
    // Muxed timeline length wins over the raw video source duration — on
    // parts-concat projects the first video SOURCE is only part 1, so its own
    // duration understates the full joined timeline.
    const sourceDurationMs = currentProject.sync.muxedDurationMs
      ? currentProject.sync.muxedDurationMs
      : videoSource?.duration
        ? videoSource.duration * 1000
        : currentProject.audio.extractedTracks[0]?.duration
          ? currentProject.audio.extractedTracks[0].duration * 1000
          : 60000;
    const durationMs = composeDurationMs > 0 ? composeDurationMs : sourceDurationMs;

    if (!loaded) {
      // First mount: install reels + baseSegments from disk.
      loadReels(currentProject.reels, baseSegs, durationMs, sourceRes);
      setLoaded(true);
    } else {
      // Subsequent project refreshes (e.g. transcription was re-run while
      // the user was on this page): keep `baseSegments` live so the NEXT
      // createReel snapshots against the latest transcription. We
      // deliberately do NOT touch any existing reel's subtitleSegments —
      // those belong to the user and getting silently overwritten on
      // navigation was a real regression.
      refreshBaseSegments(baseSegs, durationMs);
    }
  }, [currentProject, loaded, loadReels, refreshBaseSegments, setComposeVersions]);

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
  // The reel preview plays the muxed video (muted) + the separate aligned
  // audio file. The mux keyframe-snap means the audio must LEAD the video by
  // muxedAudioOffsetMs or the voice lags the mouth by ~1s. Only relevant when
  // the video is the muxed file; with a raw-camera fallback there is no offset.
  const audioOffsetMs = currentProject.sync.muxedVideoPath
    ? (currentProject.sync.muxedAudioOffsetMs ?? 0)
    : 0;

  return (
    <ReelLayout
      projectId={projectId}
      videoSrc={videoSrc}
      audioSrc={audioSrc}
      audioOffsetMs={audioOffsetMs}
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

function getAudioSrc(project: { sync: { mixedAudioPath?: string; selectedAudioPath?: string; muxedVideoPath?: string; audioRev?: number }; sources: Array<{ type?: string; storedName: string }> }, projectId: string): string | undefined {
  const audioPath = project.sync.mixedAudioPath || project.sync.selectedAudioPath;
  if (audioPath) {
    const name = audioPath.split('/').pop();
    // audioRev busts the browser cache after an in-place re-mix (mesa ducking).
    const rev = project.sync.audioRev ? `&v=${project.sync.audioRev}` : '';
    return `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(name || '')}${rev}`;
  }
  // Partes / use-video-directly / restore-from-muxed projects have NO separate
  // audio file — the audio lives INSIDE the muxed video. Fall back to the SAME
  // URL as getVideoSrc (mirrors the compose-page fix) so (a) ReelSetupView can
  // derive an audioFileName and enterTimelinePhase creates the ra1 main-audio
  // clips, and (b) `needsSeparateAudio` stays false in the player (videoSrc ===
  // audioSrc string-equal) so the video keeps playing its embedded audio.
  return getVideoSrc(project, projectId);
}
