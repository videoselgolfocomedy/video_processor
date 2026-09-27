import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { getProject, getProjectDir } from '@/server/project-manager';
import { updatePart } from '@/server/workers/part-worker';
import { measureBoardWindow, prepareAmbientGainCurve } from '@/server/part-mix-chain';
import { probeFile } from '@/server/ffmpeg-wrapper';
import { ensurePartBoardWav } from '@/server/part-files';
import { partTrims } from '@/lib/part-trims';
import type { AmbientAutoRaise, BoardAutoGate } from '@/types/project';

const inflight = new Map<string, Promise<{ autoRaises: AmbientAutoRaise[]; autoGates: BoardAutoGate[] }>>();

/**
 * POST /api/projects/[id]/parts/[partId]/auto-raises
 *
 * Compute the AUTOMATIC ambient raises of a part with its CURRENT settings,
 * WITHOUT mixing: the same envelope analysis the full mix runs (~3 s on a
 * 27-min set, writes the same `part_<id8>_ambgain.wav`), persisted on the
 * part as `ambientAutoRaises` so the editing timeline can draw each raise as
 * a zone and the user can veto it. The timeline calls this once for parts
 * mixed before the worker persisted them. Concurrent calls share one run.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; partId: string }> }
) {
  const { id, partId } = await params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  const part = (project.parts ?? []).find((p) => p.id === partId);
  if (!part) return NextResponse.json({ error: 'Parte no encontrada' }, { status: 404 });
  if (part.alignmentOffsetMs === undefined) {
    return NextResponse.json({ error: 'Alinea la parte primero' }, { status: 409 });
  }
  // The same analysis feeds BOTH the ambient's automatic raises and the mesa
  // gate's closures, so it must run when EITHER is on. With neither, clear both
  // lists so stale boxes never outlive the setting that made them.
  if (!part.ambientDuckOnVoice && !part.boardSpeechLevel) {
    const clearedAt = new Date().toISOString();
    await updatePart(id, partId, {
      ambientAutoRaises: [], ambientAutoRaisesAt: clearedAt,
      boardAutoGates: [], boardAutoGatesAt: clearedAt,
    });
    return NextResponse.json({ autoRaises: [], autoGates: [] });
  }

  const key = `${id}/${partId}`;
  let run = inflight.get(key);
  if (!run) {
    run = (async () => {
      const prefix = `part_${partId.slice(0, 8)}`;
      const audioDir = getProjectDir(id, 'audio');
      await ensurePartBoardWav(id, `${prefix}_board.wav`).catch(() => {});
      const boardWav = path.join(audioDir, `${prefix}_board.wav`);
      const cameraWav = path.join(audioDir, `${part.videoSourceId}_audio.wav`);
      for (const [f, what] of [[boardWav, 'mesa'], [cameraWav, 'cámara']] as const) {
        try { await fs.access(f); } catch { throw new Error(`Falta el wav de ${what} — vuelve a Alinear`); }
      }
      const trims = partTrims(part);
      const boardTrimSec = trims.boardTrimMs / 1000;
      const ambientTrimSec = trims.ambientTrimMs / 1000;
      const [bd, cd] = await Promise.all([probeFile(boardWav), probeFile(cameraWav)]);
      const stemDurSec = Math.min(Math.max(0.1, bd.duration - boardTrimSec), Math.max(0.1, cd.duration - ambientTrimSec), trims.capMs != null ? trims.capMs / 1000 : Infinity);
      const win = await measureBoardWindow(boardWav, boardTrimSec, stemDurSec);
      const boardLUFS = win.lufs;
      const common = {
        part,
        boardVolume: part.boardVolume ?? 1,
        ambientVolume: part.ambientVolume ?? 0.7,
        boardTrimSec,
        ambientTrimSec,
        boardLUFS,
        boardNoiseFloorDb: win.floorDb,
        boardLoudDb: win.loudDb,
        stemDurSec,
      };
      const t0 = Date.now();
      // The 7th argument builds the mesa gate too — without it there are no
      // closures to draw, which is why this route never produced gate boxes.
      const prep = await prepareAmbientGainCurve(
        common, boardWav, cameraWav,
        path.join(audioDir, `${prefix}_ambgain.wav`),
        undefined, undefined,
        path.join(audioDir, `${prefix}_mesagate.wav`),
      );
      for (const line of prep.log) console.log(`[auto-raises ${prefix}] ${line}`);
      console.log(`[auto-raises ${prefix}] ${prep.autoRaises.length} raises, ${prep.autoGates.length} gate closures in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      const decidedAt = new Date().toISOString();
      await updatePart(id, partId, {
        ambientAutoRaises: part.ambientDuckOnVoice ? prep.autoRaises : [],
        ambientAutoRaisesAt: decidedAt,
        boardAutoGates: prep.mesaGate ? prep.autoGates : [],
        boardAutoGatesAt: decidedAt,
        ambientRoomFloorDb: prep.stats.roomFloorDb,
        ambientVoiceCalibDeltaDb: prep.stats.calibDeltaDb,
        ambientVoiceCalibFloorDb: prep.stats.calibFloorDb,
        ambientVoiceCalibLoudDb: prep.stats.calibLoudDb,
        ambientVoiceCalibMesaFloorDb: prep.stats.calibMesaFloorDb,
        ...(boardLUFS != null ? { boardLUFS } : {}),
        ...(win.floorDb != null ? { boardNoiseFloorDb: win.floorDb } : {}),
        ...(win.loudDb != null ? { boardLoudDb: win.loudDb } : {}),
      });
      return { autoRaises: part.ambientDuckOnVoice ? prep.autoRaises : [], autoGates: prep.mesaGate ? prep.autoGates : [] };
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
  }
  try {
    const { autoRaises, autoGates } = await run;
    return NextResponse.json({ autoRaises, autoGates, count: autoRaises.length });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
