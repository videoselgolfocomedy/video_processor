import { NextResponse } from 'next/server';
import { listProjects } from '@/server/project-manager';
import { getSettings, saveSettings } from '@/server/settings-manager';
import type { CustomStylePreset } from '@/types/project';

/**
 * POST /api/settings/style-presets/import-from-projects
 *
 * One-shot consolidation: scan every project's legacy per-project
 * `customStylePresets` and merge any that aren't already in the global
 * settings.json store. Custom style presets used to live per-project; they
 * now live globally (shared across all projects). The per-project →
 * global migration only runs when a given project is opened, so presets
 * saved in a project that hasn't been re-opened since the upgrade are
 * invisible to new projects. This endpoint pulls them all in at once.
 *
 * Dedupe is by preset id, then by name (so the same preset saved under
 * different ids in different projects doesn't appear twice). Existing
 * global presets win. Does NOT clear the per-project copies (harmless;
 * the per-project migration on open will clear them later).
 */
export async function POST() {
  const settings = await getSettings();
  const global: CustomStylePreset[] = settings.customStylePresets ?? [];

  const seenIds = new Set(global.map((p) => p.id));
  const seenNames = new Set(global.map((p) => p.name.trim().toLowerCase()));

  const projects = await listProjects();
  const added: { name: string; fromProject: string }[] = [];
  const merged = [...global];

  for (const project of projects) {
    const legacy = project.customStylePresets ?? [];
    for (const preset of legacy) {
      const nameKey = preset.name.trim().toLowerCase();
      if (seenIds.has(preset.id) || seenNames.has(nameKey)) continue;
      seenIds.add(preset.id);
      seenNames.add(nameKey);
      merged.push(preset);
      added.push({ name: preset.name, fromProject: project.name });
    }
  }

  if (added.length > 0) {
    await saveSettings({ ...settings, customStylePresets: merged });
  }

  return NextResponse.json({
    ok: true,
    totalPresets: merged.length,
    addedCount: added.length,
    added,
    message: added.length > 0
      ? `Importados ${added.length} preset(s) al store global. Ahora están disponibles en todos los proyectos.`
      : 'No había presets nuevos que importar.',
  });
}
