'use client';

import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { ExportPanel } from '@/components/export/export-panel';
import { RenderQueue } from '@/components/export/render-queue';
import { useToast } from '@/hooks/use-toast';
import { getPresetById } from '@/config/subtitle-styles';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Smartphone } from 'lucide-react';
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
          body: JSON.stringify({ presetId: preset.id, includeSubtitles, trimInMs, trimOutMs, targetType: 'youtube' }),
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

  const handleExportReel = useCallback(
    async (reelId: string, reelName: string, includeSubtitles: boolean) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            presetId: 'reels',
            includeSubtitles,
            targetType: 'reel',
            reelId,
          }),
        });
        if (!res.ok) throw new Error('Failed to start reel export');
        await fetchProject(projectId);
        toast({ title: `Reel export started: ${reelName}${includeSubtitles ? '' : ' (sin subtítulos)'}` });
      } catch {
        toast({ title: 'Failed to start reel export', variant: 'destructive' });
      }
    },
    [projectId, fetchProject, toast]
  );

  const videoSource = useMemo(
    () => currentProject?.sources.find((s) => s.type === 'video'),
    [currentProject?.sources]
  );

  // Detect compose clips on v1 track
  const composeV1Clips = useMemo(() => {
    const clips = currentProject?.composition?.clips;
    if (!clips || clips.length === 0) return [];
    return clips.filter((c) => c.trackId === 'v1').sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  }, [currentProject?.composition?.clips]);

  const hasComposeEdits = composeV1Clips.length > 0;

  // Use muxed video for compose preview (clips sourceInMs refer to muxed video positions)
  const muxedVideoName = useMemo(() => {
    if (!hasComposeEdits) return undefined;
    const muxedPath = currentProject?.sync?.muxedVideoPath;
    if (!muxedPath) return undefined;
    // Extract filename from absolute path
    return muxedPath.split('/').pop();
  }, [hasComposeEdits, currentProject?.sync?.muxedVideoPath]);

  const videoSrc = useMemo(() => {
    if (muxedVideoName) {
      return `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(muxedVideoName)}`;
    }
    return videoSource
      ? `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(videoSource.storedName)}`
      : undefined;
  }, [videoSource, projectId, muxedVideoName]);

  // Duration: use compose timeline if edits exist, otherwise raw video
  const videoDurationMs = useMemo(() => {
    if (!currentProject) return 10000;

    // Compose-aware duration
    if (composeV1Clips.length > 0) {
      return Math.max(...composeV1Clips.map((c) => c.timelineEndMs));
    }

    // Fallback: raw source duration
    const segments = currentProject.transcription.segments;
    const vDur = videoSource?.duration ? videoSource.duration * 1000 : 0;
    return segments.length > 0
      ? Math.max(...segments.map((s) => s.endMs), vDur)
      : vDur || 10000;
  }, [currentProject, videoSource, composeV1Clips]);

  if (!currentProject) return null;

  const hasContent =
    currentProject.sources.length > 0 ||
    currentProject.transcription.segments.length > 0;

  const stylePreset = getPresetById(currentProject.youtubeSubtitles.stylePreset);

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
        subtitleStyle={currentProject.youtubeSubtitles.style}
        stylePresetName={stylePreset?.name}
        videoSource={videoSource}
        videoSrc={videoSrc}
        durationMs={videoDurationMs}
        composeClipCount={hasComposeEdits ? composeV1Clips.length : undefined}
        composeClips={hasComposeEdits ? composeV1Clips : undefined}
      />

      {/* Reels Export */}
      {currentProject.reels.length > 0 && (
        <ReelsExportCard
          reels={currentProject.reels}
          onExport={handleExportReel}
        />
      )}

      <RenderQueue
        exports={currentProject.exports}
        projectId={projectId}
        onRefresh={() => fetchProject(projectId)}
      />
    </div>
  );
}

/* ── Reels Export Card ──────────────────────────────────────────────── */

import type { ReelDefinition } from '@/types/project';

function ReelsExportCard({
  reels,
  onExport,
}: {
  reels: ReelDefinition[];
  onExport: (reelId: string, reelName: string, includeSubtitles: boolean) => void;
}) {
  const [subtitlesMap, setSubtitlesMap] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    reels.forEach((r) => { map[r.id] = true; });
    return map;
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Smartphone className="h-4 w-4" />
          Reels (9:16)
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          1080 x 1920 &middot; 30fps &middot; H.264 &middot; CRF 22
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {reels.map((reel) => {
          const durationSec = (reel.endMs - reel.startMs) / 1000;
          const clipCount = reel.composition.clips.filter((c) => c.trackId === 'rv1').length;
          const withSubs = subtitlesMap[reel.id] ?? true;

          return (
            <div
              key={reel.id}
              className="flex items-center justify-between rounded-md border border-border p-3"
            >
              <div className="space-y-0.5">
                <div className="text-xs font-medium">{reel.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {durationSec.toFixed(1)}s &middot; {clipCount} clip{clipCount !== 1 ? 's' : ''} &middot; {reel.subtitleSegments.length} subs
                </div>
                <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={withSubs}
                    onChange={(e) => setSubtitlesMap((m) => ({ ...m, [reel.id]: e.target.checked }))}
                    className="h-3 w-3 rounded"
                  />
                  Include subtitles
                </label>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => onExport(reel.id, reel.name, withSubs)}
              >
                Export
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
