'use client';

import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '@/stores/project-store';
import type { SubtitleStyle, CustomStylePreset } from '@/types/project';
import type { StylePreset } from '@/config/subtitle-styles';

/**
 * Hook for system-wide custom subtitle style presets, stored in
 * data/settings.json and exposed via /api/settings/style-presets. Presets
 * are shared across all projects — saving one in project A makes it
 * available in project B, and they survive project deletion / re-import.
 *
 * The `projectId` arg is still accepted for back-compat with existing call
 * sites but is no longer used for storage. We do, however, transparently
 * migrate any per-project presets (the legacy location in
 * project.customStylePresets) into the global store on first load, then
 * clear them from the project. That way a user who already saved presets
 * under the old system finds them after this upgrade instead of losing
 * them.
 */
export function useCustomPresets(projectId: string) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const updateCurrentProject = useProjectStore((s) => s.updateCurrentProject);
  const [customPresets, setCustomPresets] = useState<StylePreset[]>([]);

  const toUiPreset = (p: CustomStylePreset): StylePreset => ({
    id: p.id,
    name: p.name,
    description: p.description,
    thumbnail: p.thumbnail,
    style: p.style,
  });

  const persistGlobal = useCallback(async (presets: CustomStylePreset[]) => {
    await fetch('/api/settings/style-presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets }),
    }).catch(() => {});
  }, []);

  // Initial load: pull from the global store. Then migrate any per-project
  // legacy presets that aren't already in the global set.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/style-presets');
        if (!res.ok) return;
        const data = await res.json();
        let globalPresets: CustomStylePreset[] = data.presets ?? [];

        // One-shot migration of legacy per-project presets
        const legacy = currentProject?.customStylePresets ?? [];
        if (legacy.length > 0) {
          const existingIds = new Set(globalPresets.map((p) => p.id));
          const newOnes = legacy.filter((p) => !existingIds.has(p.id));
          if (newOnes.length > 0) {
            globalPresets = [...globalPresets, ...newOnes];
            await persistGlobal(globalPresets);
          }
          // Clear the legacy field on the project so we don't re-migrate
          updateCurrentProject({ customStylePresets: [] });
          await fetch(`/api/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customStylePresets: [] }),
          }).catch(() => {});
        }

        if (!cancelled) setCustomPresets(globalPresets.map(toUiPreset));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
    // currentProject?.customStylePresets is read once for migration; we
    // intentionally don't depend on it to avoid loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const savePreset = useCallback(
    async (name: string, style: SubtitleStyle) => {
      const preset: CustomStylePreset = {
        id: `custom-${Date.now()}`,
        name,
        description: 'Custom',
        thumbnail: name.slice(0, 2).toUpperCase(),
        style: { ...style },
      };
      const res = await fetch('/api/settings/style-presets');
      const current: CustomStylePreset[] = res.ok
        ? (await res.json()).presets ?? []
        : [];
      const updated = [...current, preset];
      await persistGlobal(updated);
      setCustomPresets(updated.map(toUiPreset));
    },
    [persistGlobal]
  );

  const deletePreset = useCallback(
    async (id: string) => {
      const res = await fetch('/api/settings/style-presets');
      const current: CustomStylePreset[] = res.ok
        ? (await res.json()).presets ?? []
        : [];
      const updated = current.filter((p) => p.id !== id);
      await persistGlobal(updated);
      setCustomPresets(updated.map(toUiPreset));
    },
    [persistGlobal]
  );

  return { customPresets, savePreset, deletePreset };
}
