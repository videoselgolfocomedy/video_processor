import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { getProject, getProjectDir } from '@/server/project-manager';
import { OVERLAY_ASSETS_DIR, ensureOverlayAssetsDir } from '@/server/settings-manager';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** Reject any assetId that could escape the assets dir. */
function isSafeAssetId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(id);
}

/**
 * GET /api/settings/overlay-templates/asset?id=<assetId>
 * Serves a stored overlay-template image asset (for picker thumbnails and
 * preview). assetId is the on-disk filename, e.g. "<uuid>.png".
 */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id || !isSafeAssetId(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const filePath = path.join(OVERLAY_ASSETS_DIR, id);
  try {
    const buf = await fs.readFile(filePath);
    const ext = path.extname(id).toLowerCase();
    return new NextResponse(buf, {
      headers: {
        'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'asset not found' }, { status: 404 });
  }
}

/**
 * POST /api/settings/overlay-templates/asset
 * Body: { projectId: string, fileName: string }
 *
 * Copies an image overlay file that currently lives in a project directory
 * into the GLOBAL overlay-asset store, returning a stable assetId. Called when
 * saving an image overlay into a template so the template no longer depends on
 * the source project's files.
 */
export async function POST(request: NextRequest) {
  try {
    const { projectId, fileName } = await request.json();
    if (!projectId || !fileName || typeof fileName !== 'string') {
      return NextResponse.json({ error: 'projectId and fileName required' }, { status: 400 });
    }
    // Guard against path traversal in fileName.
    if (fileName.includes('/') || fileName.includes('..')) {
      return NextResponse.json({ error: 'invalid fileName' }, { status: 400 });
    }
    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: 'project not found' }, { status: 404 });
    }
    const srcPath = path.join(getProjectDir(projectId), fileName);
    const buf = await fs.readFile(srcPath).catch(() => null);
    if (!buf) {
      return NextResponse.json({ error: 'source image not found' }, { status: 404 });
    }
    const ext = (path.extname(fileName) || '.png').toLowerCase();
    const assetId = `${randomUUID()}${ext}`;
    await ensureOverlayAssetsDir();
    await fs.writeFile(path.join(OVERLAY_ASSETS_DIR, assetId), buf);
    return NextResponse.json({ assetId, ext, originalName: fileName });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
