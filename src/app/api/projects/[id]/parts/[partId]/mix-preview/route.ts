import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getProject, getProjectDir } from '@/server/project-manager';
import { getFFmpegPath, probeFile } from '@/server/ffmpeg-wrapper';
import { buildPartMixFilter, measureBoardWindow, measureMesaGateFloorDb, prepareAmbientGainCurve } from '@/server/part-mix-chain';
import { updatePart } from '@/server/workers/part-worker';
import { partTrims } from '@/lib/part-trims';

const execFileAsync = promisify(execFile);

/**
 * POST /api/projects/[id]/parts/[partId]/mix-preview?startSec=&durSec=
 *
 * Renders a short WINDOW of the part's mix through the EXACT chain that
 * "Mezclar y muxar" runs (same builder: leveler, duck regions, voice-duck,
 * volumes) so the settings can be heard BEFORE committing a full remix.
 * Writes three small wavs in audio/:
 *   part_<id8>_prev_board.wav · part_<id8>_prev_amb.wav · part_<id8>_prev_mix.wav
 * Verified: the previewed window is bit-identical (Δ 0.00 dB) to the same
 * slice of a full mix with the same settings.
 *
 * Mechanics: the window is PRE-CUT into temp wavs and each output rendered in
 * its own single-output pass — this ffmpeg build's multi-output graphs (and
 * input -t bounds) can finish their files and then never exit.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; partId: string }> }
) {
  const { id, partId } = await params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  const part = (project.parts ?? []).find((p) => p.id === partId);
  if (!part) return NextResponse.json({ error: 'Parte no encontrada' }, { status: 404 });
  if (part.alignmentOffsetMs === undefined) {
    return NextResponse.json({ error: 'Alinea la parte antes de previsualizar la mezcla' }, { status: 409 });
  }

  const prefix = `part_${partId.slice(0, 8)}`;
  const audioDir = getProjectDir(id, 'audio');
  const boardWav = path.join(audioDir, `${prefix}_board.wav`);
  const cameraWav = path.join(audioDir, `${part.videoSourceId}_audio.wav`);
  for (const [f, what] of [[boardWav, 'mesa'], [cameraWav, 'cámara']] as const) {
    try { await fs.access(f); } catch {
      return NextResponse.json({ error: `Falta el wav de ${what} — vuelve a Alinear` }, { status: 409 });
    }
  }

  const q = request.nextUrl.searchParams;
  const startSec = Math.max(0, Number(q.get('startSec') ?? 0) || 0);
  const durSec = Math.max(5, Math.min(120, Number(q.get('durSec') ?? 30) || 30));

  const trims = partTrims(part);
  const boardTrimSec = trims.boardTrimMs / 1000;
  const ambientTrimSec = trims.ambientTrimMs / 1000;
  // Always measured (cached by mtime): the leveler curve and the level
  // readouts in the UI are anchored to it, not just the chain.
  // …over the part's window (mix t=0 → mix end), like the full mix.
  const [bd, cd] = await Promise.all([probeFile(boardWav), probeFile(cameraWav)]);
  const winDurSec = Math.max(5, Math.min(bd.duration - boardTrimSec, cd.duration - ambientTrimSec, trims.capMs != null ? trims.capMs / 1000 : Infinity));
  const win = await measureBoardWindow(boardWav, boardTrimSec, winDurSec);
  const boardLUFS = win.lufs;
  const boardNoiseFloorDb = win.floorDb;
  const boardLoudDb = win.loudDb;
  if ((boardLUFS != null && boardLUFS !== part.boardLUFS) || (boardNoiseFloorDb != null && boardNoiseFloorDb !== part.boardNoiseFloorDb) || (boardLoudDb != null && boardLoudDb !== part.boardLoudDb)) {
    await updatePart(id, part.id, {
      ...(boardLUFS != null ? { boardLUFS } : {}),
      ...(boardNoiseFloorDb != null ? { boardNoiseFloorDb } : {}),
      ...(boardLoudDb != null ? { boardLoudDb } : {}),
    });
  }

  const common = {
    part,
    boardVolume: part.boardVolume ?? 1,
    ambientVolume: part.ambientVolume ?? 0.7,
    boardTrimSec,
    ambientTrimSec,
    boardLUFS,
    boardNoiseFloorDb,
    boardLoudDb,
    stemDurSec: 0,
    window: { startSec, durSec, prerollSec: 2 },
  };

  const ffmpeg = getFFmpegPath();
  const cutBoard = path.join(audioDir, `${prefix}_prevsrc_b.wav`);
  const cutAmb = path.join(audioDir, `${prefix}_prevsrc_a.wav`);
  const cutCurve = path.join(audioDir, `${prefix}_prevsrc_gain.wav`);
  const cutGate = path.join(audioDir, `${prefix}_prevsrc_mesagate.wav`);
  const outFiles = {
    board: `${prefix}_prev_board.wav`,
    amb: `${prefix}_prev_amb.wav`,
    mix: `${prefix}_prev_mix.wav`,
  };

  try {
    const base = buildPartMixFilter(common);
    // Pre-cut the window (+preroll) from each source — sample-accurate decode.
    for (const [src, seek, dst] of [
      [boardWav, base.boardInputSeekSec, cutBoard],
      [cameraWav, base.ambientInputSeekSec, cutAmb],
    ] as const) {
      await execFileAsync(ffmpeg, [
        '-y', '-v', 'error', '-ss', seek.toFixed(3), '-t', String(base.inputDurSec),
        '-i', src, '-acodec', 'pcm_s16le', '-ar', '48000', dst,
      ], { timeout: 60000, maxBuffer: 1 << 22 });
    }
    // Ambient duck envelope for the cut window (same lookahead logic as the
    // full mix, computed on the pre-cut inputs so timelines match).
    let curveInputs: string[] = [];
    let passArgs: typeof common & { ambientGainCurve?: { gainMax: number }; boardGateCurve?: { inputIndex: number } } = common;
    if (part.ambientDuckOnVoice || part.boardSpeechLevel) {
      // The mesa-gate floor joined the calibration after the other three
      // fields: a part mixed before that has none, and a 30 s window's own p10
      // is mostly voice, not a floor — measure it over the whole part once
      // (one 8 kHz decode of the raw mesa) and persist it.
      let mesaFloorDb = part.ambientVoiceCalibMesaFloorDb;
      if (mesaFloorDb == null && part.boardSpeechLevel && part.ambientVoiceCalibDeltaDb != null) {
        mesaFloorDb = await measureMesaGateFloorDb(common, boardWav, cameraWav, winDurSec);
        await updatePart(id, part.id, { ambientVoiceCalibMesaFloorDb: mesaFloorDb });
        base.log.push(`mesa gate floor measured over the whole part: ${mesaFloorDb.toFixed(1)} dB`);
      }
      const calib = part.ambientVoiceCalibDeltaDb != null && part.ambientVoiceCalibFloorDb != null && part.ambientVoiceCalibLoudDb != null
        ? { deltaDb: part.ambientVoiceCalibDeltaDb, floorDb: part.ambientVoiceCalibFloorDb, loudDb: part.ambientVoiceCalibLoudDb, mesaFloorDb }
        : undefined;
      const prep = await prepareAmbientGainCurve(common, cutBoard, cutAmb, cutCurve, part.ambientRoomFloorDb, calib, cutGate);
      base.log.push(...prep.log);
      const useAmbCurve = !!part.ambientDuckOnVoice;
      curveInputs = [...(useAmbCurve ? ['-i', cutCurve] : []), ...(prep.mesaGate ? ['-i', cutGate] : [])];
      passArgs = {
        ...common,
        ...(useAmbCurve ? { ambientGainCurve: { gainMax: prep.gainMax } } : {}),
        ...(prep.mesaGate ? { boardGateCurve: { inputIndex: useAmbCurve ? 3 : 2 } } : {}),
      };
    }
    // Three solo passes over the cut window.
    for (const [solo, dst] of [
      ['board', outFiles.board], ['ambient', outFiles.amb], ['mix', outFiles.mix],
    ] as const) {
      const w = buildPartMixFilter({ ...passArgs, soloOutput: solo });
      await execFileAsync(ffmpeg, [
        '-y', '-v', 'error', '-i', cutBoard, '-i', cutAmb, ...curveInputs,
        '-filter_complex', w.filter, '-map', '[out]',
        '-acodec', 'pcm_s16le', '-ar', '48000', path.join(audioDir, dst),
      ], { timeout: 60000, maxBuffer: 1 << 22 });
    }
    return NextResponse.json({ files: outFiles, startSec, durSec, log: base.log });
  } catch (err) {
    console.error('[part-mix-preview]', err);
    return NextResponse.json(
      { error: `No se pudo generar la vista previa: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}` },
      { status: 500 },
    );
  } finally {
    for (const f of [cutBoard, cutAmb, cutCurve, cutGate]) {
      try { await fs.unlink(f); } catch { /* ignore */ }
    }
  }
}
