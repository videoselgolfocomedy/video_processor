import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getProject, getProjectDir } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { buildDuckVolumeExpr } from '@/server/audio-duck';

const execFileAsync = promisify(execFile);

function getFFmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();
  const boardVolume = Number(body.boardVolume ?? 1);
  const ambientVolume = Number(body.ambientVolume ?? 0.5);
  const manualAdjustMs = Number(body.manualAdjustMs ?? 0);
  const useAmplified = Boolean(body.useAmplified);
  const ambientSource: 'raw' | 'subtracted' | 'cleaned' = body.ambientSource ?? 'subtracted';

  // Find board audio path — use amplified version if requested and available
  const boardSource = project.sources.find((s) => s.role === 'board');
  if (!boardSource) {
    return NextResponse.json({ error: 'No hay audio de mesa' }, { status: 400 });
  }

  let boardPath: string | null = null;

  if (useAmplified && project.audio.amplifiedBoardPath) {
    boardPath = project.audio.amplifiedBoardPath;
  } else {
    const boardTrack = project.audio.extractedTracks.find(
      (t) => t.sourceFileId === boardSource.id
    );
    boardPath = boardTrack?.path ||
      (boardSource.type === 'audio'
        ? path.join(getProjectDir(id, 'source'), boardSource.storedName)
        : null);
  }

  if (!boardPath) {
    return NextResponse.json({ error: 'Audio de mesa no disponible' }, { status: 400 });
  }

  // Resolve ambient audio path based on selected source
  let ambientPath: string | null = null;
  switch (ambientSource) {
    case 'raw': {
      // Use raw extracted camera audio (no subtraction applied)
      const cameraSource = project.sources.find((s) => s.role === 'camera' && s.type === 'video');
      if (cameraSource) {
        const cameraTrack = project.audio.extractedTracks.find(
          (t) => t.sourceFileId === cameraSource.id
        );
        ambientPath = cameraTrack?.path ?? null;
      }
      if (!ambientPath) {
        return NextResponse.json(
          { error: 'No hay audio de cámara extraído.' },
          { status: 400 }
        );
      }
      break;
    }
    case 'cleaned':
      ambientPath = project.audio.cameraAmbientPath ?? null;
      if (!ambientPath) {
        return NextResponse.json(
          { error: 'No hay audio de ambiente limpio. Ejecuta la limpieza primero.' },
          { status: 400 }
        );
      }
      break;
    case 'subtracted':
    default:
      ambientPath = project.audio.ambientPath ?? null;
      if (!ambientPath) {
        return NextResponse.json(
          { error: 'No hay audio ambiente. Ejecuta la sustracción primero.' },
          { status: 400 }
        );
      }
      break;
  }

  // Total offset = auto alignment + manual fine-tune
  // When using raw camera audio (no subtraction), skip auto alignment offset
  // since it's only computed during the subtraction process
  const autoOffsetMs = ambientSource === 'raw' ? 0 : (project.audio.alignmentOffsetMs ?? 0);
  const totalOffsetMs = autoOffsetMs + manualAdjustMs;
  const offsetSec = Math.max(0, totalOffsetMs / 1000);

  const audioDir = getProjectDir(id, 'audio');
  const ambientName = path.basename(ambientPath, path.extname(ambientPath));
  const adjustStr = manualAdjustMs !== 0 ? `_adj${manualAdjustMs}` : '';
  const srcTag = ambientSource !== 'subtracted' ? `_${ambientSource}` : '';
  const outputPath = path.join(
    audioDir,
    `mix_${ambientName}${srcTag}_bv${boardVolume}_av${ambientVolume}${adjustStr}.wav`
  );

  const job = jobManager.createJob(id, 'mix-preview');
  jobManager.startJob(job.id);

  (async () => {
    try {
      jobManager.updateProgress(job.id, 10,
        `Mezclando (offset: ${(totalOffsetMs / 1000).toFixed(2)}s, adj: ${manualAdjustMs}ms)...`
      );

      const ffmpeg = getFFmpegPath();

      // Board ducking envelope: attenuate the mesa in the user's marked/detected
      // filler regions ("je-je"/"eehh"). New order is duck → amplify → mix, so the
      // AMPLIFIED board already has the ducking baked in (see the amplify route) —
      // only duck HERE when mixing the RAW board (no amplify). Applied before the
      // atrim so region times are absolute in the board wav.
      const usingAmplified = useAmplified && !!project.audio.amplifiedBoardPath;
      const duckExpr = usingAmplified ? null : buildDuckVolumeExpr(project.audio.boardDuckRegions);
      const duckChain = duckExpr ? `volume=eval=frame:volume='${duckExpr}',` : '';
      if (duckExpr) {
        const active = (project.audio.boardDuckRegions ?? []).filter((r) => r.enabled).length;
        console.log(`[mix-preview] ducking ${active} raw board region(s)`);
      }

      // FFmpeg filter_complex:
      // 1. Duck the board in filler regions (optional), then trim from total
      //    offset (auto + manual) for precise sync
      // 2. Reset timestamps after trim
      // 3. Adjust volumes
      // 4. Mix using shortest duration (= ambient length)
      // Ambient BOOST envelope: raise the audience/laughs in the user's marked
      // regions (positive dB, per-region fade-in/out) while the mesa voice
      // stays untouched — boosting the whole camera audio echoes the voice.
      // Ambient times are absolute in the ambient wav (= mix timeline, the
      // ambient drives the mix with no trim), so no offset math is needed.
      const boostExpr = buildDuckVolumeExpr(project.audio.ambientBoostRegions);
      const boostChain = boostExpr ? `volume=eval=frame:volume='${boostExpr}',` : '';
      if (boostExpr) {
        const active = (project.audio.ambientBoostRegions ?? []).filter((r) => r.enabled).length;
        console.log(`[mix-preview] boosting ${active} ambient region(s)`);
      }

      // Final transparent peak limiter: with a hot amplified board (bv≥2) and/or
      // ambient boost regions, the SUM can exceed full scale and hard-clip into
      // the pcm16 wav — audible "saturación" exactly at the loud peaks (the
      // boosted laughs), in preview AND export alike. The limiter only engages
      // on would-be-clipping peaks, so normal material is untouched. Same
      // params as the amplify chain's limiter.
      const filterComplex = [
        `[0:a]${duckChain}atrim=start=${offsetSec},asetpts=PTS-STARTPTS,volume=${boardVolume}[board]`,
        `[1:a]${boostChain}volume=${ambientVolume}[amb]`,
        `[board][amb]amix=inputs=2:duration=shortest,alimiter=limit=0.95:attack=5:release=50[out]`,
      ].join(';');

      const args = [
        '-i', boardPath,
        '-i', ambientPath,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-acodec', 'pcm_s16le',
        '-ar', '48000',
        '-y',
        outputPath,
      ];

      await execFileAsync(ffmpeg, args, { timeout: 600000 });

      jobManager.completeJob(job.id, { outputPath });
    } catch (err) {
      jobManager.failJob(job.id, (err as Error).message);
    }
  })();

  return NextResponse.json({ jobId: job.id, outputName: path.basename(outputPath) });
}
