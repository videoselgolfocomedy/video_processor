import { NextRequest, NextResponse } from 'next/server';
import { getSettings, saveSettings } from '@/server/settings-manager';
import type { OverlayTemplate } from '@/types/project';

/**
 * GET /api/settings/overlay-templates → all saved overlay templates (global).
 *
 * Overlay templates live in settings.json (not project.json) so a template
 * saved while editing one reel is available in every other reel and project,
 * and survives project deletion / re-import. Image assets referenced by a
 * template are stored under data/overlay-templates/assets/ (see the asset
 * route); this endpoint only handles the metadata list.
 */
export async function GET() {
  const settings = await getSettings();
  return NextResponse.json({ templates: settings.overlayTemplates ?? [] });
}

/**
 * PUT /api/settings/overlay-templates → replace the full templates list.
 *
 * Body: { templates: OverlayTemplate[] }. The client sends the new full array
 * after add/delete/rename and the server overwrites — same pattern as
 * /api/settings/style-presets.
 *
 * Note: this does NOT garbage-collect orphaned image assets. Deleting a
 * template leaves its asset file on disk; harmless (a few KB) and avoids
 * accidentally deleting an asset still referenced by another template.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const templates = (body?.templates ?? []) as OverlayTemplate[];
    if (!Array.isArray(templates)) {
      return NextResponse.json({ error: 'templates must be an array' }, { status: 400 });
    }
    const settings = await getSettings();
    await saveSettings({ ...settings, overlayTemplates: templates });
    return NextResponse.json({ ok: true, count: templates.length });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
