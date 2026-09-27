import { spawn, execFile, ChildProcess } from 'child_process';
import { partTrims, videoRangeKey } from '@/lib/part-trims';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { extractAudio, probeFile } from '@/server/ffmpeg-wrapper';
import { buildPartMixFilter, measureBoardWindow, prepareAmbientGainCurve } from '@/server/part-mix-chain';
import { describeBoardChain, describeAmbientChain, describeMixChain } from '@/lib/part-chain-description';
import type { ProjectState, ProjectPart } from '@/types/project';

const execFileAsync = promisify(execFile);

function getFFmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
}

function getFFprobePath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffprobe-static').path as string;
  } catch {
    return 'ffprobe';
  }
}

// ---------------------------------------------------------------------------
// Serialized project.json writes.
//
// updateProject() is read-modify-write with NO locking. Part pipelines run in
// PARALLEL (one job per part) and each updates its own part record — without
// serialization, concurrent writes lose updates (last writer wins over a stale
// read). All part-related mutations MUST go through withProjectWrite, which
// chains writes per project id within this Node process.
// ---------------------------------------------------------------------------
const projectWriteChains = new Map<string, Promise<unknown>>();

// Camera-audio extractions in flight, keyed by output wav path — lets parts
// sharing a video source await the same extraction instead of clobbering it.
const inflightExtractions = new Map<string, Promise<void>>();

export async function withProjectWrite<T>(
  projectId: string,
  mutate: (project: ProjectState) => Partial<ProjectState> | null
): Promise<T | null> {
  const prev = projectWriteChains.get(projectId) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // a failed predecessor must not poison the chain
    .then(async () => {
      const project = await getProject(projectId);
      if (!project) return null;
      const patch = mutate(project);
      if (!patch) return null;
      return (await updateProject(projectId, patch)) as T | null;
    });
  projectWriteChains.set(projectId, next);
  return next as Promise<T | null>;
}

/** Patch one part's record (serialized against concurrent part jobs). */
export async function updatePart(
  projectId: string,
  partId: string,
  patch: Partial<ProjectPart>
): Promise<void> {
  await withProjectWrite(projectId, (project) => {
    const parts = project.parts ?? [];
    if (!parts.some((p) => p.id === partId)) return null;
    return {
      parts: parts.map((p) => (p.id === partId ? { ...p, ...patch } : p)),
    };
  });
}

/** File-name prefix for a part's derived files: part_<id8> */
export function partPrefix(partId: string): string {
  return `part_${partId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe helpers
// ---------------------------------------------------------------------------

async function probeDurationSec(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 30000 });
    const dur = parseFloat(stdout.trim());
    return isNaN(dur) ? 0 : dur;
  } catch {
    return 0;
  }
}

/**
 * First keyframe at-or-after targetSec (same technique as the mux route).
 * Input-seeking with -c:v copy snaps to a keyframe; choosing one AT-OR-AFTER
 * the target leaves a positive residual that can be cleanly atrim'ed off the
 * audio instead of desyncing.
 */
async function findKeyframeAtOrAfter(videoPath: string, targetSec: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0',
      '-read_intervals', `${targetSec}%+30`,
      videoPath,
    ], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const [pts, flags] = line.trim().split(',');
      if (flags?.includes('K')) {
        const t = parseFloat(pts);
        if (!isNaN(t) && t >= targetSec) return t;
      }
    }
  } catch { /* fall through */ }
  return targetSec;
}

interface RunFfmpegOptions {
  args: string[];
  jobId: string;
  totalDurationSec?: number;
  progressFrom: number;
  progressTo: number;
  progressMessage: string;
  logPrefix: string;
  /** false = don't register with the job's cancel handle (side-cars that run
   *  concurrently with the main stage must not steal it). Default true. */
  registerProcess?: boolean;
}

/** Spawn ffmpeg with -progress pipe:1, mapping out_time_us onto [from, to].
 * opts.args must END with the output path — the progress flag is inserted
 * right before it (a trailing option after the output would be ignored). */
function runFfmpeg(opts: RunFfmpegOptions): { promise: Promise<void>; process: ChildProcess } {
  const argv = [...opts.args.slice(0, -1), '-progress', 'pipe:1', opts.args[opts.args.length - 1]];
  const proc = spawn(getFFmpegPath(), argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (opts.registerProcess !== false) jobManager.setProcess(opts.jobId, proc);

  let stderrTail: string[] = [];
  proc.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    stderrTail.push(text);
    if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
  });

  proc.stdout?.on('data', (d: Buffer) => {
    if (!opts.totalDurationSec || opts.totalDurationSec <= 0) return;
    const m = d.toString().match(/out_time_us=(\d+)/);
    if (m) {
      const sec = parseInt(m[1]) / 1_000_000;
      const frac = Math.min(1, sec / opts.totalDurationSec);
      const pct = opts.progressFrom + frac * (opts.progressTo - opts.progressFrom);
      jobManager.updateProgress(opts.jobId, Math.round(pct), opts.progressMessage);
    }
  });

  const promise = new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderrTail.join('').split('\n').filter(Boolean).slice(-4).join(' | ')}`));
    });
  });
  return { promise, process: proc };
}

// ---------------------------------------------------------------------------
// Part pipeline: extract → align → mix → mux (one job per part, run N in parallel)
// ---------------------------------------------------------------------------

export interface PartPipelineOptions {
  projectId: string;
  partId: string;
  jobId: string;
  /** Pipeline stage control:
   *  - 'align': extract + align only → status 'aligned' (offset visible and
   *    manually adjustable before committing to a mix).
   *  - 'mix': mix + mux using the part's STORED alignmentOffsetMs (set by a
   *    previous align or edited manually) — does NOT re-run alignment.
   *  - 'full' (default): the whole thing in one go. */
  mode?: 'align' | 'mix' | 'full';
  /** Rewrite the part video even when the single-part audio-only fast path
   *  would apply (the user wants the muxed file to carry the current mix). */
  forceMux?: boolean;
}

