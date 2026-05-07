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
 * - manifest.json: { requiredFiles, recommendedFiles, regenerableFiles }
 *     each file ref carries originalPath (where it lived on the source
 *     machine) AND relativePath (where it should land on the new machine).
 *     The restore route uses these to build a full "missing files" report
 *     showing the user exactly what to copy and where.
 * - SRT/ASS files from export/ dir
 * - compose/ media bin files (if small enough)
 * - fonts used by the project subtitle style
 *
 * Does NOT include:
 * - Source video/audio files (too large)              → requiredFiles
 * - Audio intermediates (extracted, mix, amplified…)   → recommendedFiles
 * - Muxed videos (re-derived by re-running mux step)   → regenerableFiles
 * - Exported rendered videos (re-derived from project) → not listed
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

  // File reference shape used in the manifest. originalPath is the absolute path
  // the file had on the source machine — useful when the user is copying media
  // off the original machine. relativePath is project-relative so the restore
  // can compute the destination on the new machine.
  type FileRef = {
    role: string;
    fileName: string;
    originalName?: string;
    size?: number;
    relativePath: string;       // e.g. "source/foo.mov"
    originalPath: string;       // e.g. "/Users/.../projects/<id>/source/foo.mov"
  };

  // Build manifest of referenced files
  const manifest: {
    version: string;
    exportedAt: string;
    projectId: string;
    projectName: string;
    requiredFiles: FileRef[];     // user MUST copy these for the project to work
    recommendedFiles: FileRef[];  // SKIP audio reprocess if copied (still optional)
    regenerableFiles: FileRef[];  // muxed video etc — derivable from required+recommended
    includedFiles: string[];
  } = {
    version: '2.0',
    exportedAt: new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    requiredFiles: [],
    recommendedFiles: [],
    regenerableFiles: [],
    includedFiles: ['project.json', 'manifest.json'],
  };

  async function statSize(absPath: string): Promise<number | undefined> {
    try { return (await fs.stat(absPath)).size; } catch { return undefined; }
  }

  // 1. Sources (required) — original camera video + board audio
  for (const source of project.sources) {
    const fileName = source.storedName;
    const absPath = path.join(getProjectDir(id, 'source'), fileName);
    manifest.requiredFiles.push({
      role: source.type === 'video' ? 'cameraVideo' : `source-${source.type ?? 'other'}`,
      fileName,
      originalName: source.originalName,
      size: await statSize(absPath),
      relativePath: `source/${fileName}`,
      originalPath: absPath,
    });
  }

  // 2. Working audio files (recommended) — saves re-running extract / align / mix / amplify
  const audioDir = getProjectDir(id, 'audio');
  const seenAudioNames = new Set<string>();
  const addAudio = async (relPath: string | undefined, role: string) => {
    if (!relPath) return;
    const fileName = path.basename(relPath);
    if (seenAudioNames.has(fileName)) return;
    seenAudioNames.add(fileName);
    const absPath = path.join(audioDir, fileName);
    manifest.recommendedFiles.push({
      role,
      fileName,
      size: await statSize(absPath),
      relativePath: `audio/${fileName}`,
      originalPath: absPath,
    });
  };
  for (const t of project.audio?.extractedTracks ?? []) {
    await addAudio(t.path, 'extractedCameraAudio');
  }
  await addAudio(project.audio?.ambientPath, 'ambientAligned');
  await addAudio(project.audio?.cameraAmbientPath, 'cameraAmbientCleanup');
  await addAudio(project.audio?.amplifiedBoardPath, 'amplifiedBoard');
  await addAudio(project.sync?.mixedAudioPath, 'mixed');
  await addAudio(project.sync?.selectedAudioPath, 'selectedAudio');

  // 3. Muxed video (regenerable) — re-derived by re-running the mux step
  if (project.sync?.muxedVideoPath) {
    const fileName = path.basename(project.sync.muxedVideoPath);
    // Muxed file lives in export/ historically (current default) but legacy
    // projects had it under audio/ — handle both.
    const exportDir = getProjectDir(id, 'export');
    const candidates = [
      { dir: 'export', abs: path.join(exportDir, fileName) },
      { dir: 'audio',  abs: path.join(audioDir, fileName) },
    ];
    for (const c of candidates) {
      const size = await statSize(c.abs);
      if (size !== undefined) {
        manifest.regenerableFiles.push({
          role: 'muxedVideo',
          fileName,
          size,
          relativePath: `${c.dir}/${fileName}`,
          originalPath: c.abs,
        });
        break;
      }
    }
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
