import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import type { ProjectPart, AmbientAutoRaise, BoardAutoGate } from '@/types/project';
import {
  buildDuckVolumeExpr,
  buildVoiceLevelerFilter,
  ambientSidechainDuckFilters,
} from '@/server/audio-duck';
import { getFFmpegPath } from '@/server/ffmpeg-wrapper';
import {
  computeAmbientGainDb, envelopeOfGraph, writeGainCurveWav, buildMesaGateDb, followerDb, applyManualBandsDb, CURVE_HOP_MS, MESA_GATE_OPEN_DB, type CurveStats,
} from '@/server/ambient-gain-curve';
import { absoluteAmbientBands } from '@/lib/ambient-bands';
import { LEVELER_CREST_DB } from '@/lib/leveler-curve';

const execFileAsync = promisify(execFile);

export const VOICE_TARGET_LUFS = -20;

/** Integrated loudness (EBU R128, LUFS) of a wav — gated, so silences and hot
 *  outlier peaks (claps into the mesa mic) don't skew it. Decode capped at
 *  8 min; a set's loudness is stable well before that. Cached by mtime+size
 *  so the mix preview doesn't re-measure a 500 MB wav on every click. */
const lufsCache = new Map<string, number | null>();
export async function measureLoudnessLUFS(filePath: string, maxSec = 480): Promise<number | null> {
  let key = filePath;
  try {
    const st = await fs.stat(filePath);
    key = `${filePath}:${st.mtimeMs}:${st.size}`;
    if (lufsCache.has(key)) return lufsCache.get(key)!;
  } catch { /* stat failed — measure uncached */ }
  let result: number | null = null;
  try {
    const { stderr } = await execFileAsync(getFFmpegPath(), [
      '-t', String(maxSec), '-i', filePath,
      '-af', 'ebur128=framelog=quiet', '-f', 'null', '-',
    ], { timeout: 120000, maxBuffer: 1 << 22 });
    const m = /I:\s+(-?[\d.]+)\s+LUFS/.exec(stderr ?? '');
    result = m ? parseFloat(m[1]) : null;
  } catch {
    result = null;
  }
  lufsCache.set(key, result);
  return result;
}

/** Mesa gate: depth outside voice and hold after each voice run (see buildMesaGateDb). */
export const MESA_GATE_DEPTH_DB = 24;
export const MESA_GATE_HOLD_MS = 300;

export interface BoardWindowStats {
  lufs: number | null;
  floorDb: number | null;
  /** LOUD VOICE: p95 of the follower over the frames ≥ floor+12 dB. The leveler
   *  anchors on it (loud voice → ceiling), NOT on the integrated LUFS: on the
   *  18-sep mesa I read −16 while the voice sat at −41 (pops and shouts pull I
   *  up), so the I−18…I−26 knee landed ON the voice and only the peaks rose. */
  loudDb: number | null;
}
const windowCache = new Map<string, BoardWindowStats>();

/**
 * Loudness AND room-noise floor of the board over the part's OWN window
 * (mix t=0 → the mix duration), the anchor of the leveler curve. Measuring
 * the whole file (or its first 8 min, as `measureLoudnessLUFS` does) was
 * wrong for a mesa that records the entire evening: on the 5-sep set the
 * file's head read −26 LUFS while the part's window is −43.4, so the knee
 * (I−18…I−26 = −44…−52 dBFS) sat exactly on the quiet tails of the phrases
 * and the last word of each sentence stayed at −52 while the rest rose to
 * −10. Floor = p10 of a compand-style envelope follower (attack 50 ms /
 * decay 300 ms on |x|, sampled every 25 ms) — the SCALE THE COMPAND SEES.
 * Measured on that set: RMS-50 ms p10 read −71 (the room's louder moments
 * then got +45 dB and the gaps came out as loud as the voice), while the
 * follower p10 reads −61, right where the room sits between phrases.
 */
