import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { probeFile } from '@/server/ffmpeg-wrapper';
import { INBOX_DIR, SUPPORTED_VIDEO_EXTENSIONS, SUPPORTED_EXTENSIONS } from '@/lib/constants';
import type { SourceFile } from '@/types/project';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();
  const { filename, role = 'other', mode = 'move' } = body as {
    filename: string;
    role?: 'camera' | 'board' | 'other';
    mode?: 'move' | 'copy' | 'link';
  };

  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }

  // Prevent path traversal
  const safeName = path.basename(filename);
  const sourcePath = path.join(INBOX_DIR, safeName);

  // Verify file exists
  try {
    await fs.access(sourcePath);
  } catch {
    return NextResponse.json(
      { error: `File not found in inbox: ${safeName}` },
      { status: 404 }
    );
  }

  const ext = path.extname(safeName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${ext}` },
      { status: 400 }
    );
  }

  const fileId = uuidv4();
  const storedName = `${fileId}${ext}`;
  const sourceDir = getProjectDir(id, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  const destPath = path.join(sourceDir, storedName);

  try {
    // Move, copy, or symlink
    if (mode === 'link') {
      // Symlink - file stays in inbox, no disk usage
      await fs.symlink(sourcePath, destPath);
    } else if (mode === 'copy') {
      await fs.copyFile(sourcePath, destPath);
    } else {
      // move (default) - rename if same filesystem, else copy+delete
      try {
        await fs.rename(sourcePath, destPath);
      } catch {
        // Cross-device move: copy then delete
        await fs.copyFile(sourcePath, destPath);
        await fs.unlink(sourcePath);
      }
    }

    const stat = await fs.stat(destPath);

    // Probe file for metadata
    let probe;
    try {
      probe = await probeFile(destPath);
    } catch {
      probe = null;
    }

    const isVideo = SUPPORTED_VIDEO_EXTENSIONS.includes(ext);
    const sourceFile: SourceFile = {
      id: fileId,
      originalName: safeName,
      storedName,
      type: isVideo ? 'video' : 'audio',
      role,
      size: stat.size,
      duration: probe?.duration,
      codec: probe?.codec,
      resolution:
        probe?.width && probe?.height
          ? { width: probe.width, height: probe.height }
          : undefined,
      addedAt: new Date().toISOString(),
    };

    const updatedSources = [...project.sources, sourceFile];
    await updateProject(id, { sources: updatedSources });

    return NextResponse.json(sourceFile, { status: 201 });
  } catch (err) {
    console.error('Import error:', err);
    return NextResponse.json(
      { error: (err as Error).message || 'Failed to import file' },
      { status: 500 }
    );
  }
}
