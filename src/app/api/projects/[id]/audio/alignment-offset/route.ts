import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';

/**
 * POST /api/projects/[id]/audio/alignment-offset
 *
 * Manually override the alignment offset between board and camera tracks.
 * The auto-correlation in the subtract worker can fail when the two signals
 * don't share enough energy structure (correlation <0.1 → effectively noise),
 * which produces a random peak. This route lets the user enter the real offset.
 *
 * Body: { offsetMs: number } — positive = mesa empezó antes que la cámara.
 *
 * Side effects:
 *   - Updates `project.audio.alignmentOffsetMs`
 *   - Rewrites `audio/alignment_data.json` so the AlignmentView re-renders
 *     with the corrected offset and overlap.
 *
 * Note: ambient_aligned.wav is NOT regenerated here. In align-only mode that
 * file is just the camera content (trimmed to the overlap), and as long as the
 * camera is shorter than mesa-after-offset (the common case), the file's
 * content is invariant to the offset value.
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

  let body: { offsetMs?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const offsetMs = Number(body.offsetMs);
  if (!Number.isFinite(offsetMs)) {
    return NextResponse.json({ error: 'offsetMs must be a finite number' }, { status: 400 });
  }

  // Update project state
  await updateProject(id, {
    audio: {
      ...project.audio,
      alignmentOffsetMs: offsetMs,
    },
  });

  // Update alignment_data.json so the visualisation reflects the override.
  // We recompute overlap from the new offset using the durations already in
  // the file; envelopes stay the same.
  const audioDir = getProjectDir(id, 'audio');
  const dataPath = path.join(audioDir, 'alignment_data.json');
  let updatedOverlapS: number | undefined;
  try {
    const raw = await fs.readFile(dataPath, 'utf-8');
    const data = JSON.parse(raw) as {
      mic_duration_s?: number;
      camera_duration_s?: number;
      offset_ms?: number;
      offset_seconds?: number;
      coarse_offset_ms?: number;
      fine_offset_ms?: number;
      overlap_s?: number;
      manual_override?: boolean;
    };

    const offsetSec = offsetMs / 1000;
    // Overlap calculation matches align_signals() in subtract_voice.py
    const micDur = data.mic_duration_s ?? 0;
    const camDur = data.camera_duration_s ?? 0;
    let micStart = 0;
    let camStart = 0;
    if (offsetSec > 0) {
      camStart = offsetSec;
    } else {
      micStart = -offsetSec;
    }
    const overlap = Math.max(
      0,
      Math.min(micStart + micDur, camStart + camDur) - Math.max(micStart, camStart)
    );
    updatedOverlapS = Math.round(overlap * 10) / 10;

    const updated = {
      ...data,
      offset_ms: offsetMs,
      offset_seconds: Math.round(offsetSec * 100) / 100,
      fine_offset_ms: offsetMs,
      overlap_s: updatedOverlapS,
      manual_override: true,
    };
    await fs.writeFile(dataPath, JSON.stringify(updated), 'utf-8');
  } catch {
    // alignment_data.json might not exist yet — that's fine, project state was
    // updated, the visualisation just won't have envelopes to draw.
  }

  return NextResponse.json({
    ok: true,
    offsetMs,
    overlapS: updatedOverlapS,
  });
}