export async function measureBoardWindow(filePath: string, startSec: number, durSec: number): Promise<BoardWindowStats> {
  const start = Math.max(0, startSec);
  const span = Math.max(5, Math.min(900, durSec));
  let key = `${filePath}:${start.toFixed(2)}:${span.toFixed(2)}`;
  try {
    const st = await fs.stat(filePath);
    key = `${filePath}:${st.mtimeMs}:${st.size}:${start.toFixed(2)}:${span.toFixed(2)}`;
    if (windowCache.has(key)) return windowCache.get(key)!;
  } catch { /* measure uncached */ }
  let lufs: number | null = null;
  let floorDb: number | null = null;
  let loudDb: number | null = null;
  try {
    const { stderr } = await execFileAsync(getFFmpegPath(), [
      '-ss', start.toFixed(3), '-t', span.toFixed(3), '-i', filePath,
      '-af', 'ebur128=framelog=quiet', '-f', 'null', '-',
    ], { timeout: 180000, maxBuffer: 1 << 22 });
    const m = /I:\s+(-?[\d.]+)\s+LUFS/.exec(stderr ?? '');
    lufs = m ? parseFloat(m[1]) : null;
  } catch { lufs = null; }
  try {
    const { stdout } = await execFileAsync(getFFmpegPath(), [
      '-v', 'error', '-ss', start.toFixed(3), '-t', span.toFixed(3), '-i', filePath,
      '-ac', '1', '-ar', '8000', '-f', 's16le', '-',
    ], { encoding: 'buffer', timeout: 180000, maxBuffer: 64 << 20 });
    const pcm = stdout as unknown as Buffer;
    const sr = 8000;
    const aAtt = Math.exp(-1 / (sr * 0.05)), aDec = Math.exp(-1 / (sr * 0.3));
    const frames: number[] = [];
    let lvl = 0;
    const n = Math.floor(pcm.length / 2);
    for (let i = 0; i < n; i++) {
      const av = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
      lvl = av + (lvl - av) * (av > lvl ? aAtt : aDec);
      if (i % 200 === 0) { // every 25 ms
        const db = 20 * Math.log10(Math.max(1e-6, lvl));
        if (db > -90) frames.push(db);
      }
    }
    if (frames.length >= 20) {
      frames.sort((a, b) => a - b);
      floorDb = Math.round(frames[Math.floor(frames.length * 0.1)] * 10) / 10;
      const voice = frames.filter((v) => v >= (floorDb as number) + 12);
      if (voice.length >= 20) loudDb = Math.round(voice[Math.floor(voice.length * 0.95)] * 10) / 10;
    }
  } catch { floorDb = null; }
  const out = { lufs, floorDb, loudDb };
  windowCache.set(key, out);
  return out;
}

export interface PartMixWindow {
  /** Window start, in MIX time (seconds from the part's t=0). */
  startSec: number;
  durSec: number;
  /** Decoded before the window so speechnorm's gain and the sidechain state
   *  are warmed up by the time the audible part starts; trimmed off the
   *  outputs. */
  prerollSec?: number;
}

export interface PartMixFilterOptions {
  part: ProjectPart;
  boardVolume: number;
  ambientVolume: number;
  /** Alignment trims (max(0, ±offset) — same convention as the worker). */
  boardTrimSec: number;
  ambientTrimSec: number;
  /** Measured board loudness of the part's window (null → neutral assumptions). */
  boardLUFS: number | null;
  /** Loud voice of the window (see BoardWindowStats.loudDb) — the leveler's real anchor. */
  boardLoudDb?: number | null;
  /** Measured room noise of the same window — the leveler's knee rides it. */
  boardNoiseFloorDb?: number | null;
  /** Cap for the stem outputs in FULL mode (the mix's duration — the raw
   *  board is the whole night). Ignored in window mode. */
  stemDurSec: number;
  /** Present → PREVIEW mode. The caller must PRE-CUT each input into a temp
   *  wav of exactly (preroll+durSec) starting at the returned input seek —
   *  running the multi-output graph with `-t`/`-ss` on the inputs, or with a
   *  head atrim shorter than the file, makes this ffmpeg build finish the
   *  outputs and then NEVER EXIT (verified empirically in every variant; the
   *  graph must consume its inputs to natural EOF, and only side branches
   *  may end early). Region envelopes are shifted to the cut timeline. */
  window?: PartMixWindow;
  /** Window mode only: emit a SINGLE-output graph ([out]) for one target.
   *  This ffmpeg build's multi-output graphs sometimes finish their files and
   *  never exit (build quirk, empirically bisected — 2-output cases pass,
   *  3-output cases stall regardless of trims/-t/codec opts); single-output
   *  runs have never failed. The preview route therefore renders its three
   *  files as three cheap solo passes over the pre-cut window. */
  soloOutput?: 'board' | 'ambient' | 'mix';
  /** PRE-COMPUTED ambient gain envelope (prepareAmbientGainCurve) fed as the
   *  THIRD input (`-i <curve.wav>`, index 2). When present the voice-duck is
   *  applied with `amultiply` instead of the reactive sidechain compressor —
   *  lookahead: minimum pause, pre-rise before the voice ends, audience
   *  gate. `gainMax` re-scales the 0..1 wav back to real gain. */
  ambientGainCurve?: { gainMax: number };
  /** Present → the MESA GATE curve (0 dB in voice + hold, −24 dB outside;
   *  written by prepareAmbientGainCurve) is input `inputIndex` and multiplies
   *  the board BEFORE the leveler. Leveled mode only. */
  boardGateCurve?: { inputIndex: number };
}

