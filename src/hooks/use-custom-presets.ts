'use client';

import { useCallback } from 'react';
import { useProjectStore } from '@/stores/project-store';
import type { SubtitleStyle, CustomStylePreset } from '@/types/project';
import type { StylePreset } from '@/config/subtitle-styles';

/**
 * Hook to manage custom subtitle style presets stored in the project.
 * Returns the presets array and save/delete handlers that persist to project.json.
 */
export function useCustomPresets(projectId: string) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const updateCurrentProject = useProjectStore((s) => s.updateCurrentProject);

  const customPresets: StylePreset[] = (currentProject?.customStylePresets ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    thumbnail: p.thumbnail,
    style: p.style,
  }));

  const savePreset = useCallback(
    (name: string, style: SubtitleStyle) => {
      const preset: CustomStylePreset = {
        id: `custom-${Date.now()}`,
        name,
        description: 'Custom',
        thumbnail: name.slice(0, 2).toUpperCase(),
        style: { ...style },
      };
      const existing = currentProject?.customStylePresets ?? [];
      const updated = [...existing, preset];
      updateCurrentProject({ customStylePresets: updated });

      // Also persist to server
      fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customStylePresets: updated }),
      }).catch(() => {});
    },
    [currentProject?.customStylePresets, updateCurrentProject, projectId]
  );

  const deletePreset = useCallback(
    (id: string) => {
      const existing = currentProject?.customStylePresets ?? [];
      const updated = existing.filter((p) => p.id !== id);
      updateCurrentProject({ customStylePresets: updated });

      fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customStylePresets: updated }),
      }).catch(() => {});
    },
    [currentProject?.customStylePresets, updateCurrentProject, projectId]
  );

  return { customPresets, savePreset, deletePreset };
}
