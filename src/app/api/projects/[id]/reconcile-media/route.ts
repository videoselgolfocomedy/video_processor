import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { probeFile } from '@/server/ffmpeg-wrapper';

/**
 * POST /api/projects/[id]/reconcile-media
 *
 * Scans the project directory and links existing media files that the
 * project state doesn't reference (because they were dropped in by the user
 * after a partial restore, manual copy, etc).
 *
 * Currently auto-links:
 *  - The most recent `export/muxed_*.mp4` (or `.mov`) when `sync.muxedVideoPath`
 *    is missing OR points to a file that no longer exists.
 *    This is what lets a restored project work from a hand-copied muxed file
 *    without needing the original camera/board sources.
 *
 * Returns the set of fields that were updated and the resulting `sync` snapshot
 * for the frontend to refresh from.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const updatedFields: Record<string, string | number | undefined> = {};
  const messages: string[] = [];
  // Build up sync edits in one batch so we don't issue multiple writes.
  const syncPatch: Partial<typeof project.sync> = {};

  // ── Muxed video ───────────────────────────────────────────────────
  const currentMuxed = project.sync?.muxedVideoPath;
  let muxedOk = false;
  if (currentMuxed) {
    try {
      await fs.access(currentMuxed);
      muxedOk = true;
    } catch { muxedOk = false; }
  }

  if (!muxedOk) {
    // Scan export/ (preferred) and audio/ (legacy) for muxed_*.mp4 / muxed_*.mov.
    // Pick the most recent by mtime.
    const exportDir = getProjectDir(id, 'export');
    const audioDir = getProjectDir(id, 'audio');
    type Candidate = { fullPath: string; mtimeMs: number };
    const candidates: Candidate[] = [];

    for (const dir of [exportDir, audioDir]) {
      let entries: string[] = [];
      try { entries = await fs.readdir(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.startsWith('muxed_')) continue;
        if (!name.endsWith('.mp4') && !name.endsWith('.mov')) continue;
        const fullPath = path.join(dir, name);
        try {
          const stat = await fs.stat(fullPath);
          if (!stat.isFile()) continue;
          candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
        } catch { /* skip */ }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const chosen = candidates[0].fullPath;
      let durationMs: number | undefined;
      try {
        const probe = await probeFile(chosen);
        if (probe.duration > 0) durationMs = Math.round(probe.duration * 1000);
      } catch (err) {
        console.warn(`[reconcile-media] probeFile failed for ${chosen}:`, (err as Error).message);
      }
      syncPatch.muxedVideoPath = chosen;
      if (durationMs) syncPatch.muxedDurationMs = durationMs;
      muxedOk = true;
      updatedFields.muxedVideoPath = chosen;
      if (durationMs) updatedFields.muxedDurationMs = durationMs;
      messages.push(`Linked muxed video: ${path.basename(chosen)}${durationMs ? ` (${Math.round(durationMs / 1000)}s)` : ''}`);
    } else if (currentMuxed) {
      messages.push(`sync.muxedVideoPath was set but file does not exist and no replacement found in export/ or audio/`);
    } else {
      messages.push(`No muxed_*.mp4 found in export/ or audio/. Run Sync & Mix → Mux to generate one.`);
    }
  } else {
    messages.push(`Muxed video already linked: ${path.basename(currentMuxed!)}`);
  }

  // ── Standalone audio paths (mixed / selected) ────────────────────
  // If selectedAudioPath / mixedAudioPath point to a file that doesn't exist
  // on disk, clear them. Reasoning: the muxed video carries the embedded
  // audio, so the reel/compose pages fall back to playing it inline. If we
  // leave a broken path in place, the page mounts an <audio> with a 404 src
  // AND mutes the <video> ("needsSeparateAudio = videoSrc !== audioSrc") —
  // user gets no sound at all even though the muxed has perfect audio.
  // Only clear when the muxed IS available, so we don't silently break a
  // project that happens to be mid-pipeline (no muxed yet, audio still
  // being prepared).
  if (muxedOk) {
    for (const field of ['mixedAudioPath', 'selectedAudioPath'] as const) {
      const p = project.sync?.[field];
      if (!p) continue;
      try {
        await fs.access(p);
      } catch {
        syncPatch[field] = undefined;
        updatedFields[field] = undefined;
        messages.push(`Cleared sync.${field} (file missing: ${path.basename(p)}) — playback will use muxed video's embedded audio`);
      }
    }
  }

  if (Object.keys(syncPatch).length > 0) {
    await updateProject(id, { sync: { ...project.sync, ...syncPatch } });
  }

  const refreshed = await getProject(id);
  return NextResponse.json({
    projectId: id,
    updated: Object.keys(updatedFields).length > 0,
    fields: updatedFields,
    messages,
    sync: refreshed?.sync,
  });
}