export async function runPartPipeline(options: PartPipelineOptions): Promise<void> {
  const { projectId, partId, jobId, mode = 'full', forceMux = false } = options;
  const prefix = partPrefix(partId);
  const audioDir = getProjectDir(projectId, 'audio');
  const exportDir = getProjectDir(projectId, 'export');
  const sourceDir = getProjectDir(projectId, 'source');
  await fs.mkdir(audioDir, { recursive: true });
  await fs.mkdir(exportDir, { recursive: true });

  // Temp files to clean up on failure/success
  const tmpAlignedOut = path.join(audioDir, `${prefix}_aligned_tmp.wav`);

  const fail = async (msg: string) => {
    console.error(`[part-pipeline ${prefix}] ${msg}`);
    await updatePart(projectId, partId, { status: 'error', error: msg, stage: undefined, jobId: undefined });
    jobManager.failJob(jobId, msg);
    try { await fs.unlink(tmpAlignedOut); } catch { /* ignore */ }
  };

  try {
    const project = await getProject(projectId);
    if (!project) return fail('Proyecto no encontrado');
    const part = (project.parts ?? []).find((p) => p.id === partId);
    if (!part) return fail('Parte no encontrada');

    const videoSource = project.sources.find((s) => s.id === part.videoSourceId);
    if (!videoSource) return fail('Fuente de vídeo no encontrada');
    const boardSource = part.boardSourceId
      ? project.sources.find((s) => s.id === part.boardSourceId)
      : undefined;
    if (part.boardSourceId && !boardSource) return fail('Fuente de audio de mesa no encontrada');
    if (mode === 'align' && !boardSource) {
      return fail('La parte no tiene audio de mesa — no hay nada que alinear');
    }

    const videoPath = path.join(sourceDir, videoSource.storedName);
    try { await fs.access(videoPath); } catch { return fail(`Vídeo no encontrado en disco: ${videoSource.storedName}`); }

    const boardVolume = part.boardVolume ?? 1;
    const ambientVolume = part.ambientVolume ?? 0.7;
    const partMuxedPath = path.join(exportDir, `${prefix}_muxed.mp4`);

    // ── Stage 1: extract camera audio (0 → 25) ─────────────────────────────
    await updatePart(projectId, partId, { status: 'processing', stage: 'extract', progress: 0, error: undefined });
    jobManager.updateProgress(jobId, 0, 'Extrayendo audio de cámara...');

    const cameraWav = path.join(audioDir, `${videoSource.id}_audio.wav`);
    let cameraWavExists = false;
    try { await fs.access(cameraWav); cameraWavExists = true; } catch { /* extract below */ }

    if (!cameraWavExists && boardSource) {
      // Two parts can share a video source; serialize extraction of the same
      // wav so parallel pipelines don't write the file simultaneously.
      const inflight = inflightExtractions.get(cameraWav);
      if (inflight) {
        jobManager.updateProgress(jobId, 5, 'Esperando extracción de audio (otra parte)...');
        await inflight;
      } else {
        const { promise, process: proc } = extractAudio({
          inputPath: videoPath,
          outputPath: cameraWav,
          sampleRate: 48000,
          channels: 1,
          onProgress: (pct) => jobManager.updateProgress(jobId, Math.round(pct * 0.25), 'Extrayendo audio de cámara...'),
        });
        jobManager.setProcess(jobId, proc);
        inflightExtractions.set(cameraWav, promise.finally(() => inflightExtractions.delete(cameraWav)));
        await inflightExtractions.get(cameraWav);
      }

      // Register the extracted track (dedupe by sourceFileId — the stock
      // extract route appends blindly; we don't want duplicates).
      const camProbe = await probeFile(cameraWav).catch(() => null);
      await withProjectWrite(projectId, (p) => {
        if (p.audio.extractedTracks.some((t) => t.sourceFileId === videoSource.id)) return null;
        return {
          audio: {
            ...p.audio,
            extractedTracks: [
              ...p.audio.extractedTracks,
              {
                id: uuidv4(),
                sourceFileId: videoSource.id,
                path: cameraWav,
                sampleRate: camProbe?.sampleRate ?? 48000,
                channels: camProbe?.channels ?? 1,
                duration: camProbe?.duration ?? 0,
              },
            ],
          },
        };
      });
    }

    let alignmentOffsetMs = 0;
    let alignmentPeakToNoise: number | undefined;
    let mixPath: string | undefined;
    // Single-part audio-only fast path state (see stage 5).
    let fastPath = false;
    let audioTrimSec = 0;
    let mixSyncPath: string | undefined;

    if (boardSource) {
      // ── Stage 2: convert board audio to wav (25 → 32) ────────────────────
      await updatePart(projectId, partId, { stage: 'align', progress: 25 });
      jobManager.updateProgress(jobId, 25, 'Convirtiendo audio de mesa...');
      const boardSrcPath = path.join(sourceDir, boardSource.storedName);
      try { await fs.access(boardSrcPath); } catch { return fail(`Audio de mesa no encontrado en disco: ${boardSource.storedName}`); }
      const boardWav = path.join(audioDir, `${prefix}_board.wav`);
      // Convert only when missing or stale (source replaced after the wav was
      // made). Rewriting it on every re-mix busts the LUFS and envelope caches
      // (both keyed by mtime) and re-decodes the whole night for nothing.
      let boardWavFresh = false;
      try {
        const [wavStat, srcStat] = await Promise.all([fs.stat(boardWav), fs.stat(boardSrcPath)]);
        boardWavFresh = wavStat.size > 44 && wavStat.mtimeMs > srcStat.mtimeMs;
      } catch { /* convert below */ }
      if (!boardWavFresh) {
        await execFileAsync(getFFmpegPath(), [
          '-y', '-i', boardSrcPath, '-vn', '-ar', '48000', '-ac', '1', '-sample_fmt', 's16', boardWav,
        ], { timeout: 600000 });
      }

      // ── Stage 3: align (GCC-PHAT cross-correlation, python) (32 → 58) ────
      if (mode === 'mix') {
        // Re-use the stored offset (from a previous align run or a manual
        // adjustment) — do NOT recompute it.
        if (part.alignmentOffsetMs == null) {
          return fail('La parte no está alineada — pulsa "Alinear" primero');
        }
        alignmentOffsetMs = part.alignmentOffsetMs;
        alignmentPeakToNoise = part.alignmentPeakToNoise;
      } else {
      jobManager.updateProgress(jobId, 32, 'Alineando mesa ↔ cámara...');
      const alignmentJsonPath = path.join(audioDir, `${prefix}_alignment.json`);
      const scriptPath = path.join(process.cwd(), 'scripts', 'subtract_voice.py');
      // RANGES: correlate only the stretch of the video the part covers against
      // the stretch of the mesa where it is expected (±60 s of slack — it is a
      // hint, not a cut). Whole-file correlation of a 30-min piece against a
      // 2-hour dinner locked onto a look-alike moment (5-sep, 18-sep); the
      // excerpts cannot. The offset the excerpts yield is converted back to
      // the FILE-TO-FILE offset every downstream clock uses.
      const [camFileDur, boardFileDur] = await Promise.all([probeDurationSec(cameraWav), probeDurationSec(boardWav)]);
      const vr = part.videoRangeMs, br = part.boardRangeMs;
      const camOriginSec = vr ? Math.max(0, Math.min(vr.startMs, vr.endMs)) / 1000 : 0;
      const camCutDur = vr ? Math.max(1, (Math.max(vr.startMs, vr.endMs) / 1000) - camOriginSec) : 0;
      const BOARD_SLACK_SEC = 60;
      const boardOriginSec = br ? Math.max(0, Math.min(br.startMs, br.endMs) / 1000 - BOARD_SLACK_SEC) : 0;
      const boardCutDur = br ? Math.max(1, Math.max(br.startMs, br.endMs) / 1000 + BOARD_SLACK_SEC - boardOriginSec) : 0;
      const alignCam = vr ? path.join(audioDir, `${prefix}_align_cam.wav`) : cameraWav;
      const alignBoard = br ? path.join(audioDir, `${prefix}_align_board.wav`) : boardWav;
      const cut = async (src: string, startSec: number, durSec: number, dst: string) => {
        await execFileAsync(getFFmpegPath(), ['-y', '-v', 'error', '-ss', startSec.toFixed(3), '-t', durSec.toFixed(3), '-i', src, '-c:a', 'pcm_s16le', dst], { timeout: 600000 });
      };
      if (vr) await cut(cameraWav, camOriginSec, camCutDur, alignCam);
      if (br) await cut(boardWav, boardOriginSec, boardCutDur, alignBoard);
      // Excerpt offset ↔ file offset: file = excerpt + (boardOrigin − camOrigin).
      const originShiftMs = Math.round((boardOriginSec - camOriginSec) * 1000);
      const pyArgs = [
        scriptPath,
        '--mic', alignBoard,
        '--camera', alignCam,
        '--output', tmpAlignedOut,
        '--method', 'spectral',
        '--alignment-out', alignmentJsonPath,
        '--align-only',
      ];
      // Optional user-provided search window (file offsets): restrict the
      // coarse peak search when a short camera piece makes the global
      // correlation ambiguous. Converted to the excerpts' clock.
      if (part.alignSearchStartMs != null) {
        pyArgs.push('--search-start-sec', String((part.alignSearchStartMs - originShiftMs) / 1000));
      }
      if (part.alignSearchEndMs != null) {
        pyArgs.push('--search-end-sec', String((part.alignSearchEndMs - originShiftMs) / 1000));
      }
      console.log(`[part-pipeline ${prefix}] python3 ${pyArgs.join(' ')}`);
      const offsetMs = await new Promise<number>((resolve, reject) => {
        const proc = spawn('python3', pyArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        jobManager.setProcess(jobId, proc);
        let stdoutFull = '';
        let stderrBuffer = '';
        let stderrFull = '';
        proc.stdout?.on('data', (d: Buffer) => { stdoutFull += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => {
          const chunk = d.toString();
          stderrBuffer += chunk;
          stderrFull += chunk;
          const lines = stderrBuffer.split('\n');
          stderrBuffer = lines.pop() || '';
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line.trim());
              if (typeof parsed.progress === 'number') {
                jobManager.updateProgress(jobId, 32 + Math.round(parsed.progress * 0.26), parsed.message || 'Alineando...');
              }
            } catch { /* not JSON */ }
          }
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code !== 0) {
            const tail = (stdoutFull + '\n' + stderrFull).trim().split('\n').slice(-5).join(' | ');
            return reject(new Error(`Alineación falló (code ${code}): ${tail}`));
          }
          try {
            const result = JSON.parse(stdoutFull.trim());
            resolve(typeof result.offset_ms === 'number' ? result.offset_ms : 0);
          } catch {
            reject(new Error('Alineación: salida no parseable'));
          }
        });
      });
      alignmentOffsetMs = Math.round((offsetMs + originShiftMs) * 100) / 100;
      try { await fs.unlink(tmpAlignedOut); } catch { /* ignore */ }
      for (const f of [vr ? alignCam : null, br ? alignBoard : null]) { if (f) { try { await fs.unlink(f); } catch { /* ignore */ } } }
      try {
        const alignData = JSON.parse(await fs.readFile(alignmentJsonPath, 'utf-8'));
        if (typeof alignData.peak_to_noise === 'number') alignmentPeakToNoise = alignData.peak_to_noise;
        // The JSON keeps the excerpt envelopes; add where they sit in their
        // files and the file-to-file offset so the view can draw the edited
        // window inside the whole recordings.
        const offSec = alignmentOffsetMs / 1000;
        const micA = boardOriginSec, micB = boardOriginSec + (alignData.mic_duration_s ?? 0);
        const camA = camOriginSec + offSec, camB = camA + (alignData.camera_duration_s ?? 0);
        await fs.writeFile(alignmentJsonPath, JSON.stringify({
          ...alignData,
          excerpt_offset_ms: offsetMs,
          offset_ms: alignmentOffsetMs,
          offset_seconds: Math.round(offSec * 100) / 100,
          fine_offset_ms: alignmentOffsetMs,
          mic_origin_s: boardOriginSec,
          camera_origin_s: camOriginSec,
          mic_file_duration_s: Math.round(boardFileDur * 10) / 10,
          camera_file_duration_s: Math.round(camFileDur * 10) / 10,
          ...(vr ? { video_range_s: [Math.min(vr.startMs, vr.endMs) / 1000, Math.max(vr.startMs, vr.endMs) / 1000] } : {}),
          ...(br ? { board_range_s: [Math.min(br.startMs, br.endMs) / 1000, Math.max(br.startMs, br.endMs) / 1000] } : {}),
          overlap_s: Math.round(Math.max(0, Math.min(micB, camB) - Math.max(micA, camA)) * 10) / 10,
          manual_override: false,
        }), 'utf-8');
      } catch { /* diagnostics only */ }
      console.log(`[part-pipeline ${prefix}] offset=${alignmentOffsetMs}ms peakToNoise=${alignmentPeakToNoise ?? 'n/a'}`);
      }

      if (mode === 'align') {
        // Stop here: leave the part 'aligned' so the user can review/adjust
        // the offset and set gain/volumes before mixing.
        await updatePart(projectId, partId, {
          status: 'aligned',
          stage: undefined,
          jobId: undefined,
          progress: 100,
          error: undefined,
          alignmentOffsetMs,
          alignmentPeakToNoise,
        });
        jobManager.completeJob(jobId, { alignmentOffsetMs, alignmentPeakToNoise });
        console.log(`[part-pipeline ${prefix}] aligned only: offset=${alignmentOffsetMs}ms`);
        return;
      }

      // ── Stage 4: mix board + camera ambient (58 → 72) ────────────────────
      // Offset convention: positive = board started BEFORE camera.
      //  - positive → trim board start; mix t=0 == video t=0 (no mux seek).
      //  - negative → trim CAMERA/ambient start by |offset|; mix t=0 == video
      //    t=|offset| → the mux stage input-seeks the video (keyframe-snapped).
      await updatePart(projectId, partId, { stage: 'mix', progress: 58, alignmentOffsetMs, alignmentPeakToNoise });
      jobManager.updateProgress(jobId, 58, 'Mezclando mesa + ambiente...');
      // Trims come from ONE helper (video range aware) — the preview, the
      // auto-raises route and every timeline clock use the same numbers.
      const trims = partTrims({ alignmentOffsetMs, videoRangeMs: part.videoRangeMs });
      const boardTrimSec = trims.boardTrimMs / 1000;
      const ambientTrimSec = trims.ambientTrimMs / 1000;
      mixPath = path.join(audioDir, `${prefix}_mix.wav`);
      const mixDurProbeInputs = await Promise.all([probeDurationSec(boardWav), probeDurationSec(cameraWav)]);
      const mixEstDurSec = Math.min(
        Math.max(0.1, mixDurProbeInputs[0] - boardTrimSec),
        Math.max(0.1, mixDurProbeInputs[1] - ambientTrimSec),
        trims.capMs != null ? trims.capMs / 1000 : Infinity,
      );
      if (trims.capMs != null) console.log(`[part-pipeline ${prefix}] video range ${(trims.ambientTrimMs / 1000).toFixed(1)}–${((trims.ambientTrimMs + trims.capMs) / 1000).toFixed(1)} s → mix ${mixEstDurSec.toFixed(1)} s`);
      // The chain itself lives in src/server/part-mix-chain.ts, SHARED with
      // the 30 s settings preview route — what you preview is exactly what
      // this full mix runs. Stems are tapped where each branch enters the
      // final amix and capped to the mix duration (the raw board is the whole
      // night's mesa).
      // Always measured (cached by mtime) and persisted on the part: the UI
      // draws the leveler's input→output curve and the level readouts from it.
      // …over the PART'S WINDOW, not the file's head: a mesa that records the
      // whole evening anchors the leveler 17 dB too high otherwise.
      const win = await measureBoardWindow(boardWav, boardTrimSec, mixEstDurSec);
      const boardLUFS = win.lufs;
      const boardNoiseFloorDb = win.floorDb;
      const boardLoudDb = win.loudDb;
      if ((boardLUFS != null && boardLUFS !== part.boardLUFS) || (boardNoiseFloorDb != null && boardNoiseFloorDb !== part.boardNoiseFloorDb) || (boardLoudDb != null && boardLoudDb !== part.boardLoudDb)) {
        await updatePart(projectId, partId, {
          ...(boardLUFS != null ? { boardLUFS } : {}),
          ...(boardNoiseFloorDb != null ? { boardNoiseFloorDb } : {}),
          ...(boardLoudDb != null ? { boardLoudDb } : {}),
        });
      }
      const boardProcPath = path.join(audioDir, `${prefix}_board_proc.wav`);
      const ambProcPath = path.join(audioDir, `${prefix}_amb_proc.wav`);
      // THREE single-output passes (mix, then each processed stem). Never a
      // multi-output graph here: this ffmpeg build's 3-output graphs can
      // finish writing every file and then NEVER EXIT — it froze a real
      // "Mezclar y muxar" at 58% with mix+stems fully written on disk (see
      // the no-exit quirk in CLAUDE.md §7). Single-output runs always exit.
      const mixArgsBase = { part, boardVolume, ambientVolume, boardTrimSec, ambientTrimSec, boardLUFS, boardNoiseFloorDb, boardLoudDb, stemDurSec: mixEstDurSec };
      // Voice-aware ambient duck as a PRE-COMPUTED envelope (lookahead:
      // minimum pause, pre-rise before the voice ends, audience gate) — fed
      // to every pass as the third input. See src/server/ambient-gain-curve.ts.
      const curvePath = path.join(audioDir, `${prefix}_ambgain.wav`);
      const gatePath = path.join(audioDir, `${prefix}_mesagate.wav`);
      let curveInputs: string[] = [];
      let mixArgs: Parameters<typeof buildPartMixFilter>[0] = mixArgsBase;
      // The envelope analysis feeds BOTH the ambient curve (voice-duck) and
      // the mesa gate (leveler), so it runs when either is on.
      if (part.ambientDuckOnVoice || part.boardSpeechLevel) {
        jobManager.updateProgress(jobId, 58, 'Calculando la envolvente del ambiente (huecos, risas)...');
        const prep = await prepareAmbientGainCurve(mixArgsBase, boardWav, cameraWav, curvePath, undefined, undefined, gatePath);
        for (const line of prep.log) console.log(`[part-mix ${prefix}] ${line}`);
        // The engine's decisions, so the editing timeline can show and veto them.
        const decidedAt = new Date().toISOString();
        await updatePart(projectId, partId, {
          ambientAutoRaises: prep.autoRaises,
          ambientAutoRaisesAt: decidedAt,
          // The gate's own decisions, so the mesa track can draw every closure
          // as a box the user can veto. Cleared when the leveler is off (no
          // gate was built) so stale boxes never outlive the setting.
          boardAutoGates: prep.mesaGate ? prep.autoGates : [],
          boardAutoGatesAt: decidedAt,
        });
        // Persist the room floor + cross-mic calibration so the 30 s preview
        // decides exactly like the full mix.
        if (
          prep.stats.roomFloorDb !== part.ambientRoomFloorDb ||
          prep.stats.calibDeltaDb !== part.ambientVoiceCalibDeltaDb ||
          prep.stats.calibFloorDb !== part.ambientVoiceCalibFloorDb ||
          prep.stats.calibLoudDb !== part.ambientVoiceCalibLoudDb ||
          prep.stats.calibMesaFloorDb !== part.ambientVoiceCalibMesaFloorDb
        ) {
          await updatePart(projectId, partId, {
            ambientRoomFloorDb: prep.stats.roomFloorDb,
            ambientVoiceCalibDeltaDb: prep.stats.calibDeltaDb,
            ambientVoiceCalibFloorDb: prep.stats.calibFloorDb,
            ambientVoiceCalibLoudDb: prep.stats.calibLoudDb,
            ambientVoiceCalibMesaFloorDb: prep.stats.calibMesaFloorDb,
          });
        }
        // Inputs: 0 board, 1 camera, then the ambient curve (if the duck is
        // on) and the mesa gate (if leveled) — indices follow that order.
        const useAmbCurve = !!part.ambientDuckOnVoice;
        curveInputs = [...(useAmbCurve ? ['-i', curvePath] : []), ...(prep.mesaGate ? ['-i', gatePath] : [])];
        mixArgs = {
          ...mixArgsBase,
          ...(useAmbCurve ? { ambientGainCurve: { gainMax: prep.gainMax } } : {}),
          ...(prep.mesaGate ? { boardGateCurve: { inputIndex: useAmbCurve ? 3 : 2 } } : {}),
        };
      }
      const mixSolo = buildPartMixFilter({ ...mixArgs, soloOutput: 'mix' });
      for (const line of mixSolo.log) console.log(`[part-mix ${prefix}] ${line}`);
      await runFfmpeg({
        args: [
          '-y', '-i', boardWav, '-i', cameraWav, ...curveInputs,
          '-filter_complex', mixSolo.filter,
          '-map', '[out]', '-acodec', 'pcm_s16le', '-ar', '48000',
          ...(trims.capMs != null ? ['-t', mixEstDurSec.toFixed(3)] : []),
          mixPath,
        ],
        jobId,
        totalDurationSec: mixEstDurSec,
        progressFrom: 58,
        progressTo: 70,
        progressMessage: 'Mezclando mesa + ambiente...',
        logPrefix: `[part-mix ${prefix}]`,
      }).promise;
      // The stem passes run CONCURRENTLY with the mux below — audio-only CPU
      // work hides entirely behind the video-copy I/O, instead of adding two
      // full-length passes to the wall clock. They report no percentage (the
      // mux owns the progress bar) and a failure is non-fatal: the mix and the
      // muxed video are already correct, only the listen-back rows go stale.
      const stemsPromise = (async () => {
        for (const [solo, outPath] of [
          ['board', boardProcPath],
          ['ambient', ambProcPath],
        ] as const) {
          const w = buildPartMixFilter({ ...mixArgs, soloOutput: solo });
          await runFfmpeg({
            args: [
              '-y', '-i', boardWav, '-i', cameraWav, ...curveInputs,
              '-filter_complex', w.filter,
              '-map', '[out]', '-acodec', 'pcm_s16le', '-ar', '48000', outPath,
            ],
            jobId,
            progressFrom: 0,
            progressTo: 0,
            progressMessage: '',
            logPrefix: `[part-stem ${prefix}]`,
            registerProcess: false,
          }).promise;
        }
      })().catch((err) => {
        console.warn(`[part-stem ${prefix}] stems failed (non-fatal): ${(err as Error).message}`);
      });

      // ── Stage 5: mux video (-c:v copy) + mix (70 → 98) ───────────────────
      // Record WHEN and WITH WHAT the mix was made — the card labels every
      // player with it and flags settings changed since / a stale video.
      const partForDesc: ProjectPart = { ...part, boardVolume, ambientVolume, ...(boardLUFS != null ? { boardLUFS } : {}), ...(boardLoudDb != null ? { boardLoudDb } : {}) };
      await updatePart(projectId, partId, {
        stage: 'mux', progress: 70, mixedAudioPath: mixPath,
        mixedAt: new Date().toISOString(),
        mixChainApplied: {
          board: describeBoardChain(partForDesc),
          ambient: describeAmbientChain(partForDesc),
          mix: describeMixChain(partForDesc),
        },
      });
      const mixDurSec = await probeDurationSec(mixPath);

      // SINGLE-PART FAST PATH. The part video depends only on the source and
      // the alignment offset — never on the mix — yet every re-mix used to
      // rewrite the whole 25+ GB file just to embed new audio (the user saw
      // "Generando vídeo de la parte… 74%" for minutes after tweaking je-je
      // zones). Once the video has been muxed FOR THIS OFFSET, an audio-only
      // re-mix skips the rewrite: downstream reads the fresh mix from a
      // separate wav (sync.mixedAudioPath — the legacy single-pair contract
      // every consumer already implements) and the muxed file only supplies
      // the picture. Multi-part projects take it too: their audio master is
      // a wav of ALL the parts back to back (writeProjectMixWav), rebuilt after
      // every mix, so the joined video's embedded track may lag behind the
      // mix — the cards say so. Any offset change or missing file still falls
      // back to a mux.
      const projNow = await getProject(projectId);
      const partNow = (projNow?.parts ?? []).find((p) => p.id === partId);
      const singlePartNow = (projNow?.parts ?? []).length === 1;
      if (
        mode === 'mix' && !forceMux && partNow &&
        partNow.muxedForOffsetMs === alignmentOffsetMs &&
        (partNow.muxedForRangeKey ?? 'full') === videoRangeKey(part) &&
        partNow.muxedAudioTrimMs != null && partNow.muxedVideoPath && partNow.muxedDurationMs &&
        projNow?.partsConcat?.status === 'done' && projNow.sync.muxedVideoPath
      ) {
        try {
          await fs.access(projNow.sync.muxedVideoPath);
          try {
            await fs.access(partNow.muxedVideoPath);
          } catch {
            // The part's own muxed file is gone (the storage panel used to
            // list it as an orphan) but, single part, the FINAL video is a
            // clone of it — clone it back instead of re-muxing 25+ GB. With
            // several parts the final video is a concat: re-mux this part.
            if (!singlePartNow) throw new Error('part muxed file missing');
            await execFileAsync('/bin/cp', ['-c', projNow.sync.muxedVideoPath, partNow.muxedVideoPath], { timeout: 600000 });
            console.log(`[part-pipeline ${prefix}] ${path.basename(partNow.muxedVideoPath)} faltaba — clonado desde el vídeo final`);
          }
          const expectedMixDur = (partNow.muxedDurationMs + partNow.muxedAudioTrimMs) / 1000;
          fastPath = Math.abs(mixDurSec - expectedMixDur) < 0.25;
        } catch { fastPath = false; }
      }

      if (fastPath) {
        audioTrimSec = partNow!.muxedAudioTrimMs! / 1000;
        jobManager.updateProgress(jobId, 75, 'Vídeo ya muxado para este offset — solo se actualiza el audio...');
        console.log(`[part-pipeline ${prefix}] audio-only re-mix (offset ${alignmentOffsetMs}ms unchanged) — video mux skipped`);
      } else {
        jobManager.updateProgress(jobId, 70, 'Generando vídeo de la parte...');
        const muxArgs: string[] = ['-y'];
        if (ambientTrimSec > 0) {
          // Camera started first: seek video to keyframe at-or-after |offset|,
          // trim the snap residual off the mix.
          const videoSeekSec = await findKeyframeAtOrAfter(videoPath, ambientTrimSec);
          audioTrimSec = Math.max(0, videoSeekSec - ambientTrimSec);
          muxArgs.push('-ss', String(videoSeekSec));
          console.log(`[part-pipeline ${prefix}] video seek ${videoSeekSec}s (target ${ambientTrimSec}s, residual ${audioTrimSec}s)`);
        }
        muxArgs.push('-i', videoPath, '-i', mixPath);
        if (audioTrimSec > 0.001) {
          muxArgs.push('-filter_complex', `[1:a]atrim=start=${audioTrimSec.toFixed(3)},asetpts=PTS-STARTPTS[aligned]`);
          muxArgs.push('-map', '0:v:0', '-map', '[aligned]');
        } else {
          muxArgs.push('-map', '0:v:0', '-map', '1:a:0');
        }
        const outDurSec = Math.max(0.1, mixDurSec - audioTrimSec);
        muxArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(outDurSec), partMuxedPath);
        await runFfmpeg({
          args: muxArgs,
          jobId,
          totalDurationSec: outDurSec,
          progressFrom: 70,
          progressTo: 96,
          progressMessage: 'Generando vídeo de la parte...',
          logPrefix: `[part-mux ${prefix}]`,
        }).promise;
      }
      await stemsPromise;

      // Single part: write the mix ALIGNED to the muxed video's t=0 (head
      // residual trimmed, lossless PCM copy — seconds even for a full night)
      // as the separate downstream audio. Same timeline as the embedded track,
      // so existing clip/subtitle/reel times need nothing.
      if (singlePartNow) {
        mixSyncPath = path.join(audioDir, `${prefix}_mix_sync.wav`);
        jobManager.updateProgress(jobId, 97, 'Alineando el audio con el vídeo...');
        const syncArgs = ['-y'];
        if (audioTrimSec > 0.001) syncArgs.push('-ss', audioTrimSec.toFixed(3));
        syncArgs.push('-i', mixPath, '-c:a', 'pcm_s16le', mixSyncPath);
        await execFileAsync(getFFmpegPath(), syncArgs, { timeout: 600000 });
      }
    } else {
      // ── Video-only part: normalize embedded audio to match mix-based parts
      // (AAC 48 kHz mono) so the final -c copy concat has uniform audio.
      await updatePart(projectId, partId, { stage: 'mux', progress: 40 });
      jobManager.updateProgress(jobId, 40, 'Preparando vídeo (sin audio de mesa)...');
      const vidProbe = await probeFile(videoPath).catch(() => null);
      const hasAudio = vidProbe?.hasAudio ?? true;
      const vRange = part.videoRangeMs;
      const rangeSeek = vRange ? await findKeyframeAtOrAfter(videoPath, Math.min(vRange.startMs, vRange.endMs) / 1000) : 0;
      const durSec = vRange ? Math.max(0.1, Math.max(vRange.startMs, vRange.endMs) / 1000 - rangeSeek) : (vidProbe?.duration ?? 0);
      const rangeArgs = vRange ? ['-ss', rangeSeek.toFixed(3)] : [];
      const rangeTail = vRange ? ['-t', durSec.toFixed(3)] : [];
      const args = hasAudio
        ? ['-y', ...rangeArgs, '-i', videoPath, '-map', '0:v:0', '-map', '0:a:0',
           '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '1', ...rangeTail, partMuxedPath]
        : ['-y', ...rangeArgs, '-i', videoPath, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
           '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', ...rangeTail, partMuxedPath];
      await runFfmpeg({
        args,
        jobId,
        totalDurationSec: durSec,
        progressFrom: 40,
        progressTo: 98,
        progressMessage: 'Preparando vídeo...',
        logPrefix: `[part-mux ${prefix}]`,
      }).promise;
    }

    // ── Done ────────────────────────────────────────────────────────────────
    const outProbe = await probeFile(partMuxedPath).catch(() => null);
    const muxedDurationMs = outProbe ? Math.round(outProbe.duration * 1000) : undefined;
    await updatePart(projectId, partId, {
      status: 'done',
      stage: undefined,
      jobId: undefined,
      progress: 100,
      error: undefined,
      alignmentOffsetMs,
      alignmentPeakToNoise,
      mixedAudioPath: mixPath,
      muxedVideoPath: partMuxedPath,
      muxedDurationMs,
      muxedForOffsetMs: alignmentOffsetMs,
      muxedForRangeKey: videoRangeKey(part),
      muxedAudioTrimMs: Math.round(audioTrimSec * 1000),
      boardVolume,
      ambientVolume,
      processedAt: new Date().toISOString(),
      // The audio-only fast path leaves the muxed file (and its timestamp)
      // untouched — the card then shows "vídeo con audio anterior".
      ...(fastPath ? {} : { muxedAt: new Date().toISOString() }),
    });

    // Single-part project: the "join" is a formality (an instant APFS clone of
    // this very file), so run it here and downstream is ready as soon as the
    // mix lands — no separate "Unir partes" click. Multi-part projects still
    // join explicitly, because the user orders the parts first. A join failure
    // does not un-done the part; the (compact) join card shows it with a retry.
    // The audio-only fast path leaves the (unchanged) final video alone.
    const after = await getProject(projectId);
    const singlePart = !!after && (after.parts ?? []).length === 1;
    if (singlePart && !fastPath) {
      jobManager.updateProgress(jobId, 99, 'Una sola parte — generando el vídeo final...');
      const concatJob = jobManager.createJob(projectId, 'parts-concat');
      jobManager.startJob(concatJob.id);
      await withProjectWrite(projectId, (p) => ({
        partsConcat: {
          ...(p.partsConcat ?? { status: 'idle' as const }),
          status: 'running' as const,
          jobId: concatJob.id,
          error: undefined,
        },
      }));
      await runPartsConcat({ projectId, jobId: concatJob.id });
    }
    // Single part with a mix: point downstream at the aligned mix wav (the join
    // above clears it — set AFTER). audioRev makes compose/reels reload the
    // in-place-rewritten file. muxedAudioOffsetMs stays 0 by construction.
    if (singlePart && mixSyncPath) {
      const mixSyncFinal = mixSyncPath;
      await withProjectWrite(projectId, (p) => ({
        sync: {
          ...p.sync,
          mixedAudioPath: mixSyncFinal,
          selectedAudioPath: undefined,
          muxedAudioOffsetMs: 0,
          audioRev: Date.now(),
        },
      }));
    }

    if (!singlePart && mixPath) {
      // Multi-part: refresh the AUDIO MASTER (every part's mix back to back,
      // see writeProjectMixWav) so compose / reels / export hear this mix at
      // once — fast path or full mux, joined again or not — and bump audioRev
      // either way so open editors refetch the stems' waveforms.
      const written = await writeProjectMixWav(projectId, fastPath ? `audio-only re-mix of ${prefix}` : `${prefix} re-muxed`);
      if (!written) await withProjectWrite(projectId, (p) => ({ sync: { ...p.sync, audioRev: Date.now() } }));
    }

    jobManager.completeJob(jobId, { muxedVideoPath: partMuxedPath, muxedDurationMs, fastPath });
    console.log(`[part-pipeline ${prefix}] done: ${partMuxedPath} (${muxedDurationMs}ms)`);
  } catch (err) {
    await fail((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Final concat: join the ordered part muxed files into ONE muxed video that
// feeds the existing downstream (transcription/compose/reels untouched).
// ---------------------------------------------------------------------------

export interface PartsConcatOptions {
  projectId: string;
  jobId: string;
}

/**
 * The AUDIO MASTER of a multi-part project: every part's mix, trimmed to what
 * its muxed video shows (head residual off, capped to the muxed duration),
 * back to back in `order` — the exact clock of the joined video (the same
 * construction `computeStemLayout` uses for the stems, verified sample-exact
 * there). Written as `audio/parts_mix_sync.wav` and pointed to by
 * `sync.mixedAudioPath`, so compose / reels / export / transcription follow
 * the legacy single-pair contract and hear the CURRENT mix — without the
 * multi-GB re-mux + join that embedding it in the video costs — and
 * `sync.audioRev` is bumped so open editors refetch waveforms and audio.
 * A video-only part contributes its muxed file's own track. Skipped, with a
 * log line and `mixedAudioPath` untouched, when the parts' durations no
 * longer add up to the joined video (an offset change made a part longer or
 * shorter: the wav would drift against the picture until the next join) or a
 * mix file is missing. Returns the path written, or null.
 */
async function writeProjectMixWav(projectId: string, why: string): Promise<string | null> {
  const project = await getProject(projectId);
  if (!project || (project.parts ?? []).length < 2) return null;
  if (project.partsConcat?.status !== 'done' || !project.sync.muxedVideoPath) return null;
  const parts = [...(project.parts ?? [])]
    .filter((p) => p.muxedVideoPath && p.muxedDurationMs)
    .sort((a, b) => a.order - b.order);
  if (parts.length < 2) return null;
  const totalMs = parts.reduce((sum, p) => sum + (p.muxedDurationMs ?? 0), 0);
  if (project.sync.muxedDurationMs && Math.abs(totalMs - project.sync.muxedDurationMs) > 80) {
    console.warn(`[parts-mix-sync] skipped (${why}): the parts add up to ${totalMs} ms but the joined video lasts ${project.sync.muxedDurationMs} ms — join the parts again`);
    return null;
  }
  const args: string[] = ['-y', '-v', 'error'];
  const segs: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const src = p.mixedAudioPath ?? p.muxedVideoPath!;
    try { await fs.access(src); } catch {
      console.warn(`[parts-mix-sync] skipped (${why}): ${path.basename(src)} is missing`);
      return null;
    }
    // The mix wav starts at the part's alignment; the muxed video starts a
    // keyframe-snap residual later. A video-only part's track already does.
    const trimSec = p.mixedAudioPath ? (p.muxedAudioTrimMs ?? 0) / 1000 : 0;
    const durSec = ((p.muxedDurationMs ?? 0) / 1000).toFixed(3);
    if (trimSec > 0.0005) args.push('-ss', trimSec.toFixed(3));
    args.push('-t', durSec, '-i', src);
    // Each segment is padded/cut to EXACTLY the muxed duration: the mix wav
    // ends up to ~150 ms before its muxed file does (the video is cut at a
    // packet boundary past the audio's end) and the concat demuxer offsets
    // the next part by the FILE's duration, so a bare concat of the mixes
    // drifted 285 ms short over three parts (measured).
    segs.push(`[${i}:a]apad,atrim=end=${durSec},asetpts=PTS-STARTPTS[s${i}]`);
  }
  const audioDir = getProjectDir(projectId, 'audio');
  const outPath = path.join(audioDir, 'parts_mix_sync.wav');
  // Unique per call: two parts finishing together (parallel jobs) must not share a temp file.
  const tmpPath = path.join(audioDir, `.parts_mix_sync.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp.wav`);
  const labels = parts.map((_, i) => `[s${i}]`).join('');
  args.push(
    '-filter_complex', `${segs.join(';')};${labels}concat=n=${parts.length}:v=0:a=1,aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono[out]`,
    '-map', '[out]', '-c:a', 'pcm_s16le', tmpPath,
  );
  const t0 = Date.now();
  try {
    await execFileAsync(getFFmpegPath(), args, { timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
    await fs.rename(tmpPath, outPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    console.warn(`[parts-mix-sync] failed (${why}): ${(err as Error).message}`);
    return null;
  }
  const durSec = await probeDurationSec(outPath).catch(() => 0);
  await withProjectWrite(projectId, (p) => ({
    sync: {
      ...p.sync,
      mixedAudioPath: outPath,
      selectedAudioPath: undefined,
      muxedAudioOffsetMs: 0,
      audioRev: Date.now(),
    },
  }));
  console.log(`[parts-mix-sync] ${why}: ${parts.length} parts → ${path.basename(outPath)} (${durSec.toFixed(3)} s, joined video ${(totalMs / 1000).toFixed(3)} s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return outPath;
}

export async function runPartsConcat(options: PartsConcatOptions): Promise<void> {
  const { projectId, jobId } = options;
  const exportDir = getProjectDir(projectId, 'export');
  const listPath = path.join(exportDir, 'parts_concat_list.txt');
  const outputPath = path.join(exportDir, `muxed_${Date.now()}.mp4`);

  const fail = async (msg: string) => {
    console.error(`[parts-concat] ${msg}`);
    await withProjectWrite(projectId, (p) => ({
      partsConcat: { ...(p.partsConcat ?? { status: 'idle' as const }), status: 'error' as const, error: msg, jobId: undefined },
    }));
    jobManager.failJob(jobId, msg);
    try { await fs.unlink(listPath); } catch { /* ignore */ }
    try { await fs.unlink(outputPath); } catch { /* ignore */ }
  };

  try {
    const project = await getProject(projectId);
    if (!project) return fail('Proyecto no encontrado');
    const parts = (project.parts ?? [])
      .slice()
      .sort((a, b) => a.order - b.order);
    if (parts.length === 0) return fail('No hay partes definidas');
    const notDone = parts.filter((p) => p.status !== 'done' || !p.muxedVideoPath);
    if (notDone.length > 0) {
      return fail(`Partes sin procesar: ${notDone.map((p) => p.name).join(', ')}`);
    }
    for (const p of parts) {
      try { await fs.access(p.muxedVideoPath!); } catch {
        return fail(`Falta el fichero muxado de "${p.name}" — reprocesa esa parte`);
      }
    }

    jobManager.updateProgress(jobId, 2, `Uniendo ${parts.length} parte(s)...`);

    // Same single-final-file semantics as the mux route: previous muxed_*.mp4
    // are stale once a new final video exists. (Part files are part_*_muxed.mp4
    // and do NOT match this glob.)
    try {
      for (const entry of await fs.readdir(exportDir)) {
        if (entry.startsWith('muxed_') && entry.endsWith('.mp4')) {
          await fs.unlink(path.join(exportDir, entry)).catch(() => {});
        }
      }
    } catch { /* ignore */ }

    const totalDurSec = parts.reduce((sum, p) => sum + (p.muxedDurationMs ?? 0), 0) / 1000;

    // Single part: the "concat" is just that part's muxed file. An APFS
    // copy-on-write clone lands it instantly (no 25 GB re-copy, no extra
    // disk) — this is the common case when the whole set is one recording.
    // Node's fs.copyFile(COPYFILE_FICLONE_FORCE) throws ENOSYS on this setup
    // even though the volume clones fine, so shell out to `cp -c` (clonefile)
    // — verified working. Falls back to the ffmpeg concat below on error.
    let cloned = false;
    if (parts.length === 1 && process.platform === 'darwin') {
      try {
        jobManager.updateProgress(jobId, 20, 'Una sola parte — clonando el vídeo...');
        await execFileAsync('/bin/cp', ['-c', parts[0].muxedVideoPath!, outputPath], { timeout: 600000 });
        cloned = true;
        console.log(`[parts-concat] single part → APFS clone of ${path.basename(parts[0].muxedVideoPath!)}`);
      } catch (err) {
        console.warn(`[parts-concat] clone unavailable (${(err as Error).message}) — falling back to ffmpeg concat`);
        try { await fs.unlink(outputPath); } catch { /* ignore */ }
      }
    }

    if (!cloned) {
      // concat demuxer list — escape single quotes for the 'file' directive
      const listContent = parts
        .map((p) => `file '${p.muxedVideoPath!.replace(/'/g, `'\\''`)}'`)
        .join('\n') + '\n';
      await fs.writeFile(listPath, listContent, 'utf-8');

      // Stream-copy join: all parts share codec params (HEVC copied from the same
      // camera + AAC 192k 48k mono produced by the part pipeline).
      const proc = spawn(getFFmpegPath(), [
        '-y',
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-progress', 'pipe:1',
        outputPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      jobManager.setProcess(jobId, proc);

      let stderrTail: string[] = [];
      proc.stderr?.on('data', (d: Buffer) => {
        stderrTail.push(d.toString());
        if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
      });
      proc.stdout?.on('data', (d: Buffer) => {
        const m = d.toString().match(/out_time_us=(\d+)/);
        if (m && totalDurSec > 0) {
          const pct = Math.min(95, 2 + (parseInt(m[1]) / 1_000_000 / totalDurSec) * 93);
          jobManager.updateProgress(jobId, Math.round(pct), 'Uniendo partes...');
        }
      });

      await new Promise<void>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg concat exited ${code}: ${stderrTail.join('').split('\n').filter(Boolean).slice(-4).join(' | ')}`));
        });
      });
      try { await fs.unlink(listPath); } catch { /* ignore */ }
    }

    const outProbe = await probeFile(outputPath).catch(() => null);
    const durationMs = outProbe ? Math.round(outProbe.duration * 1000) : undefined;
    if (durationMs && Math.abs(durationMs - totalDurSec * 1000) > 3000) {
      console.warn(`[parts-concat] duration mismatch: expected ~${Math.round(totalDurSec * 1000)}ms, got ${durationMs}ms`);
    }

    // Seed downstream exactly like use-video-directly: the final muxed video's
    // EMBEDDED audio drives everything; separate-audio fields are cleared so
    // transcription (P5 fallback) / compose / reels use the muxed file. A
    // multi-part project then gets its audio master wav right below, which
    // re-points mixedAudioPath (same clock as this video, by construction).
    await withProjectWrite(projectId, (p) => ({
      sync: {
        ...p.sync,
        status: 'done' as const,
        muxedVideoPath: outputPath,
        ...(durationMs ? { muxedDurationMs: durationMs } : {}),
        muxedAudioOffsetMs: 0,
        selectedAudioPath: undefined,
        mixedAudioPath: undefined,
      },
      partsConcat: {
        status: 'done' as const,
        outputPath,
        concatenatedAt: new Date().toISOString(),
        error: undefined,
        jobId: undefined,
      },
    }));

    if (parts.length > 1) await writeProjectMixWav(projectId, 'parts joined');

    jobManager.completeJob(jobId, { outputPath, durationMs });
    console.log(`[parts-concat] done: ${outputPath} (${durationMs}ms from ${parts.length} parts)`);
  } catch (err) {
    await fail((err as Error).message);
  }
}

/**
 * Core board-filler detection, shared by the parts flow and the single-pair
 * /audio-prep flow. Ensures `boardWavPath` exists (regenerates from
 * `regenerateFromSrc` with the standard 48 kHz mono conversion if missing),
 * then runs scripts/detect_board_fillers.py → `fillersOutPath` (envelope +
 * proposed regions). Progress via the given job (SSE). Does NOT persist
 * anything to project.json — the editor loads the JSON, the user confirms
 * regions, and the chosen set is saved separately.
 */
export async function detectBoardFillers(
  { jobId, boardWavPath, regenerateFromSrc, fillersOutPath, logTag, examplesPath }:
  { jobId: string; boardWavPath: string; regenerateFromSrc?: string; fillersOutPath: string; logTag: string; examplesPath?: string }
): Promise<void> {
  const fail = (msg: string) => { jobManager.failJob(jobId, msg); };
  try {
    // Ensure the board wav exists (same conversion as pipeline stage 2).
    try {
      await fs.access(boardWavPath);
    } catch {
      if (!regenerateFromSrc) return fail('Audio de mesa no disponible');
      jobManager.updateProgress(jobId, 5, 'Preparando audio de mesa...');
      try { await fs.access(regenerateFromSrc); }
      catch { return fail(`Audio de mesa no encontrado en disco: ${path.basename(regenerateFromSrc)}`); }
      await execFileAsync(getFFmpegPath(), [
        '-y', '-i', regenerateFromSrc, '-vn', '-ar', '48000', '-ac', '1', '-sample_fmt', 's16', boardWavPath,
      ], { timeout: 600000 });
    }

    const scriptPath = path.join(process.cwd(), 'scripts', 'detect_board_fillers.py');
    const pyArgs = [scriptPath, '--input', boardWavPath, '--output', fillersOutPath];
    if (examplesPath) pyArgs.push('--examples', examplesPath);
    console.log(`[${logTag}] python3 ${pyArgs.join(' ')}`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('python3', pyArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      jobManager.setProcess(jobId, proc);
      let stderrBuffer = '';
      let stderrFull = '';
      proc.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stderrBuffer += chunk;
        stderrFull += chunk;
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || '';
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (typeof parsed.progress === 'number') {
              jobManager.updateProgress(jobId, parsed.progress, parsed.message || 'Detectando...');
            }
          } catch { /* not JSON */ }
        }
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          const tail = stderrFull.trim().split('\n').slice(-4).join(' | ');
          return reject(new Error(`Detección falló (code ${code}): ${tail}`));
        }
        resolve();
      });
    });

    jobManager.completeJob(jobId, { fillersJson: path.basename(fillersOutPath) });
    console.log(`[${logTag}] done → ${path.basename(fillersOutPath)}`);
  } catch (err) {
    fail((err as Error).message || 'Error detectando rellenos');
  }
}

/**
 * Detect board fillers for one PART (thin wrapper over detectBoardFillers that
 * resolves the part's board wav / source paths).
 */
export async function runFillerDetection(
  { projectId, partId, jobId, examplesPath }:
  { projectId: string; partId: string; jobId: string; examplesPath?: string }
): Promise<void> {
  const fail = (msg: string) => { jobManager.failJob(jobId, msg); };
  try {
    const project = await getProject(projectId);
    if (!project) return fail('Proyecto no encontrado');
    const part = (project.parts ?? []).find((p) => p.id === partId);
    if (!part) return fail('Parte no encontrada');
    const boardSource = part.boardSourceId
      ? project.sources.find((s) => s.id === part.boardSourceId)
      : undefined;
    if (!boardSource) return fail('La parte no tiene audio de mesa');

    const prefix = partPrefix(partId);
    const audioDir = getProjectDir(projectId, 'audio');
    const sourceDir = getProjectDir(projectId, 'source');
    await detectBoardFillers({
      jobId,
      boardWavPath: path.join(audioDir, `${prefix}_board.wav`),
      regenerateFromSrc: path.join(sourceDir, boardSource.storedName),
      fillersOutPath: path.join(audioDir, `${prefix}_fillers.json`),
      logTag: `part-fillers ${prefix}`,
      examplesPath,
    });
  } catch (err) {
    fail((err as Error).message || 'Error detectando rellenos');
  }
}