export interface PartMixFilterResult {
  filter: string;
  /** Input seeks the caller must apply (0 in full mode). */
  boardInputSeekSec: number;
  ambientInputSeekSec: number;
  /** Length of the PRE-CUT temp inputs in window mode (undefined = full). */
  inputDurSec?: number;

  log: string[];
  /** The two processed branches (label-less), for envelope extraction. */
  boardBranch: string;
  ambBranch: string;
  /** Un-leveled mesa (duck + trim only) — the cross-mic voice key. */
  rawBoardBranch: string;
  /** Voice threshold for the pre-computed duck, dBFS on a 10 ms RMS envelope. */
  keyThresholdDb: number;
}

/**
 * The ONE assembly of the part mix graph — used by the worker's full
 * "Mezclar y muxar" AND by the 30 s settings preview, so what you preview is
 * byte-for-byte the chain that will be mixed. Outputs three labeled streams:
 *   [bSave] processed MESA stem · [aSave] processed AMBIENT stem · [out] mix.
 */
export function buildPartMixFilter(o: PartMixFilterOptions): PartMixFilterResult {
  const { part } = o;
  const log: string[] = [];

  const pre = o.window ? Math.max(0, o.window.prerollSec ?? 2) : 0;
  // Window mode: both inputs get the SAME effective preroll so they stay
  // aligned even when one trim is too small to rewind the full preroll.
  const wantBoardSeek = o.window ? o.boardTrimSec + o.window.startSec - pre : 0;
  const wantAmbSeek = o.window ? o.ambientTrimSec + o.window.startSec - pre : 0;
  const shrink = Math.max(0, -Math.min(wantBoardSeek, wantAmbSeek));
  const effPre = Math.max(0, pre - shrink);
  const boardInputSeekSec = o.window ? Math.max(0, wantBoardSeek + shrink) : 0;
  const ambientInputSeekSec = o.window ? Math.max(0, wantAmbSeek + shrink) : 0;

  const gainDb = part.boardGainDb ?? 0;
  const compress = part.boardCompress ?? true;
  const leveled = part.boardSpeechLevel ?? false;
  const levelRatio = part.boardLevelRatio ?? 2;
  const levelCeilingDb = part.boardLevelCeilingDb ?? -3;
  // Measurement anchor for the leveler curve and the sidechain threshold.
  // Anchor = loud voice − crest when measured (I is unreliable: pops/shouts
  // inflate it far above the voice); integrated LUFS only as a fallback.
  const meanLUFS = o.boardLoudDb != null ? o.boardLoudDb - LEVELER_CREST_DB : (o.boardLUFS ?? VOICE_TARGET_LUFS);
  if (leveled || part.ambientDuckOnVoice) {
    log.push(`board loudness ${o.boardLUFS ?? '? (assumed -20)'} LUFS, loud voice ${o.boardLoudDb ?? '?'} dB → anchor ${meanLUFS.toFixed(1)}`);
  }

  const boardFilters: string[] = [];
  if (leveled) {
    // Ratio leveler anchored to measured loudness: loud → ceiling, quieter
    // lines get MORE boost but keep 1/ratio of the original differences.
    boardFilters.push(buildVoiceLevelerFilter({
      meanLUFS, ratio: levelRatio, ceilingDb: levelCeilingDb,
      noiseFloorDb: o.boardNoiseFloorDb ?? undefined,
      gated: !!o.boardGateCurve,
      kneeDb: part.boardLevelKneeDb,
    }));
    log.push(`leveler: ratio ${levelRatio}:1, ceiling ${levelCeilingDb} dB (anchored at ${meanLUFS} LUFS, room ${o.boardNoiseFloorDb ?? '?'} dB${o.boardGateCurve ? ', gated: knee under the floor' : ''})`);
    if (o.boardGateCurve) log.push(`mesa gate: pre-computed voice mask (input ${o.boardGateCurve.inputIndex}) multiplies the board before the leveler`);
  } else if (compress) {
    boardFilters.push('compand=attacks=0.005:decays=0.1:points=-80/-80|-25/-25|0/-6|20/20');
  }
  // Manual gain only in manual mode — under the leveler it would stack after
  // the 0.95 ceiling and grind everything into the limiter.
  if (gainDb !== 0 && !leveled) boardFilters.push(`volume=${gainDb}dB`);
  if (gainDb !== 0 && leveled) log.push(`boardGainDb ${gainDb} dB IGNORED (Nivelar voz active)`);
  if (leveled) {
    // Transparent safety limiter 1 dB above the ceiling, ONLY for overshoots
    // (compand's 50 ms attack lets fast transients through at the old gain).
    // level=0 is critical: alimiter DEFAULTS to level=1, which re-normalizes
    // the limited output to full scale — that squashed everything to 0 dBFS
    // regardless of the curve (the harsh "acople" sound).
    const lim = Math.pow(10, Math.min(levelCeilingDb + 1, -0.5) / 20);
    boardFilters.push(`alimiter=limit=${lim.toFixed(3)}:attack=5:release=50:level=0`);
  } else if (boardFilters.length > 0) {
    boardFilters.push('alimiter=limit=0.95:attack=5:release=50');
  }
  const gainChain = boardFilters.length > 0 ? boardFilters.join(',') + ',' : '';

  // Duck/boost region envelopes carry ABSOLUTE times in their wav — in window
  // mode the input is pre-seeked, so shift the regions to the seeked timeline.
  const shiftRegions = (regions: ProjectPart['boardDuckRegions'], seekSec: number) =>
    seekSec > 0
      ? (regions ?? []).map((r) => ({ ...r, startMs: r.startMs - seekSec * 1000, endMs: r.endMs - seekSec * 1000 }))
      : regions;
  const duckExpr = buildDuckVolumeExpr(shiftRegions(part.boardDuckRegions, boardInputSeekSec));
  const duckChain = duckExpr ? `volume=eval=frame:volume='${duckExpr}',` : '';
  if (duckExpr) log.push(`ducking ${(part.boardDuckRegions ?? []).filter((r) => r.enabled).length} board region(s)`);
  // Manual ambient LEVEL zones (absolute dB over the original ambient). With
  // the duck ON they are BAKED into the pre-computed curve by
  // prepareAmbientGainCurve — they REPLACE the engine's level there — and they
  // must stay OUT of the branch: the envelope pass that decides the raises
  // would read a raised zone as a laugh and re-decide a wider raise around it
  // (the "+4 dB auto" remnants beside a taken-over raise). Duck OFF → there is
  // no curve: the zones are a plain volume expression over a flat 0 dB base,
  // the same absolute meaning.
  const manualBands = absoluteAmbientBands(part).filter((r) => r.enabled);
  const boostExpr = part.ambientDuckOnVoice ? null : buildDuckVolumeExpr(shiftRegions(manualBands, ambientInputSeekSec));
  const boostChain = boostExpr ? `volume=eval=frame:volume='${boostExpr}',` : '';
  if (boostExpr) log.push(`ambient level zones: ${manualBands.length} (volume expression, duck off)`);

  // Sidechain threshold scaled to where the PROCESSED board actually sits.
  // Leveled: the curve puts the MEAN at ceiling − crest/ratio by design.
  const postLevelLUFS =
    (leveled ? levelCeilingDb - 18 / levelRatio : meanLUFS + gainDb) +
    20 * Math.log10(Math.max(0.05, o.boardVolume));
  const duckThresholdLin = Math.max(0.002, Math.min(0.1,
    0.02 * Math.pow(10, (postLevelLUFS - VOICE_TARGET_LUFS) / 20)));
  const useCurve = !!(o.ambientGainCurve && part.ambientDuckOnVoice);
  const voiceDuck = part.ambientDuckOnVoice && !useCurve
    ? ambientSidechainDuckFilters({
        boardLabel: 'board', ambientLabel: 'amb0', outLabel: 'amb',
        depthDb: part.ambientVoiceDuckDb, releaseMs: part.ambientVoiceReleaseMs,
        anticipateMs: part.ambientVoiceAnticipateMs,
        attackMs: part.ambientVoiceAttackMs,
        holdMs: part.ambientVoiceHoldMs,
        gapBoostDb: part.ambientGapBoostDb,
        thresholdLin: duckThresholdLin,
      })
    : null;
  if (voiceDuck) {
    log.push(
      `voice-duck ambient: -${part.ambientVoiceDuckDb ?? 8} dB under voice, +${part.ambientGapBoostDb ?? 0} dB in gaps, ` +
      `attack ${part.ambientVoiceAttackMs ?? 15} ms, hold(min pause) ${part.ambientVoiceHoldMs ?? 600} ms, release ${part.ambientVoiceReleaseMs ?? 400} ms, ` +
      `anticipate ${part.ambientVoiceAnticipateMs ?? 200} ms, threshold ${duckThresholdLin.toFixed(4)}`,
    );
  }
  // Envelope duck: both streams forced to the same format for amultiply.
  const curveLines = useCurve ? [
    `[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[gainR]`,
    `[amb0]aformat=sample_fmts=fltp:channel_layouts=mono[amb0f]`,
    `[amb0f][gainR]amultiply,volume=${o.ambientGainCurve!.gainMax.toFixed(6)}[amb]`,
  ] : null;
  if (useCurve) {
    log.push(
      `voice-duck ambient (pre-computed envelope): -${part.ambientVoiceDuckDb ?? 8} dB under voice, +${part.ambientGapBoostDb ?? 0} dB in active gaps, ` +
      `min pause ${part.ambientVoiceHoldMs ?? 600} ms, pre-rise ${part.ambientPreRiseMs ?? 150} ms, gate +${part.ambientGateDb ?? 6} dB, ` +
      `attack ${part.ambientVoiceAttackMs ?? 15} ms, release ${part.ambientVoiceReleaseMs ?? 400} ms, anticipate ${part.ambientVoiceAnticipateMs ?? 200} ms`,
    );
  }
  const ambProc = voiceDuck ? voiceDuck.join(';') + ';' : curveLines ? curveLines.join(';') + ';' : `[amb0]anull[amb];`;
  const curveSink = useCurve ? ';[2:a]anullsink' : '';
  const boardOut = voiceDuck ? 'boardM' : 'board';

  // In-graph head trims: full mode does the alignment trim here (absolute
  // region times need the untrimmed head); window mode already input-seeked.
  const boardHead = o.window ? 0 : o.boardTrimSec;
  const ambHead = o.window ? 0 : o.ambientTrimSec;
  // Stem/output tails. Window mode trims only the PREROLL head in-graph; the
  // window LENGTH is bounded by the caller's per-INPUT `-t` (preroll+dur), so
  // every branch reaches EOF together. Do NOT cut a branch early (in-graph
  // atrim=end or per-output -t): a finished branch stops consuming, its
  // asplit queue fills and the whole multi-output graph deadlocks — observed
  // empirically, progress frozen exactly at the window end in all variants.
  const stemCap = o.window
    ? `atrim=start=${effPre.toFixed(3)},asetpts=PTS-STARTPTS`
    : `atrim=duration=${o.stemDurSec.toFixed(3)}`;
  const outTail = o.window
    ? `;[outRaw]atrim=start=${effPre.toFixed(3)},asetpts=PTS-STARTPTS[out]`
    : '';
  const outLabel = o.window && !o.soloOutput ? 'outRaw' : 'out';

  // Mesa gate (leveled mode): the pre-computed voice mask multiplies the
  // board right after the alignment trim — same clock as the envelopes it
  // was computed on — and before the leveler.
  const gate = leveled && o.boardGateCurve ? o.boardGateCurve : null;
  const boardPre = gate
    ? `[0:a]${duckChain}atrim=start=${boardHead.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=mono[bPre];` +
      `[${gate.inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[gateR];` +
      `[bPre][gateR]amultiply,`
    : `[0:a]${duckChain}atrim=start=${boardHead.toFixed(3)},asetpts=PTS-STARTPTS,`;
  const boardBranch = `${boardPre}${gainChain}volume=${o.boardVolume}`;
  // The mesa as the mic heard it (je-je duck kept so marked zones read as
  // silence; NO leveler/gain) — the voice detector of the ambient envelope
  // compares this against the camera. The leveled branch is useless for
  // that: it lifts the audience bleed in the mesa mic to voice level.
  const rawBoardBranch = `[0:a]${duckChain}atrim=start=${boardHead.toFixed(3)},asetpts=PTS-STARTPTS`;
  const ambBranch = `[1:a]${boostChain}atrim=start=${ambHead.toFixed(3)},asetpts=PTS-STARTPTS,volume=${o.ambientVolume}`;
  const headTrim = o.window ? `atrim=start=${effPre.toFixed(3)},asetpts=PTS-STARTPTS` : 'anull';

  // Solo-stem tails: preview trims the preroll head; FULL mode caps the stem
  // to the mix duration (the raw board is the whole night). Early atrim=end
  // on a SINGLE-output graph exits fine — the no-exit quirk only bites
  // multi-output graphs (verified empirically both ways).
  const soloTail = o.window ? headTrim : `atrim=duration=${o.stemDurSec.toFixed(3)}`;
  let filter: string;
  if (o.soloOutput === 'board') {
    // Just the processed mesa; the other inputs are drained to EOF.
    filter = `${boardBranch}[board0];[board0]${soloTail}[out];[1:a]anullsink${curveSink}`;
  } else if (o.soloOutput === 'ambient') {
    // Processed ambient incl. voice-duck (sidechain: key = processed board,
    // fully drained; envelope: the board branch is simply sunk).
    filter =
      `${boardBranch}[board];` +
      `${ambBranch}[amb0];` +
      ambProc + (voiceDuck ? '[boardM]anullsink;' : '[board]anullsink;') +
      `[amb]${soloTail}[out]`;
  } else if (o.soloOutput === 'mix') {
    filter =
      `${boardBranch}[board];` +
      `${ambBranch}[amb0];` +
      ambProc +
      `[${boardOut}][amb]amix=inputs=2:duration=shortest,alimiter=limit=0.95:attack=5:release=50[outRaw];` +
      `[outRaw]${headTrim}[out]`;
  } else {
    filter =
      `${boardBranch}[board0];` +
      `${ambBranch}[amb0];` +
      `[board0]asplit=2[board][bSave0];[bSave0]${stemCap}[bSave];` +
      ambProc +
      `[amb]asplit=2[ambF][aSave0];[aSave0]${stemCap}[aSave];` +
      `[${boardOut}][ambF]amix=inputs=2:duration=shortest,alimiter=limit=0.95:attack=5:release=50[${outLabel}]` +
      outTail;
  }

  return {
    filter,
    boardInputSeekSec,
    ambientInputSeekSec,
    inputDurSec: o.window ? effPre + o.window.durSec : undefined,
    log,
    boardBranch,
    ambBranch,
    rawBoardBranch,
    keyThresholdDb: 20 * Math.log10(duckThresholdLin) - 6,
  };
}

