'use client';

import { useCallback } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { SubtitleStyleEditor } from '@/components/subtitles/subtitle-style-editor';
import type { SubtitleStyle } from '@/types/project';

export function YouTubeSubtitlePanel() {
  const { currentProject, updateCurrentProject } = useProjectStore();

  const handleStyleChange = useCallback(
    (style: SubtitleStyle) => {
      if (!currentProject) return;
      updateCurrentProject({
        youtubeSubtitles: { ...currentProject.youtubeSubtitles, style },
      });
    },
    [currentProject, updateCurrentProject]
  );

  const handlePresetChange = useCallback(
    (presetId: string, style: SubtitleStyle) => {
      if (!currentProject) return;
      updateCurrentProject({
        youtubeSubtitles: { ...currentProject.youtubeSubtitles, stylePreset: presetId, style },
      });
    },
    [currentProject, updateCurrentProject]
  );

  if (!currentProject) return null;

  return (
    <div className="p-2">
      <h3 className="text-xs font-medium text-muted-foreground mb-2">YouTube Subtitle Style</h3>
      <SubtitleStyleEditor
        style={currentProject.youtubeSubtitles.style}
        activePreset={currentProject.youtubeSubtitles.stylePreset}
        onChange={handleStyleChange}
        onPresetChange={handlePresetChange}
      />
    </div>
  );
}
