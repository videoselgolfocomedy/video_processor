import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Readable } from 'stream';
import { getProject, getProjectDir, createProject, updateProject } from '@/server/project-manager';
import type { ProjectState } from '@/types/project';

/**
 * GET /api/projects/[id]/backup → Download lightweight project backup (.zip)
 *
 * Includes:
 * - project.json (with paths sanitized to relative)
 * - manifest.json (file references, sizes, checksums)
 * - SRT files from export/ dir
 * - compose/ media bin files (if small enough)
 * - fonts used by the project subtitle style
 *
 * Does NOT include:
 * - Source video/audio files (too large)
 * - Audio intermediates (regenerable)
 * - Muxed videos (regenerable)
 * - Exported rendered videos (regenerable)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const projectDir = getProjectDir(id);

  // Build manifest of referenced files
  const manifest: {
    version: string;
    exportedAt: string;
    projectId: string;
    projectName: string;
    requiredFiles: { role: string; fileName: string; originalName: string; size?: number; path: string }[];
    audioFiles: { name: string; role: string; size?: number }[];
    includedFiles: string[];
  } = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    requiredFiles: [],
    audioFiles: [],
    includedFiles: ['project.json', 'manifest.json'],
  };

  // Catalog source files (not included, but referenced)
  for (const source of project.sources) {
    const sourcePath = path.join(getProjectDir(id, 'source'), source.storedName);
    let size: number | undefined;
    try {
      const stat = await fs.stat(sourcePath);
      size = stat.size;
    } catch { /* file may not exist */ }
    manifest.requiredFiles.push({
      role: source.type || 'other',
      fileName: source.storedName,
      originalName: source.originalName,
      size,
      path: `source/${source.storedName}`,
    });
  }

  // Catalog key audio files (mix, amplified, ambient)
  const audioDir = getProjectDir(id, 'audio');
  const keyAudioFiles: { name: string; role: string }[] = [];
  if (project.sync.selectedAudioPath) {
    const name = path.basename(project.sync.selectedAudioPath);
    keyAudioFiles.push({ name, role: 'selectedAudio' });
  }
  if (project.audio.ambientPath) {
    const name = path.basename(project.audio.ambientPath);
    keyAudioFiles.push({ name, role: 'ambient' });
  }
  if (project.audio.amplifiedBoardPath) {
    const name = path.basename(project.audio.amplifiedBoardPath);
    keyAudioFiles.push({ name, role: 'amplifiedBoard' });
  }
  for (const af of keyAudioFiles) {
    let size: number | undefined;
    try {
      const stat = await fs.stat(path.join(audioDir, af.name));
      size = stat.size;
    } catch { /* */ }
    manifest.audioFiles.push({ ...af, size });
  }

  // Sanitize project.json — convert absolute paths to relative
  const sanitizedProject = sanitizePaths(JSON.parse(JSON.stringify(project)), projectDir);

  // Create zip archive
  const archive = archiver('zip', { zlib: { level: 6 } });

  // Add project.json
  archive.append(JSON.stringify(sanitizedProject, null, 2), { name: 'project.json' });

  // Add SRT files from export dir
  const exportDir = getProjectDir(id, 'export');
  try {
    const exportFiles = await fs.readdir(exportDir);
    for (const f of exportFiles) {
      if (f.endsWith('.srt') || f.endsWith('.ass')) {
        const filePath = path.join(exportDir, f);
        archive.append(createReadStream(filePath), { name: `export/${f}` });
        manifest.includedFiles.push(`export/${f}`);
      }
    }
  } catch { /* export dir may not exist */ }

  // Add compose media bin files (only small files < 10MB)
  const composeDir = getProjectDir(id, 'compose');
  try {
    const composeFiles = await fs.readdir(composeDir);
    for (const f of composeFiles) {
      const filePath = path.join(composeDir, f);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && stat.size < 10 * 1024 * 1024) {
          archive.append(createReadStream(filePath), { name: `compose/${f}` });
          manifest.includedFiles.push(`compose/${f}`);
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* compose dir may not exist */ }

  // Add relevant fonts
  const fontsDir = path.join(process.cwd(), 'fonts');
  const fontFamily = project.youtubeSubtitles?.style?.fontFamily;
  if (fontFamily) {
    try {
      const fontFiles = await fs.readdir(fontsDir);
      const familyLower = fontFamily.toLowerCase().replace(/\s+/g, '');
      for (const f of fontFiles) {
        if (f.toLowerCase().replace(/[-_\s]/g, '').includes(familyLower)) {
          archive.append(createReadStream(path.join(fontsDir, f)), { name: `fonts/${f}` });
          manifest.includedFiles.push(`fonts/${f}`);
        }
      }
    } catch { /* */ }
  }

  // Add manifest
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  archive.finalize();

  // Convert Node stream to Web ReadableStream
  const readable = Readable.toWeb(archive) as ReadableStream;

  const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, '_');

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}_backup.zip"`,
    },
  });
}

/**
 * POST /api/projects/[id]/backup → Import/restore from backup zip
 * Actually creates a NEW project with the backup data.
 * Body: multipart/form-data with 'file' field containing the zip
 *
 * Returns: { projectId, projectName, missingFiles }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // The [id] is 'import' — we use a special route for this
  // Actually, we'll use POST /api/projects/[id]/backup to restore INTO an existing project
  // Or we can create a new project
  const { id } = await params;

  // For now, return info about what would be needed
  return NextResponse.json({ error: 'Import not yet implemented — use project creation + manual restore' }, { status: 501 });
}


/** Replace absolute paths with relative ones */
function sanitizePaths(obj: Record<string, unknown>, projectDir: string): Record<string, unknown> {
  const json = JSON.stringify(obj);
  // Replace all occurrences of the project directory with a placeholder
  const sanitized = json.replace(new RegExp(escapeRegex(projectDir + '/'), 'g'), './');
  // Also replace the project dir without trailing slash
  const sanitized2 = sanitized.replace(new RegExp(escapeRegex(projectDir), 'g'), '.');
  return JSON.parse(sanitized2);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
