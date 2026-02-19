'use client';

import { useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { ExportPanel } from '@/components/export/export-panel';
import { RenderQueue } from '@/components/export/render-queue';
import { useToast } from '@/hooks/use-toast';
import { getPresetById } from '@/config/subtitle-styles';
import type { ExportPreset } from '@/types/project';

export default function ExportPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject } = useProjectStore();
  const { toast } = useToast();

  const handleExport = useCallback(
    async (preset: ExportPreset, includeSubtitles: boolean, trimInMs: number, trimOutMs: number) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ presetId: preset.id, includeSubtitles, trimInMs, trimOutMs }),
        });
        if (!res.ok) throw new Error('Failed to start export');
        await fetchProject(projectId);
        toast({ title: `Export started: ${preset.name}${includeSubtitles ? '' : ' (sin subtítulos)'}` });
      } catch {
        toast({ title: 'Failed to start export', variant: 'destructive' });
      }
    },
    [projectId, fetchProject, toast]
  );

  const videoSource = useMemo(
    () => currentProject?.sources.find((s) => s.type === 'video'),
    [currentProject?.sources]
  );

  const videoSrc = useMemo(
    () =>
      videoSource
        ? `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(videoSource.storedName)}`
        : undefined,
    [videoSource, projectId]
  );

  const videoDurationMs = useMemo(() => {
    if (!currentProject) return 10000;
    const segments = currentProject.transcription.segments;
    const vDur = videoSource?.duration ? videoSource.duration * 1000 : 0;
    return segments.length > 0
      ? Math.max(...segments.map((s) => s.endMs), vDur)
      : vDur || 10000;
  }, [currentProject, videoSource]);

  if (!currentProject) return null;

  const hasContent =
    currentProject.sources.length > 0 ||
    currentProject.transcription.segments.length > 0;

  const stylePreset = getPresetById(currentProject.transcription.stylePreset);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Export</h2>
        <p className="text-sm text-muted-foreground">
          Render video with subtitles in multiple formats
        </p>
      </div>

      <ExportPanel
        onExport={handleExport}
        disabled={!hasContent}
        segments={currentProject.transcription.segments}
        subtitleStyle={currentProject.transcription.style}
        stylePresetName={stylePreset?.name}
        videoSource={videoSource}
        videoSrc={videoSrc}
        durationMs={videoDurationMs}
      />

      <RenderQueue
        exports={currentProject.exports}
        projectId={projectId}
        onRefresh={() => fetchProject(projectId)}
      />
    </div>
  );
}
