import { NextRequest, NextResponse } from 'next/server';
import { getSettings, saveSettings } from '@/server/settings-manager';
import type { CustomStylePreset } from '@/types/project';

/**
 * GET /api/settings/style-presets → all user-saved style presets (system-wide).
 *
 * These live in settings.json so they're shared across projects. Per the
 * UI copy "save this overlay to reuse in other reels and projects" — that
 * only works if the storage is global. Previously the presets lived in
 * project.customStylePresets, so a preset saved in project A was invisible
 * in project B and lost when the project was deleted/re-restored.
 */
export async function GET() {
  const settings = await getSettings();
  return NextResponse.json({ presets: settings.customStylePresets ?? [] });
}

/**
 * PUT /api/settings/style-presets → replace the full presets list.
 *
 * Body: { presets: CustomStylePreset[] }.
 * Simpler than per-id add/delete endpoints: the client sends the new full
 * array (after add/delete/edit) and the server overwrites. This matches
 * how the existing /api/settings PUT works for the rest of AppSettings.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const presets = (body?.presets ?? []) as CustomStylePreset[];
    if (!Array.isArray(presets)) {
      return NextResponse.json({ error: 'presets must be an array' }, { status: 400 });
    }
    const settings = await getSettings();
    await saveSettings({ ...settings, customStylePresets: presets });
    return NextResponse.json({ ok: true, count: presets.length });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
