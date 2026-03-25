'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { useComposeStore } from '@/stores/compose-store';
import { ComposeLayout } from '@/components/compose/compose-layout';
import { Loader2 } from 'lucide-react';

export default function ComposePage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject } = useProjectStore();
  const loadComposition = useComposeStore((s) => s.loadComposition);
  const [loaded, setLoaded] = useState(false);

  // Fetch project data
  useEffect(() => {
    fetchProject(projectId);
  }, [projectId, fetchProject]);

  // Load composition into store when project is ready
  useEffect(() => {
    if (!currentProject || loaded) return;

    const durationMs = getDurationMs(currentProject);

    const videoFileName = getVideoFileName(currentProject);
    const audioFileName = getAudioFileName(currentProject);

    loadComposition(
      currentProject.composition,
      currentProject.transcription.segments,
      durationMs,
      currentProject.youtubeSubtitles.style,
      currentProject.youtubeSubtitles.stylePreset,
      currentProject.transcription.constraints,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (currentProject.composition as any).versions,
      videoFileName,
      audioFileName,
    );
    setLoaded(true);
  }, [currentProject, loaded, loadComposition]);

  if (!currentProject || !loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Build video/audio source URLs
  const videoSrc = getVideoSrc(currentProject, projectId);
  // Always pass audioSrc — the Video component is muted (volume={0}) so audio
  // is handled exclusively by the a1 Audio clips, which respect trim/split/delete.
  const audioSrc = getAudioSrc(currentProject, projectId);
  const subtitleStyle = currentProject.youtubeSubtitles.style;

  return (
    <ComposeLayout
      projectId={projectId}
      videoSrc={videoSrc}
      audioSrc={audioSrc}
      subtitleStyle={subtitleStyle}
    />
  );
}

// Helper: get total duration from project
function getDurationMs(project: {
  sources: Array<{ duration?: number }>;
  sync: { muxedVideoPath?: string };
  audio: { extractedTracks: Array<{ duration: number }> };
  transcription: { segments: Array<{ endMs: number }> };
}): number {
  // If we have transcription segments, use the last segment's end as the content duration
  // This matches the actual audio content (important when muxed with -shortest)
  const segments = project.transcription.segments;
  if (segments.length > 0) {
    const lastEnd = Math.max(...segments.map((s) => s.endMs));
    if (lastEnd > 0) return lastEnd + 2000; // +2s padding
  }

  // Try source video duration
  const videoSource = project.sources.find((s) => 'type' in s && (s as { type: string }).type === 'video');
  if (videoSource?.duration) return videoSource.duration * 1000;

  // Try extracted audio duration
  const track = project.audio.extractedTracks[0];
  if (track?.duration) return track.duration * 1000;

  return 60000; // 1 min fallback
}

function getVideoSrc(project: { sync: { muxedVideoPath?: string }; sources: Array<{ type?: string; storedName: string }> }, projectId: string): string | undefined {
  // Prefer muxed video (cache buster using filename to avoid stale cached video after re-mux)
  if (project.sync.muxedVideoPath) {
    const name = project.sync.muxedVideoPath.split('/').pop();
    return `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(name || '')}&v=${encodeURIComponent(name || '')}`;
  }
  // Fall back to first video source
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

// Get the raw file name (for use as clip fileName in the store)
function getVideoFileName(project: { sync: { muxedVideoPath?: string }; sources: Array<{ type?: string; storedName: string }> }): string | undefined {
  if (project.sync.muxedVideoPath) {
    return project.sync.muxedVideoPath.split('/').pop();
  }
  const videoSource = project.sources.find((s) => (s as { type: string }).type === 'video');
  return videoSource?.storedName;
}

function getAudioFileName(project: { sync: { mixedAudioPath?: string; selectedAudioPath?: string } }): string | undefined {
  const audioPath = project.sync.mixedAudioPath || project.sync.selectedAudioPath;
  if (!audioPath) return undefined;
  return audioPath.split('/').pop();
}
