import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { probeFile } from '@/server/ffmpeg-wrapper';

/**
 * POST /api/projects/[id]/use-video-directly
 *
 * "Use this video directly" — for projects where the user imported a single
 * video that ALREADY has its audio mixed in, and wants to skip the whole
 * audio-prep / sync / mux flow. Links the imported video as the project's
 * muxedVideoPath so:
 *  - transcription resolves audio from it (ffmpeg extracts the embedded track),
 *  - compose and reels use it as their source video,
 *  - the transcription preview shows it with audio.
 *
 * Body (optional): { sourceId?: string } to pick a specific video source.
 * Defaults to the camera-role video, else the first video source.
 *
 * No re-encode: the video file stays as-is; we just point sync.muxedVideoPath
 * at it and record its probed duration.
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

  let sourceId: string | undefined;
  try {
    const body = await request.json();
    sourceId = body?.sourceId;
  } catch { /* no body — use defaults */ }

  const videoSources = project.sources.filter((s) => s.type === 'video');
  if (videoSources.length === 0) {
    return NextResponse.json({ error: 'No hay ningún vídeo en el proyecto' }, { status: 400 });
  }
  const chosen =
    (sourceId && videoSources.find((s) => s.id === sourceId)) ||
    videoSources.find((s) => s.role === 'camera') ||
    videoSources[0];

  const sourceDir = getProjectDir(id, 'source');
  const videoPath = path.join(sourceDir, chosen.storedName);
  try {
    await fs.access(videoPath);
  } catch {
    return NextResponse.json({ error: `El archivo de vídeo no existe: ${chosen.storedName}` }, { status: 404 });
  }

  // Probe duration so downstream (player end, compose duration) is correct.
  let durationMs: number | undefined;
  try {
    const probe = await probeFile(videoPath);
    if (probe.duration > 0) durationMs = Math.round(probe.duration * 1000);
  } catch (err) {
    console.warn('[use-video-directly] probe failed:', (err as Error).message);
  }

  const updated = await updateProject(id, {
    sync: {
      ...project.sync,
      muxedVideoPath: videoPath,
      ...(durationMs ? { muxedDurationMs: durationMs } : {}),
      // No keyframe-snap offset: video and its own embedded audio share t=0.
      muxedAudioOffsetMs: 0,
      // The video's own embedded audio is what plays — no separate audio file.
      selectedAudioPath: undefined,
      mixedAudioPath: undefined,
    },
  });

  return NextResponse.json({
    ok: true,
    muxedVideoPath: videoPath,
    durationMs,
    sync: updated?.sync,
    message: `Usando "${chosen.originalName}" directamente${durationMs ? ` (${Math.round(durationMs / 1000)}s)` : ''}. Ya puedes transcribir, componer y hacer reels.`,
  });
}
