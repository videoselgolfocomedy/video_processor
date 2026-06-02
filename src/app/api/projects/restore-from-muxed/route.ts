import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createProject, getProjectDir, updateProject } from '@/server/project-manager';
import { probeFile } from '@/server/ffmpeg-wrapper';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Disable Next's default body parsing — we stream the upload directly to disk
// so a 30 GB muxed file doesn't get buffered in memory.
export const maxDuration = 1800; // 30 min upload limit (Node default = 4)

/**
 * POST /api/projects/restore-from-muxed
 *
 * Create a NEW project seeded with just a muxed video file. Use this when you
 * have a `muxed_*.mp4` (or `.mov`) from another machine / pipeline run but
 * don't have the original camera/board sources and don't need to re-run the
 * audio pipeline. Lets you continue editing (transcription, compose, reels,
 * export) from the muxed file alone.
 *
 * Body: multipart/form-data
 *   - file:    the muxed video (.mp4 or .mov), required
 *   - name:    optional project name; defaults to the file's basename without
 *              extension or "Muxed YYYY-MM-DD" if that fails
 *
 * Response: the created project's id + dir + sync snapshot.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const providedName = (formData.get('name') as string | null)?.trim();

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const originalName = (file.name || 'muxed').trim();
    const lowerName = originalName.toLowerCase();
    if (!lowerName.endsWith('.mp4') && !lowerName.endsWith('.mov')) {
      return NextResponse.json({ error: 'File must be a .mp4 or .mov video' }, { status: 400 });
    }

    // Derive a project name when none was given. Strip "muxed_<timestamp>"
    // prefix and the extension; if nothing meaningful is left, use a date.
    let projectName = providedName;
    if (!projectName) {
      const base = path.basename(originalName, path.extname(originalName));
      const stripped = base.replace(/^muxed_\d+/, '').replace(/^[_\-\s]+/, '').trim();
      projectName = stripped || `Muxed ${new Date().toISOString().slice(0, 10)}`;
    }

    // 1. Create the project shell (folder + project.json + subdirs).
    const project = await createProject(projectName);
    const exportDir = getProjectDir(project.id, 'export');
    await fs.mkdir(exportDir, { recursive: true });

    // 2. Stream the upload to export/muxed_<timestamp>.<ext>.
    const ext = lowerName.endsWith('.mov') ? '.mov' : '.mp4';
    const ts = Date.now();
    const muxedFilename = `muxed_${ts}${ext}`;
    const muxedPath = path.join(exportDir, muxedFilename);

    // Stream the File body chunk-by-chunk so the 30 GB doesn't all sit in RAM.
    const reader = file.stream().getReader();
    const writer = createWriteStream(muxedPath);
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.length;
          const ok = writer.write(value);
          if (!ok) await new Promise<void>((resolve) => writer.once('drain', () => resolve()));
        }
      }
    } finally {
      writer.end();
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });
    }
    console.log(`[restore-from-muxed] Wrote ${totalBytes} bytes to ${muxedPath}`);

    // 3. Probe the file for duration + codec info, and synthesize a single
    //    "source" entry so pages that expect at least one source don't break.
    let durationMs: number | undefined;
    let codec: string | undefined;
    let width: number | undefined;
    let height: number | undefined;
    try {
      const probe = await probeFile(muxedPath);
      if (probe.duration > 0) durationMs = Math.round(probe.duration * 1000);
      codec = probe.codec;
      width = probe.width;
      height = probe.height;
    } catch (err) {
      console.warn(`[restore-from-muxed] probeFile failed:`, (err as Error).message);
    }

    // 4. Synthesize a source entry pointing at the muxed file. This isn't the
    //    original camera capture, but several pages (overview, etc) iterate
    //    project.sources expecting at least one entry with role=camera. The
    //    file lives in export/ not source/ — we point at it directly via an
    //    absolute path stored only in the source record (audio/ + sync paths
    //    are left empty since we don't have the originals).
    const syntheticSourceId = uuidv4();
    const updatedProject = await updateProject(project.id, {
      sources: [
        {
          id: syntheticSourceId,
          originalName,
          storedName: muxedFilename, // referenced relative to export/ via muxedVideoPath
          type: 'video',
          role: 'camera',
          size: totalBytes,
          duration: durationMs ? durationMs / 1000 : undefined,
          codec,
          resolution: width && height ? { width, height } : undefined,
          addedAt: new Date().toISOString(),
        },
      ],
      sync: {
        ...project.sync,
        muxedVideoPath: muxedPath,
        ...(durationMs ? { muxedDurationMs: durationMs } : {}),
      },
    });

    return NextResponse.json({
      projectId: project.id,
      projectDir: getProjectDir(project.id),
      projectName,
      muxedPath,
      muxedFilename,
      durationMs,
      sync: updatedProject?.sync,
      message: `Proyecto creado desde muxed. ${durationMs ? `Duración: ${Math.round(durationMs / 1000)}s.` : ''} Puedes transcribir, componer, hacer reels y exportar; no podrás re-muxear ni re-aplicar el pipeline de audio porque no hay fuentes originales.`,
    });
  } catch (err) {
    console.error('[restore-from-muxed] Error:', err);
    return NextResponse.json(
      { error: `Failed to restore from muxed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
