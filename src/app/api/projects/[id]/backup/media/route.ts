import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Readable } from 'stream';
import { getProject, getProjectDir } from '@/server/project-manager';

/**
 * GET /api/projects/[id]/backup/media → Heavy media bundle (.zip)
 *
 * Companion to GET /api/projects/[id]/backup. The lightweight backup ships
 * project state (project.json, ASS, fonts) without the GB-scale media; this
 * endpoint streams ONLY the media at their project-relative paths so the user
 * can drop the contents into any project directory and have everything in the
 * right place.
 *
 * Includes (referenced by project.json):
 *   - source/<all camera + board files>
 *   - audio/<extracted, ambient_aligned, amplified, mix, selected>
 *   - export/muxed_*.mp4 (the synced video referenced by sync.muxedVideoPath)
 *
 * Does NOT include:
 *   - Final renders (export/youtube_*.mp4, export/reels_*.mp4) — re-derivable
 *     from project state by hitting Export.
 *
 * Companion route POST /api/projects/[id]/backup/media applies a media zip to
 * an existing project (extracts into the right subdirectories).
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
  const sourceDir = getProjectDir(id, 'source');
  const audioDir = getProjectDir(id, 'audio');
  const exportDir = getProjectDir(id, 'export');

  const archive = archiver('zip', { zlib: { level: 1 } }); // level 1: fastest, media is already compressed

  // Collect what to put in the zip ─────────────────────────────────
  const seen = new Set<string>(); // dedupe by relativePath
  const addFile = async (relativePath: string, absPath: string) => {
    if (seen.has(relativePath)) return;
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) return;
      seen.add(relativePath);
      archive.append(createReadStream(absPath), { name: relativePath });
    } catch {
      // file missing — skip silently
    }
  };

  // 1. Source files (camera video, board audio, etc)
  for (const source of project.sources) {
    await addFile(`source/${source.storedName}`, path.join(sourceDir, source.storedName));
  }

  // 2. Working audio files (extracted, aligned, mix, amplified)
  const audioRefs: string[] = [];
  for (const t of project.audio?.extractedTracks ?? []) {
    if (t.path) audioRefs.push(path.basename(t.path));
  }
  if (project.audio?.ambientPath) audioRefs.push(path.basename(project.audio.ambientPath));
  if (project.audio?.cameraAmbientPath) audioRefs.push(path.basename(project.audio.cameraAmbientPath));
  if (project.audio?.amplifiedBoardPath) audioRefs.push(path.basename(project.audio.amplifiedBoardPath));
  if (project.sync?.mixedAudioPath) audioRefs.push(path.basename(project.sync.mixedAudioPath));
  if (project.sync?.selectedAudioPath) audioRefs.push(path.basename(project.sync.selectedAudioPath));

  for (const name of audioRefs) {
    await addFile(`audio/${name}`, path.join(audioDir, name));
  }

  // 3. Muxed video (lives in export/ in current default, audio/ in legacy projects)
  if (project.sync?.muxedVideoPath) {
    const fileName = path.basename(project.sync.muxedVideoPath);
    const exportCandidate = path.join(exportDir, fileName);
    const audioCandidate = path.join(audioDir, fileName);
    try {
      await fs.access(exportCandidate);
      await addFile(`export/${fileName}`, exportCandidate);
    } catch {
      try {
        await fs.access(audioCandidate);
        await addFile(`audio/${fileName}`, audioCandidate);
      } catch { /* missing — skip */ }
    }
  }

  // Finalise and stream ─────────────────────────────────────────────
  archive.finalize();
  const readable = Readable.toWeb(archive) as ReadableStream;

  const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}_media.zip"`,
      'X-Project-Id': id,
      'X-Project-Dir': projectDir,
    },
  });
}

/**
 * POST /api/projects/[id]/backup/media → Apply a media zip to this project.
 *
 * Body: multipart/form-data with `file` field containing the zip produced by
 * the GET above (or any zip whose paths are project-relative — e.g.
 * `source/foo.mov`, `audio/mix.wav`, `export/muxed_*.mp4`).
 *
 * The zip's entries are extracted under the project's base directory. Existing
 * files at the same path are overwritten. Returns the list of files written
 * and the list of files skipped.
 *
 * Note: this DOES NOT modify project.json — it just drops binaries into the
 * right subdirectories. Use the regular restore route first for state.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unzipper = require('unzipper');

const ALLOWED_PREFIXES = ['source/', 'audio/', 'export/', 'compose/', 'transcription/'];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  const projectDir = getProjectDir(id);

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const directory = await unzipper.Open.buffer(buffer);

    const written: { path: string; size: number }[] = [];
    const skipped: { path: string; reason: string }[] = [];

    for (const entry of directory.files) {
      const entryPath: string = entry.path;
      if (entry.type === 'Directory') continue;

      // Reject entries that aren't in an allowed project subdirectory or that
      // try to escape via .. — basic safety against malicious zips.
      const normalised = path.posix.normalize(entryPath);
      if (normalised.startsWith('..') || normalised.startsWith('/') || normalised.includes('/../')) {
        skipped.push({ path: entryPath, reason: 'unsafe path' });
        continue;
      }
      if (!ALLOWED_PREFIXES.some((p) => normalised.startsWith(p))) {
        skipped.push({ path: entryPath, reason: 'not a project subdirectory' });
        continue;
      }

      const targetPath = path.join(projectDir, normalised);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const content = await entry.buffer();
      await fs.writeFile(targetPath, content);
      written.push({ path: normalised, size: content.length });
    }

    return NextResponse.json({
      projectId: id,
      projectDir,
      written,
      skipped,
      message: `Extraídos ${written.length} archivos al proyecto.`,
    });
  } catch (err) {
    console.error('[backup/media import] Error:', err);
    return NextResponse.json(
      { error: `Failed to import media zip: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
