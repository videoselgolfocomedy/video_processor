import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { getProject, getProjectDir } from '@/server/project-manager';
import { OVERLAY_ASSETS_DIR } from '@/server/settings-manager';

/** assetId is the on-disk filename in the global store, e.g. "<uuid>.png". */
function isSafeAssetId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(id);
}

/**
 * POST /api/projects/[id]/reels/import-template-asset
 * Body: { assetId: string, originalName?: string }
 *
 * Copies an image asset from the global overlay-template store into THIS
 * project's directory so an applied template's image overlay has a local file
 * to reference (the renderer and preview both load overlay images from the
 * project dir). Returns the new project-local fileName, mirroring the shape of
 * the /reels/upload response.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  try {
    const { assetId, originalName } = await request.json();
    if (!assetId || !isSafeAssetId(assetId)) {
      return NextResponse.json({ error: 'invalid assetId' }, { status: 400 });
    }
    const srcPath = path.join(OVERLAY_ASSETS_DIR, assetId);
    const buf = await fs.readFile(srcPath).catch(() => null);
    if (!buf) {
      return NextResponse.json({ error: 'asset not found' }, { status: 404 });
    }
    const ext = path.extname(assetId).toLowerCase();
    const baseName = (originalName && typeof originalName === 'string' ? originalName : `overlay${ext}`)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `reel_${Date.now()}_${baseName}`;
    await fs.writeFile(path.join(getProjectDir(id), fileName), buf);

    const mime = ext === '.gif' ? 'gif' : 'image';
    return NextResponse.json({ fileName, originalName: baseName, type: mime });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
