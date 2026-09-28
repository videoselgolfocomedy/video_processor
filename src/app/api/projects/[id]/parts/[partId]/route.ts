import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { getProject, getProjectDir } from '@/server/project-manager';
import { withProjectWrite, partPrefix } from '@/server/workers/part-worker';
import type { ProjectPart, ProjectState } from '@/types/project';

/**
 * PATCH /api/projects/[id]/parts/[partId]
 * Body (all optional): { name, videoSourceId, boardSourceId (null = quitar),
 * boardVolume, ambientVolume }.
 * Changing videoSourceId/boardSourceId resets the part's pipeline results;
 * name/volume changes alone do not.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; partId: string }> }
) {
  const { id, partId } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  }
  const existing = (project.parts ?? []).find((p) => p.id === partId);
  if (!existing) {
    return NextResponse.json({ error: 'Parte no encontrada' }, { status: 404 });
  }
  if (existing.status === 'processing') {
    return NextResponse.json(
      { error: 'La parte se está procesando — espera a que termine o cancela el job' },
      { status: 409 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (body.name !== undefined && typeof body.name !== 'string') {
    return NextResponse.json({ error: 'name inválido' }, { status: 400 });
  }
  if (body.videoSourceId !== undefined) {
    if (
      typeof body.videoSourceId !== 'string' ||
      !project.sources.some((s) => s.id === body.videoSourceId && s.type === 'video')
    ) {
      return NextResponse.json(
        { error: 'Fuente de vídeo no encontrada en el proyecto' },
        { status: 400 }
      );
    }
  }
  const hasBoard = 'boardSourceId' in body;
  if (hasBoard && body.boardSourceId !== null) {
    if (
      typeof body.boardSourceId !== 'string' ||
      !project.sources.some((s) => s.id === body.boardSourceId && s.type === 'audio')
    ) {
      return NextResponse.json(
        { error: 'Fuente de audio de mesa no encontrada en el proyecto' },
        { status: 400 }
      );
    }
  }
  if (body.boardVolume !== undefined && typeof body.boardVolume !== 'number') {
    return NextResponse.json({ error: 'boardVolume debe ser un número' }, { status: 400 });
  }
  if (body.ambientVolume !== undefined && typeof body.ambientVolume !== 'number') {
    return NextResponse.json({ error: 'ambientVolume debe ser un número' }, { status: 400 });
  }
  if (body.boardGainDb !== undefined && typeof body.boardGainDb !== 'number') {
    return NextResponse.json({ error: 'boardGainDb debe ser un número' }, { status: 400 });
  }
  if (body.boardCompress !== undefined && typeof body.boardCompress !== 'boolean') {
    return NextResponse.json({ error: 'boardCompress debe ser booleano' }, { status: 400 });
  }
  if (body.boardSpeechLevel !== undefined && typeof body.boardSpeechLevel !== 'boolean') {
    return NextResponse.json({ error: 'boardSpeechLevel debe ser booleano' }, { status: 400 });
  }
  if (body.boardSpeechLevelDb !== undefined && typeof body.boardSpeechLevelDb !== 'number') {
    return NextResponse.json({ error: 'boardSpeechLevelDb debe ser un número' }, { status: 400 });
  }
  if (body.boardLevelRatio !== undefined && typeof body.boardLevelRatio !== 'number') {
    return NextResponse.json({ error: 'boardLevelRatio debe ser un número' }, { status: 400 });
  }
  if (body.boardLevelKneeDb !== undefined && body.boardLevelKneeDb !== null && typeof body.boardLevelKneeDb !== 'number') {
    return NextResponse.json({ error: 'boardLevelKneeDb debe ser un número o null' }, { status: 400 });
  }
  if (body.boardLevelSilenceDepthDb !== undefined && body.boardLevelSilenceDepthDb !== null && typeof body.boardLevelSilenceDepthDb !== 'number') {
    return NextResponse.json({ error: 'boardLevelSilenceDepthDb debe ser un número o null' }, { status: 400 });
  }
  if (body.boardLevelCeilingDb !== undefined && typeof body.boardLevelCeilingDb !== 'number') {
    return NextResponse.json({ error: 'boardLevelCeilingDb debe ser un número' }, { status: 400 });
  }
  if (body.ambientDuckOnVoice !== undefined && typeof body.ambientDuckOnVoice !== 'boolean') {
    return NextResponse.json({ error: 'ambientDuckOnVoice debe ser booleano' }, { status: 400 });
  }
  if (body.ambientVoiceDuckDb !== undefined && typeof body.ambientVoiceDuckDb !== 'number') {
    return NextResponse.json({ error: 'ambientVoiceDuckDb debe ser un número' }, { status: 400 });
  }
  if (body.ambientVoiceReleaseMs !== undefined && typeof body.ambientVoiceReleaseMs !== 'number') {
    return NextResponse.json({ error: 'ambientVoiceReleaseMs debe ser un número' }, { status: 400 });
  }
  if (body.ambientVoiceAnticipateMs !== undefined && typeof body.ambientVoiceAnticipateMs !== 'number') {
    return NextResponse.json({ error: 'ambientVoiceAnticipateMs debe ser un número' }, { status: 400 });
  }
  for (const k of ['ambientVoiceAttackMs', 'ambientVoiceHoldMs', 'ambientGapBoostDb', 'ambientPreRiseMs', 'ambientGateDb'] as const) {
    if (body[k] !== undefined && typeof body[k] !== 'number') {
      return NextResponse.json({ error: `${k} debe ser un número` }, { status: 400 });
    }
  }
  const validRange = (v: unknown) =>
    v === null || (
      !!v && typeof v === 'object' &&
      typeof (v as { startMs?: unknown }).startMs === 'number' && typeof (v as { endMs?: unknown }).endMs === 'number' &&
      (v as { startMs: number }).startMs >= 0 && (v as { endMs: number }).endMs > (v as { startMs: number }).startMs + 1000
    );
  for (const k of ['videoRangeMs', 'boardRangeMs'] as const) {
    if (body[k] !== undefined && !validRange(body[k])) {
      return NextResponse.json({ error: `${k}: {startMs, endMs} con fin > inicio + 1 s, o null` }, { status: 400 });
    }
  }
  if (body.alignmentOffsetMs !== undefined && typeof body.alignmentOffsetMs !== 'number') {
    return NextResponse.json({ error: 'alignmentOffsetMs debe ser un número (ms; positivo = mesa empieza antes)' }, { status: 400 });
  }
  if (body.boardDuckRegions !== undefined) {
    if (!Array.isArray(body.boardDuckRegions)) {
      return NextResponse.json({ error: 'boardDuckRegions debe ser un array' }, { status: 400 });
    }
    const validRegion = (r: unknown): boolean =>
      !!r && typeof r === 'object' &&
      typeof (r as { id?: unknown }).id === 'string' &&
      typeof (r as { startMs?: unknown }).startMs === 'number' &&
      typeof (r as { endMs?: unknown }).endMs === 'number' &&
      typeof (r as { attenuationDb?: unknown }).attenuationDb === 'number' &&
      typeof (r as { enabled?: unknown }).enabled === 'boolean' &&
      ['manual', 'jeje', 'eehh'].includes((r as { source?: unknown }).source as string);
    if (!body.boardDuckRegions.every(validRegion)) {
      return NextResponse.json({ error: 'boardDuckRegions tiene regiones inválidas' }, { status: 400 });
    }
  }
  for (const field of ['ambientBoostRegions', 'ambientNoRaiseRegions', 'boardKeepOpenRegions'] as const) {
    if (body[field] !== undefined && !Array.isArray(body[field])) {
      return NextResponse.json({ error: `${field} debe ser un array` }, { status: 400 });
    }
  }

  let conflict = false;
  const updated = await withProjectWrite<ProjectState>(id, (p) => {
    const parts = p.parts ?? [];
    const current = parts.find((x) => x.id === partId);
    if (!current) return null;
    if (current.status === 'processing') {
      conflict = true;
      return null;
    }

    const next: ProjectPart = { ...current };
    if (typeof body.name === 'string' && body.name.trim()) {
      next.name = body.name.trim();
    }

    let sourcesChanged = false;
    if (typeof body.videoSourceId === 'string' && body.videoSourceId !== current.videoSourceId) {
      next.videoSourceId = body.videoSourceId;
      sourcesChanged = true;
    }
    if (hasBoard) {
      const newBoard =
        body.boardSourceId === null ? undefined : (body.boardSourceId as string);
      if (newBoard !== current.boardSourceId) {
        next.boardSourceId = newBoard;
        sourcesChanged = true;
      }
    }
    if (typeof body.boardVolume === 'number') next.boardVolume = body.boardVolume;
    if (typeof body.ambientVolume === 'number') next.ambientVolume = body.ambientVolume;
    if (typeof body.boardGainDb === 'number') next.boardGainDb = body.boardGainDb;
    if (typeof body.boardCompress === 'boolean') next.boardCompress = body.boardCompress;
    if (typeof body.boardSpeechLevel === 'boolean') next.boardSpeechLevel = body.boardSpeechLevel;
    if (typeof body.boardGate === 'boolean') next.boardGate = body.boardGate;
    if (typeof body.boardSpeechLevelDb === 'number') next.boardSpeechLevelDb = Math.max(3, Math.min(30, body.boardSpeechLevelDb));
    if (typeof body.boardLevelRatio === 'number') next.boardLevelRatio = Math.max(1.2, Math.min(4, body.boardLevelRatio));
    if (typeof body.boardLevelCeilingDb === 'number') next.boardLevelCeilingDb = Math.max(-12, Math.min(-1, body.boardLevelCeilingDb));
    if (body.boardLevelKneeDb === null) next.boardLevelKneeDb = undefined;
    else if (typeof body.boardLevelKneeDb === 'number') next.boardLevelKneeDb = Math.max(-80, Math.min(-20, body.boardLevelKneeDb));
    if (body.boardLevelSilenceDepthDb === null) next.boardLevelSilenceDepthDb = undefined;
    else if (typeof body.boardLevelSilenceDepthDb === 'number') next.boardLevelSilenceDepthDb = Math.max(6, Math.min(60, body.boardLevelSilenceDepthDb));
    if (typeof body.ambientDuckOnVoice === 'boolean') next.ambientDuckOnVoice = body.ambientDuckOnVoice;
    if (typeof body.ambientVoiceDuckDb === 'number') next.ambientVoiceDuckDb = Math.max(1, Math.min(60, body.ambientVoiceDuckDb));
    if (typeof body.ambientVoiceReleaseMs === 'number') next.ambientVoiceReleaseMs = Math.max(50, Math.min(3000, body.ambientVoiceReleaseMs));
    if (typeof body.ambientVoiceAnticipateMs === 'number') next.ambientVoiceAnticipateMs = Math.max(0, Math.min(1000, body.ambientVoiceAnticipateMs));
    if (typeof body.ambientVoiceAttackMs === 'number') next.ambientVoiceAttackMs = Math.max(5, Math.min(500, body.ambientVoiceAttackMs));
    if (typeof body.ambientVoiceHoldMs === 'number') next.ambientVoiceHoldMs = Math.max(0, Math.min(2000, body.ambientVoiceHoldMs));
    if (typeof body.ambientGapBoostDb === 'number') next.ambientGapBoostDb = Math.max(0, Math.min(12, body.ambientGapBoostDb));
    if (typeof body.ambientPreRiseMs === 'number') next.ambientPreRiseMs = Math.max(0, Math.min(1000, body.ambientPreRiseMs));
    if (typeof body.ambientGateDb === 'number') next.ambientGateDb = Math.max(0, Math.min(30, body.ambientGateDb));
    // Editing ranges. The VIDEO range changes what the part IS (mix + mux
    // cover only that stretch) → a mixed part needs a re-mix; the offset is a
    // property of the two files and stays valid. The MESA range only steers
    // the next Realinear.
    if (body.videoRangeMs !== undefined) {
      const nextRange = (body.videoRangeMs ?? undefined) as ProjectPart['videoRangeMs'];
      if (JSON.stringify(nextRange ?? null) !== JSON.stringify(current.videoRangeMs ?? null)) {
        next.videoRangeMs = nextRange;
        if (current.status === 'done') next.status = 'aligned';
      }
    }
    if (body.boardRangeMs !== undefined) {
      next.boardRangeMs = (body.boardRangeMs ?? undefined) as ProjectPart['boardRangeMs'];
    }
    // Alignment search window (null clears it).
    if (typeof body.alignSearchStartMs === 'number' || body.alignSearchStartMs === null) {
      next.alignSearchStartMs = body.alignSearchStartMs ?? undefined;
    }
    if (typeof body.alignSearchEndMs === 'number' || body.alignSearchEndMs === null) {
      next.alignSearchEndMs = body.alignSearchEndMs ?? undefined;
    }

    // Board ducking regions (je-je / eehh attenuation). Changing them makes the
    // current mix stale, so drop a 'done' part back to 'aligned' — same signal
    // as an offset change — so the UI shows a re-mix is needed.
    if (body.boardDuckRegions !== undefined) {
      const prev = JSON.stringify(current.boardDuckRegions ?? []);
      const nextRegions = body.boardDuckRegions as ProjectPart['boardDuckRegions'];
      next.boardDuckRegions = nextRegions;
      if (JSON.stringify(nextRegions ?? []) !== prev && current.status === 'done') {
        next.status = 'aligned';
      }
    }

    // Ambient boost regions (audience/laughs swell) — same staleness rule.
    if (body.ambientBoostRegions !== undefined) {
      const prev = JSON.stringify(current.ambientBoostRegions ?? []);
      const nextRegions = body.ambientBoostRegions as ProjectPart['ambientBoostRegions'];
      next.ambientBoostRegions = nextRegions;
      if (JSON.stringify(nextRegions ?? []) !== prev && current.status === 'done') {
        next.status = 'aligned';
      }
    }

    // "No automatic raise here" zones — same staleness rule.
    if (body.ambientNoRaiseRegions !== undefined) {
      const prev = JSON.stringify(current.ambientNoRaiseRegions ?? []);
      const nextRegions = body.ambientNoRaiseRegions as ProjectPart['ambientNoRaiseRegions'];
      next.ambientNoRaiseRegions = nextRegions;
      if (JSON.stringify(nextRegions ?? []) !== prev && current.status === 'done') {
        next.status = 'aligned';
      }
    }

    // "Keep the mesa gate open here" zones — same staleness rule.
    if (body.boardKeepOpenRegions !== undefined) {
      const prev = JSON.stringify(current.boardKeepOpenRegions ?? []);
      const nextRegions = body.boardKeepOpenRegions as ProjectPart['boardKeepOpenRegions'];
      next.boardKeepOpenRegions = nextRegions;
      if (JSON.stringify(nextRegions ?? []) !== prev && current.status === 'done') {
        next.status = 'aligned';
      }
    }

    // Manual offset override (audio-prep convention: positive = mesa empieza
    // antes). If the part was already mixed/muxed, drop it back to 'aligned'
    // so the UI signals that a re-mix is needed with the new offset.
    if (typeof body.alignmentOffsetMs === 'number' && body.alignmentOffsetMs !== current.alignmentOffsetMs) {
      next.alignmentOffsetMs = body.alignmentOffsetMs;
      if (current.status === 'done') next.status = 'aligned';
    }

    if (sourcesChanged) {
      // Results reference the old source pair — invalidate them.
      next.status = 'idle';
      next.progress = undefined;
      next.error = undefined;
      next.alignmentOffsetMs = undefined;
      next.alignmentPeakToNoise = undefined;
      next.mixedAudioPath = undefined;
      next.muxedVideoPath = undefined;
      next.muxedDurationMs = undefined;
    }

    return { parts: parts.map((x) => (x.id === partId ? next : x)) };
  });

  if (conflict) {
    return NextResponse.json(
      { error: 'La parte se está procesando — espera a que termine o cancela el job' },
      { status: 409 }
    );
  }
  const part = updated?.parts?.find((x) => x.id === partId);
  if (!part) {
    return NextResponse.json({ error: 'Parte no encontrada' }, { status: 404 });
  }

  // Manual offset override: also rewrite the part's alignment JSON so the
  // AlignmentView waveforms re-render with the corrected offset/overlap
  // (mirrors /audio/alignment-offset for the global pair).
  if (typeof body.alignmentOffsetMs === 'number') {
    const dataPath = path.join(getProjectDir(id, 'audio'), `${partPrefix(partId)}_alignment.json`);
    try {
      const raw = await fs.readFile(dataPath, 'utf-8');
      const data = JSON.parse(raw) as {
        mic_duration_s?: number;
        camera_duration_s?: number;
        mic_origin_s?: number;
        camera_origin_s?: number;
        offset_ms?: number;
        offset_seconds?: number;
        fine_offset_ms?: number;
        overlap_s?: number;
        manual_override?: boolean;
      };
      const offsetSec = body.alignmentOffsetMs / 1000;
      // Overlap on the MESA clock: the (possibly excerpted) envelopes sit at
      // their origins; camera time + offset = mesa time.
      const micStart = data.mic_origin_s ?? 0;
      const micEnd = micStart + (data.mic_duration_s ?? 0);
      const camStart = (data.camera_origin_s ?? 0) + offsetSec;
      const camEnd = camStart + (data.camera_duration_s ?? 0);
      const overlap = Math.max(0, Math.min(micEnd, camEnd) - Math.max(micStart, camStart));
      await fs.writeFile(
        dataPath,
        JSON.stringify({
          ...data,
          offset_ms: body.alignmentOffsetMs,
          offset_seconds: Math.round(offsetSec * 100) / 100,
          fine_offset_ms: body.alignmentOffsetMs,
          overlap_s: Math.round(overlap * 10) / 10,
          manual_override: true,
        }),
        'utf-8'
      );
    } catch {
      // No alignment JSON yet (offset set before first align) — fine.
    }
  }

  return NextResponse.json({ part });
}

/**
 * DELETE /api/projects/[id]/parts/[partId]
 * Removes the part record and best-effort deletes its derived files.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; partId: string }> }
) {
  const { id, partId } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  }
  const existing = (project.parts ?? []).find((p) => p.id === partId);
  if (!existing) {
    return NextResponse.json({ error: 'Parte no encontrada' }, { status: 404 });
  }
  if (existing.status === 'processing') {
    return NextResponse.json(
      { error: 'Cancela el job antes de eliminar la parte' },
      { status: 409 }
    );
  }

  let conflict = false;
  let removed = false;
  await withProjectWrite(id, (p) => {
    const parts = p.parts ?? [];
    const current = parts.find((x) => x.id === partId);
    if (!current) return null;
    if (current.status === 'processing') {
      conflict = true;
      return null;
    }
    removed = true;
    return { parts: parts.filter((x) => x.id !== partId) };
  });

  if (conflict) {
    return NextResponse.json(
      { error: 'Cancela el job antes de eliminar la parte' },
      { status: 409 }
    );
  }
  if (!removed) {
    return NextResponse.json({ error: 'Parte no encontrada' }, { status: 404 });
  }

  // Best-effort cleanup of the part's derived files.
  const prefix = partPrefix(partId);
  const audioDir = getProjectDir(id, 'audio');
  const exportDir = getProjectDir(id, 'export');
  const derivedFiles = [
    path.join(audioDir, `${prefix}_board.wav`),
    path.join(audioDir, `${prefix}_mix.wav`),
    path.join(audioDir, `${prefix}_alignment.json`),
    path.join(exportDir, `${prefix}_muxed.mp4`),
  ];
  await Promise.all(
    derivedFiles.map((f) => fs.unlink(f).catch(() => { /* best-effort */ }))
  );

  return NextResponse.json({ ok: true });
}