/**
 * Compute the ambient gain envelope for the mix described by `o` and write
 * it as a wav (8 kHz mono s16, 0..1 × gainMax). Inputs must be the SAME files
 * the mix passes will get as inputs 0/1 (full: the raw wavs; window: the
 * pre-cut temp wavs), so the envelope timeline equals the branch timeline.
 * ~2 s for a 25-min set (two decodes at 8 kHz + JS). Returns the option to
 * pass as `ambientGainCurve` plus stats for the log.
 */
export async function prepareAmbientGainCurve(
  o: PartMixFilterOptions,
  boardInput: string,
  ambientInput: string,
  outPath: string,
  /** Room floor from a previous FULL analysis — the preview passes it so its
   *  audience gate matches the mix (a 30 s window's own p10 sits ±3 dB off). */
  roomFloorDb?: number,
  /** Cross-mic voice calibration from a previous FULL analysis (the preview
   *  passes it — a 30 s window can't calibrate itself). */
  voiceCalib?: { deltaDb: number; floorDb: number; loudDb: number; mesaFloorDb?: number },
  /** When given (leveled mode), the MESA GATE curve is written here too. */
  mesaGatePath?: string,
): Promise<{ gainMax: number; stats: CurveStats; log: string[]; autoRaises: AmbientAutoRaise[]; autoGates: BoardAutoGate[]; mesaGate: boolean }> {
  const base = buildPartMixFilter({ ...o, ambientGainCurve: undefined, boardGateCurve: undefined, soloOutput: 'mix' });
  const [keyDb, ambDb, rawDb] = await Promise.all([
    envelopeOfGraph([boardInput, ambientInput], `[1:a]anullsink;${base.boardBranch}`),
    envelopeOfGraph([boardInput, ambientInput], `[0:a]anullsink;${base.ambBranch}`),
    envelopeOfGraph([boardInput, ambientInput], `[1:a]anullsink;${base.rawBoardBranch}`),
  ]);
  const { part } = o;
  // Filler zones → pauses. The envelopes live in the branch timeline: full
  // mode trims the board head in-graph (boardTrimSec), window mode pre-cut
  // the input at boardInputSeekSec — shift the absolute region times by
  // whichever applies so they land on the same clock.
  const regionOffsetMs = (o.window ? base.boardInputSeekSec : o.boardTrimSec) * 1000;
  const mutedRangesMs = (part.boardDuckRegions ?? [])
    .filter((r) => r.enabled && r.attenuationDb <= -1)
    .map((r) => [
      Math.min(r.startMs, r.endMs) - regionOffsetMs,
      Math.max(r.startMs, r.endMs) - regionOffsetMs,
    ] as [number, number]);
  // KEEP-OPEN zones live on the BOARD wav clock (like the je-je zones), so they
  // take the same shift.
  const keepOpenRangesMs = (part.boardKeepOpenRegions ?? [])
    .filter((r) => r.enabled)
    .map((r) => [
      Math.min(r.startMs, r.endMs) - regionOffsetMs,
      Math.max(r.startMs, r.endMs) - regionOffsetMs,
    ] as [number, number]);
  // "No raise" zones live on the CAMERA wav clock (like the boost regions):
  // full mode trims the ambient head in-graph, window mode pre-seeks it.
  const ambRegionOffsetMs = (o.window ? base.ambientInputSeekSec : o.ambientTrimSec) * 1000;
  const noRaiseRangesMs = (part.ambientNoRaiseRegions ?? [])
    .filter((r) => r.enabled)
    .map((r) => [
      Math.min(r.startMs, r.endMs) - ambRegionOffsetMs,
      Math.max(r.startMs, r.endMs) - ambRegionOffsetMs,
    ] as [number, number]);
  const { gainDb, stats, raiseRangesMs, gateVoice } = computeAmbientGainDb(keyDb, ambDb, CURVE_HOP_MS, {
    mutedRangesMs,
    noRaiseRangesMs,
    keepOpenRangesMs,
    depthDb: Math.max(1, Math.min(60, part.ambientVoiceDuckDb ?? 8)),
    gapBoostDb: Math.max(0, Math.min(12, part.ambientGapBoostDb ?? 0)),
    attackMs: Math.max(5, Math.min(500, part.ambientVoiceAttackMs ?? 15)),
    releaseMs: Math.max(50, Math.min(3000, part.ambientVoiceReleaseMs ?? 400)),
    anticipateMs: Math.max(0, Math.min(1000, part.ambientVoiceAnticipateMs ?? 200)),
    minPauseMs: Math.max(0, Math.min(2000, part.ambientVoiceHoldMs ?? 600)),
    preRiseMs: Math.max(0, Math.min(1000, part.ambientPreRiseMs ?? 150)),
    gateDb: Math.max(0, Math.min(30, part.ambientGateDb ?? 6)),
    keyThresholdDb: base.keyThresholdDb,
    roomFloorDb,
    crossMicRawDb: rawDb,
    crossMicCalib: voiceCalib,
  });
  // The user's LEVEL zones, on the same clock as the vetoes: each one replaces
  // the decided level inside its span (see applyManualBandsDb).
  const bandsBaked = applyManualBandsDb(
    gainDb,
    CURVE_HOP_MS,
    absoluteAmbientBands(part)
      .filter((r) => r.enabled)
      .map((r) => ({ ...r, startMs: r.startMs - ambRegionOffsetMs, endMs: r.endMs - ambRegionOffsetMs })),
  );
  const ambDurSec = (ambDb.length * CURVE_HOP_MS) / 1000;
  const { gainMax } = await writeGainCurveWav(gainDb, CURVE_HOP_MS, outPath, ambDurSec + 2);
  let mesaGate = false;
  let gateLog = '';
  let autoGates: BoardAutoGate[] = [];
  // The gate is OPT-IN (part.boardGate): off, the leveler runs ungated and no closures exist.
  if (mesaGatePath && (part.boardSpeechLevel ?? false) && (part.boardGate ?? false)) {
    const { gainDb: gateDb, closedRangesMs } = buildMesaGateDb(gateVoice, CURVE_HOP_MS, { depthDb: MESA_GATE_DEPTH_DB, holdMs: MESA_GATE_HOLD_MS, leadMs: 30, openMs: 10, closeMs: 250 });
    await writeGainCurveWav(gateDb, CURVE_HOP_MS, mesaGatePath, ambDurSec + 2);
    // The decided closures, back on the BOARD wav clock (what the je-je zones
    // and the timeline use), CAPPED to the audible mix: in full mode the mesa
    // envelope runs to the end of the whole board file — on a dinner-long mp3
    // that is an hour of "closed" past the end of the part, which would land
    // as one monster box on the timeline and in project.json.
    const mixEndMs = Math.min(keyDb.length, ambDb.length, rawDb.length) * CURVE_HOP_MS;
    autoGates = closedRangesMs
      .filter(([a]) => a < mixEndMs)
      .map(([a, b]) => ({
        startMs: Math.round(a + regionOffsetMs),
        endMs: Math.round(Math.min(b, mixEndMs) + regionOffsetMs),
        db: -MESA_GATE_DEPTH_DB,
      }));
    const closed = autoGates.length;
    mesaGate = true;
    gateLog = `; mesa gate −${MESA_GATE_DEPTH_DB} dB where the mesa sits at its floor (follower ≤ ${stats.calibMesaFloorDb.toFixed(1)} + ${MESA_GATE_OPEN_DB} dB and no cross-mic voice; +${MESA_GATE_HOLD_MS} ms hold), ${closed} closed stretches, ${stats.keepOpenZones} kept open by hand → ${mesaGatePath.split('/').pop()}`;
  }
  // The decided raises, back on the CAMERA wav clock (same clock as the
  // manual raise / no-raise regions the timeline edits).
  const raiseDb = Math.max(0, Math.min(12, part.ambientGapBoostDb ?? 0));
  const autoRaises: AmbientAutoRaise[] = raiseRangesMs.map(([a, b]) => ({
    startMs: Math.round(a + ambRegionOffsetMs),
    endMs: Math.round(b + ambRegionOffsetMs),
    db: raiseDb,
  }));
  return {
    gainMax,
    stats,
    autoRaises,
    autoGates,
    mesaGate,
    log: [`ambient envelope (${autoRaises.length} automatic raises, ${stats.noRaiseZones} vetoed, ${bandsBaked} manual level zone(s) baked in; ${stats.voiceRule}${stats.voiceRule === 'cross-mic' ? `, mesa−cámara en voz ${stats.calibDeltaDb.toFixed(1)} dB` : ''}): voice ${(stats.voiceFrac * 100).toFixed(0)}%, ${stats.mutedZones} filler zones freed, ${stats.shortGapsFilled} short gaps filled, ${stats.longGaps} long pauses (${stats.activeGaps} with a real audience event, ${stats.noEventGaps} rejected as no event, room floor ${stats.roomFloorDb.toFixed(1)} dB) → ${outPath.split('/').pop()}${gateLog}`],
  };
}

/**
 * The MESA GATE's floor measured over the WHOLE part: p10 of the compand-style
 * follower of the raw mesa (alignment trim only — no je-je duck, no leveler;
 * the engine's own estimate skips the ducked zones for the same reason) — the
 * statistic `computeAmbientGainDb` derives on a full run and persists as
 * `ambientVoiceCalibMesaFloorDb`. The 30 s preview calls this once for parts
 * mixed before that field existed: a window's own p10 is mostly voice, not a
 * floor, and a floor 6 dB too high shuts the gate on quiet words.
 */
export async function measureMesaGateFloorDb(o: PartMixFilterOptions, boardInput: string, ambientInput: string, durSec: number): Promise<number> {
  const raw = await envelopeOfGraph(
    [boardInput, ambientInput],
    `[1:a]anullsink;[0:a]atrim=start=${Math.max(0, o.boardTrimSec).toFixed(3)},asetpts=PTS-STARTPTS,atrim=duration=${Math.max(1, durSec).toFixed(3)}`,
  );
  const f = Array.from(followerDb(raw, CURVE_HOP_MS)).sort((x, y) => x - y);
  return f.length ? f[Math.min(f.length - 1, Math.floor(f.length * 0.10))] : -90;
}
