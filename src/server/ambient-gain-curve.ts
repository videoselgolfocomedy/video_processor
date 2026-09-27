import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { getFFmpegPath } from '@/server/ffmpeg-wrapper';
import { bandWeightAt } from '@/lib/ambient-bands';
import type { BoardDuckRegion } from '@/types/project';

/**
 * Voice-aware AMBIENT gain as a PRE-COMPUTED envelope (applied with
 * `amultiply`), replacing the reactive sidechain compressor. A compressor
 * cannot know whether the gap that just started will be a 150 ms breath or
 * the end of the phrase, nor whether the audience is actually laughing —
 * the recording is on disk, so we can look ahead and decide:
 *
 *   · voice = processed mesa (post je-je filter + leveler) above a threshold,
 *     with gaps SHORTER than `minPauseMs` filled in → the ambient never pumps
 *     up between words; an attenuated je-je reads as silence, so it counts
 *     as a pause;
 *   · in a long gap the ambient rises only while the audience is actually
 *     there: its level must sit ≥ `gateDb` above the ambient's own room floor
 *     (a quiet pause stays ducked — no room noise creeping in);
 *   · the rise into a laugh starts `preRiseMs` BEFORE the voice really ends
 *     (lookahead) so the laugh swells under the last words instead of
 *     jumping in after them; the drop starts `anticipateMs` before the next
 *     voice; ramps are `releaseMs` up and `attackMs` down, linear in dB;
 *   · levels: −depthDb under voice, +gapBoostDb in an active gap (relative to
 *     the ORIGINAL ambient level).
 */
export interface AmbientCurveParams {
  depthDb: number;
  gapBoostDb: number;
  attackMs: number;
  releaseMs: number;
  anticipateMs: number;
  minPauseMs: number;
  preRiseMs: number;
  gateDb: number;
  /** Voice threshold on the key's 10 ms RMS envelope, dBFS. */
  keyThresholdDb: number;
  /** Ranges (ms, in the SAME timeline as the envelopes) that must count as a
   *  PAUSE whatever their level: the enabled je-je/filler zones. Attenuating
   *  a zone only frees the gap if the result falls under the voice threshold
   *  (−18 dB on a −6 dB phrase does NOT), so the intent is honoured directly
   *  — mark it as filler and the ambient may rise there. */
  mutedRangesMs?: Array<[number, number]>;
  /** Ranges (ms, envelope clock — the same clock as mutedRangesMs) where the MESA
   *  GATE must stay OPEN whatever the follower / cross-mic rule decided: the user's
   *  veto over an automatic closure. Only `gateVoice` is forced — the ambient's own
   *  `voice` mask is deliberately untouched (the two engines are decoupled; the
   *  ambient has its own veto, noRaiseRangesMs). */
  keepOpenRangesMs?: Array<[number, number]>;
  /** Ranges (ms, envelope clock) where the automatic raise is FORBIDDEN: the
   *  target stays at the voice level whatever the gate decided — the user's
   *  way to kill a swell that turned out to be noise, marked on the timeline. */
  noRaiseRangesMs?: Array<[number, number]>;
  /** CROSS-MIC voice key: the mesa as recorded (un-leveled, je-je duck kept),
   *  same clock as `keyDb`. When present the voice decision is
   *      voice ⇔ (mesa − cámara) > calib.delta − margin  ∧  mesa > calib.floor + 6
   *  on 100 ms-smoothed envelopes. The mesa mic hears the comic ~15 dB above
   *  what the camera hears him, and the audience the other way round — so
   *  the RATIO says WHO is sounding regardless of how loud. A level threshold
   *  on the leveled mesa cannot: the leveler lifts the laughter bleeding into
   *  the mesa mic to speech level (measured on the real set: bleed at
   *  −27 dB vs threshold −33 → 372 of 435 loud-audience stretches counted
   *  as voice, the ambient never rose there). */
  crossMicRawDb?: Float32Array;
  /** Calibration measured on a previous FULL run (a 30 s preview window
   *  cannot calibrate itself): delta = median(mesa − cámara) over the loudest
   *  30 % mesa hops, floor = mesa p10. */
  crossMicCalib?: { deltaDb: number; floorDb: number; loudDb: number; mesaFloorDb?: number };
  /** How far below the voice ratio still counts as voice (dB). Default 6:
   *  on the real set, 62 of 74 audience pauses freed, 0 clear-voice
   *  stretches mistaken for pause; 8 → 50 freed, 12 → 23 freed. */
  crossMicMarginDb?: number;
  /** Room floor (dBFS) measured over the WHOLE recording. The 30 s preview
   *  passes the value stored by the last full mix so its gate decisions match
   *  the mix — a window's own p10 can sit ±3 dB off the real floor. */
  roomFloorDb?: number;
}

export const CURVE_HOP_MS = 10;
export const CURVE_SAMPLE_RATE = 8000;
/** The mesa gate opens whenever the mesa follower sits this far over its own
 *  floor (besides wherever the cross-mic rule hears voice). */
export const MESA_GATE_OPEN_DB = 6;

/** Compand-style level follower over a dB envelope: instant attack, release
 *  limited to `releaseDbPerMs` (default −8.7 dB per 300 ms — a 300 ms time
 *  constant, what the leveler's own detector sees). Syllable valleys of
 *  100–200 ms barely dent it; a word's tail rides it down. */
export function followerDb(src: Float32Array, hopMs: number, releaseDbPerMs = 8.686 / 300): Float32Array {
  const out = new Float32Array(src.length);
  const step = releaseDbPerMs * hopMs;
  let g = src.length ? src[0] : -90;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    g = v > g ? v : Math.max(v, g - step);
    out[i] = g;
  }
  return out;
}

export interface CurveStats {
  voiceFrac: number;
  /** Filler zones that landed inside the analysed range and freed a gap. */
  mutedZones: number;
  longGaps: number;
  activeGaps: number;
  /** Long pauses rejected because no continuous audience event was found. */
  noEventGaps: number;
  noRaiseZones: number;
  shortGapsFilled: number;
  /** The room floor actually used (measured or passed in). */
  roomFloorDb: number;
  voiceRule: 'cross-mic' | 'threshold';
  /** Cross-mic calibration used (0 for the threshold rule). */
  calibDeltaDb: number;
  calibFloorDb: number;
  /** Median raw mesa over its loudest 30 % — the "on-mic and loud" level. */
  calibLoudDb: number;
  /** p10 of the raw mesa's compand-style follower — the MESA GATE's floor. */
  calibMesaFloorDb: number;
  /** Keep-open zones that landed inside the analysed range. */
  keepOpenZones: number;
}

/**
 * Gain per hop (dB), from the key (processed mesa) and ambient envelopes in
 * dBFS at `hopMs`. Pure — unit-testable without ffmpeg.
 */
export function computeAmbientGainDb(
  keyDb: Float32Array,
  ambDb: Float32Array,
  hopMs: number,
  p: AmbientCurveParams,
): { gainDb: Float32Array; stats: CurveStats; raiseRangesMs: Array<[number, number]>; voice: Uint8Array; gateVoice: Uint8Array } {
  const n = Math.max(keyDb.length, ambDb.length);
  const at = (arr: Float32Array, i: number) => arr[Math.min(arr.length - 1, i)];
  const H = (ms: number) => Math.max(0, Math.round(ms / hopMs));
  // Every statistic (calibration percentiles, room floor) is measured ONLY over
  // the stretch where all inputs really exist. The camera wav is the whole
  // night and the mesa wav only the set, so `n` runs ~7 min past the end of the
  // mesa with `at()` clamping repeating its last sample: on the real recording
  // that was 21 % of the samples, and it dragged the mesa percentiles and the
  // room floor down (a lower floor makes the audience gate open on room tone).
  // The mix itself is `amix duration=shortest`, so that tail is never heard.
  const validN = Math.max(
    1,
    Math.min(
      keyDb.length || n,
      ambDb.length || n,
      p.crossMicRawDb && p.crossMicRawDb.length ? p.crossMicRawDb.length : n,
    ),
  );
  const pct = (src: Float32Array, q: number, len = validN): number => {
    const a = Array.from(src.subarray(0, Math.min(len, src.length))).sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : -90;
  };

  // 1) Raw voice activity, then remove voice blips shorter than 60 ms and
  //    FILL gaps shorter than the minimum pause (closing) — lookahead is
  //    free offline, which is what a compressor can't do.
  const voice = new Uint8Array(n);
  const smoothMean = (src: Float32Array, halfW: number): Float32Array => {
    const out = new Float32Array(n);
    let sum = 0, cnt = 0;
    // sliding window [i-halfW, i+halfW]
    for (let i = 0; i < Math.min(n, halfW + 1); i++) { sum += at(src, i); cnt++; }
    for (let i = 0; i < n; i++) {
      out[i] = cnt ? sum / cnt : -90;
      const add = i + halfW + 1, drop = i - halfW;
      if (add < n) { sum += at(src, add); cnt++; }
      if (drop >= 0) { sum -= at(src, drop); cnt--; }
    }
    return out;
  };
  let voiceRule: CurveStats['voiceRule'] = 'threshold';
  let calibDeltaDb = 0, calibFloorDb = 0, calibLoudDb = 0, calibMesaFloorDb = -90;
  // The MESA GATE's own mask (`gateVoice`): the cross-mic voice PLUS "the
  // mesa mic hears something clearly over its own room floor". The cross-mic
  // rule alone closed the gate on the comic's own words whenever he turned
  // from the mic or kept talking under a laugh — the ratio falls with the
  // mesa while the camera keeps hearing the room (measured on the real set:
  // voice at −52…−57 dB with the camera at −18, ratio −33…−38 against the
  // −30.7 threshold → "no voice", −24 dB on the word, "suena alejándose").
  // The level test runs a compand-style follower (instant attack, 300 ms
  // release — what the leveler itself sees) against that follower's own p10
  // floor: on that set the audience bleeding into the mesa sits AT the floor
  // (laugh −70…−74 vs floor −62) so the gate still shuts on laughs; on a mesa
  // that hears the room (30-ago: bleed at floor+14) it opens and the leveler
  // lifts the bleed as it did before the gate existed — the accepted state,
  // and never a lost word.
  const gateVoice = new Uint8Array(n);
  if (p.crossMicRawDb && p.crossMicRawDb.length > 0) {
    voiceRule = 'cross-mic';
    const rawSm = smoothMean(p.crossMicRawDb, H(100));
    const ambSm100 = smoothMean(ambDb.length ? ambDb : new Float32Array(n), H(100));
    if (p.crossMicCalib) {
      calibDeltaDb = p.crossMicCalib.deltaDb;
      calibFloorDb = p.crossMicCalib.floorDb;
      calibLoudDb = p.crossMicCalib.loudDb;
    } else {
      const p70 = pct(rawSm, 0.70);
      calibFloorDb = pct(rawSm, 0.10);
      calibLoudDb = pct(rawSm, 0.85);
      const diffs: number[] = [];
      for (let i = 0; i < validN; i++) if (rawSm[i] >= p70) diffs.push(rawSm[i] - ambSm100[i]);
      diffs.sort((a, b) => a - b);
      calibDeltaDb = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
    }
    const margin = p.crossMicMarginDb ?? 6;
    for (let i = 0; i < n; i++) {
      voice[i] = (rawSm[i] - ambSm100[i] > calibDeltaDb - margin && rawSm[i] > calibFloorDb + 6) ? 1 : 0;
    }
    // Loud override: when the comic shouts OVER a roar the ratio can fall (the
    // camera is drowning in audience), but a mesa sustained near its loud
    // level for ≥ 500 ms is on-mic speech whatever the camera says. Shorter
    // bursts (a "¡eh!" inside a laugh) deliberately stay pause — the laugh
    // keeps riding, the mesa is not ducked anyway.
    const loud = new Uint8Array(n);
    for (let i = 0; i < n; i++) loud[i] = rawSm[i] > calibLoudDb - 4 ? 1 : 0;
    {
      let i = 0;
      while (i < n) {
        // 400 ms on the 100 ms-smoothed envelope ≈ 500 ms of actual speech.
        if (loud[i]) { let j = i; while (j < n && loud[j]) j++; if (j - i >= H(400)) voice.fill(1, i, j); i = j; } else i++;
      }
    }
    // Gate mask: the follower's own floor is measured on the full run and
    // persisted like the other calibration values (a 30 s window is mostly
    // voice — its p10 is no floor). The enabled je-je zones are ducked in
    // this envelope (−30 dB on a loud "je-je"): a set with dozens of them
    // (30-ago: 80+) would put the p10 INSIDE those zones, 7 dB under the
    // real room — so the floor is taken over the hops outside them.
    const follower = followerDb(p.crossMicRawDb, hopMs);
    if (p.crossMicCalib?.mesaFloorDb != null) {
      calibMesaFloorDb = p.crossMicCalib.mesaFloorDb;
    } else {
      const mutedHop = new Uint8Array(n);
      for (const [ms0, ms1] of p.mutedRangesMs ?? []) {
        const a = Math.max(0, Math.round(ms0 / hopMs)), b = Math.min(n, Math.round(ms1 / hopMs));
        if (b > a) mutedHop.fill(1, a, b);
      }
      const keep: number[] = [];
      for (let i = 0; i < Math.min(validN, follower.length); i++) if (!mutedHop[i]) keep.push(follower[i]);
      const src = Float32Array.from(keep);
      calibMesaFloorDb = pct(src, 0.10, src.length);
    }
    for (let i = 0; i < n; i++) gateVoice[i] = voice[i] || at(follower, i) > calibMesaFloorDb + MESA_GATE_OPEN_DB ? 1 : 0;
  } else {
    for (let i = 0; i < n; i++) voice[i] = at(keyDb, i) > p.keyThresholdDb ? 1 : 0;
    gateVoice.set(voice);
  }
  const runs = (arr: Uint8Array, val: number): Array<[number, number]> => {
    const r: Array<[number, number]> = [];
    let i = 0;
    while (i < n) {
      if (arr[i] === val) { let j = i; while (j < n && arr[j] === val) j++; r.push([i, j]); i = j; } else i++;
    }
    return r;
  };
  // Enabled filler zones are pauses BY DEFINITION (see mutedRangesMs) — for
  // the gate too: a marked je-je stays shut whatever its level.
  let mutedZones = 0;
  for (const [ms0, ms1] of p.mutedRangesMs ?? []) {
    const a = Math.max(0, Math.round(ms0 / hopMs));
    const b = Math.min(n, Math.round(ms1 / hopMs));
    if (b > a) { voice.fill(0, a, b); gateVoice.fill(0, a, b); mutedZones++; }
  }
  // Voice blips shorter than 60 ms out, gaps shorter than the minimum pause
  // FILLED (closing) — lookahead is free offline, which is what a compressor
  // can't do. Same tidy-up for both masks.
  const minPause = H(p.minPauseMs);
  const tidy = (m: Uint8Array): number => {
    for (const [a, b] of runs(m, 1)) if (b - a < H(60)) m.fill(0, a, b);
    let filled = 0;
    for (const [a, b] of runs(m, 0)) if (a > 0 && b < n && b - a < minPause) { m.fill(1, a, b); filled++; }
    return filled;
  };
  const shortGapsFilled = tidy(voice);
  tidy(gateVoice);
  // KEEP-OPEN zones (the user's veto over an automatic closure) force the gate
  // mask open, AFTER tidy: blip removal deletes 1-runs under 60 ms, so a short
  // zone — a quick drag, or one clipped by the window start — would otherwise
  // be erased by the very cleanup meant for the detector's noise.
  let keepOpenZones = 0;
  for (const [ms0, ms1] of p.keepOpenRangesMs ?? []) {
    const a = Math.max(0, Math.round(Math.min(ms0, ms1) / hopMs));
    const b = Math.min(n, Math.round(Math.max(ms0, ms1) / hopMs));
    if (b > a) { gateVoice.fill(1, a, b); keepOpenZones++; }
  }

  // 2) Audience level: smoothed ambient against the room's OWN floor measured
  //    over the WHOLE recording (p10). A rolling floor fails here: during
  //    speech the camera mic is loud (voice bleed + room), so a local p10 is
  //    not "silence" and the gate only opened on the loudest laugh peaks —
  //    measured on the real set, 131 of 228 pauses rose for less than half
  //    the pause.
  const smoothW = H(200);
  const ambSm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - smoothW); j <= Math.min(n - 1, i + smoothW); j++) { s += at(ambDb, j); c++; }
    ambSm[i] = c ? s / c : -90;
  }
  let roomFloor: number;
  if (p.roomFloorDb != null) {
    roomFloor = p.roomFloorDb;
  } else {
    roomFloor = pct(ambDb.length ? ambDb : ambSm, 0.10);
  }

  // 3) Target level per hop, decided PER PAUSE (not per hop): a long pause
  //    either counts as "audience present" and is raised WHOLE, or stays
  //    ducked. Deciding hop-by-hop chopped single laughs into fragments.
  //    A pause qualifies when the audience is above the gate for at least
  //    `MIN_ACTIVE_FRAC` of it; the raise then runs to the last active hop
  //    plus a 1 s tail, so a long dead tail doesn't stay lifted either.
  const MIN_ACTIVE_FRAC = 0.15;
  // A pause is raised only when it contains a real audience EVENT: ONE
  // CONTINUOUS swell clearing `eventBar` over the room floor, lasting at least
  // `AUDIENCE_MIN_EVENT_MS` and carrying `AUDIENCE_MIN_EVENT_DBMS` of area
  // above that bar. The old test ("above the gate for 15 % of the pause") never
  // asked for continuity, so a flicker qualified: measured on the real set, the
  // two spots the user flagged score 370 ms / 628 dB·ms and 240 ms / 524, while
  // the genuine laughs a few seconds either side score 1370 ms / 6665 and
  // 1400 ms / 8235. The bar is clamped so a high `gateDb` is not counted twice.
  const AUDIENCE_EVENT_DB = 6, AUDIENCE_EVENT_MAX_DB = 8;
  const AUDIENCE_MIN_EVENT_MS = 500, AUDIENCE_MIN_EVENT_DBMS = 700;
  const LAUGH_LOOK_MS = 600;
  const eventBar = Math.min(Math.max(p.gateDb, AUDIENCE_EVENT_DB), AUDIENCE_EVENT_MAX_DB);
  const lo = -p.depthDb, hi = p.gapBoostDb;
  const target = new Float32Array(n).fill(lo);
  const minPauseH = H(p.minPauseMs);
  let longGaps = 0, activeGaps = 0, noEventGaps = 0;
  for (const [gs, ge] of runs(voice, 0)) {
    if (ge - gs < minPauseH) continue;
    longGaps++;
    let activeHops = 0, lastActive = -1;
    for (let i = gs; i < ge; i++) {
      if (p.gateDb <= 0 || ambSm[i] - roomFloor >= p.gateDb) activeHops++;
      // The raise ENDS on the last hop with real audience (the event bar), not
      // on the last hop scraping past `gateDb` — with a low gate that trailed
      // the raise over the dead end of the pause.
      if (p.gateDb <= 0 || ambSm[i] - roomFloor >= eventBar) lastActive = i;
    }
    if (p.gateDb > 0 && activeHops / (ge - gs) < MIN_ACTIVE_FRAC) continue;

    // Where does the audience actually START inside this pause?
    let riseStart = gs;
    if (p.gateDb > 0) {
      let evStart = -1, evArea = 0, found = -1;
      for (let i = gs; i <= ge; i++) {
        const over = i < ge ? ambSm[i] - roomFloor - eventBar : -1; // i === ge closes the run
        if (over >= 0) {
          if (evStart < 0) { evStart = i; evArea = 0; }
          evArea += over * hopMs;
        } else if (evStart >= 0) {
          if ((i - evStart) * hopMs >= AUDIENCE_MIN_EVENT_MS && evArea >= AUDIENCE_MIN_EVENT_DBMS) { found = evStart; break; }
          evStart = -1;
        }
      }
      if (found < 0) { noEventGaps++; continue; }
      // The raise begins where the laugh begins, NOT at the start of the pause:
      // lifting the silence in between is exactly what read as "it amplifies
      // and the audience has not even risen". When the laugh comes in right
      // after the phrase the little bit of silence before it is kept raised, so
      // the pre-rise still swells under the last words.
      riseStart = (found - gs) * hopMs <= LAUGH_LOOK_MS ? gs : found;
    }
    activeGaps++;
    const upEnd = Math.min(ge, (lastActive < 0 ? ge : lastActive + H(1000)));
    if (upEnd > riseStart) target.fill(hi, riseStart, upEnd);
  }

  // 3·d) "No raise here" zones from the user: back to the voice level whatever
  //      the gate decided (before the lookahead, so no pre-rise leaks in).
  let noRaiseZones = 0;
  for (const [ms0, ms1] of p.noRaiseRangesMs ?? []) {
    const a = Math.max(0, Math.round(ms0 / hopMs));
    const b = Math.min(n, Math.round(ms1 / hopMs));
    if (b > a) { target.fill(lo, a, b); noRaiseZones++; }
  }

  // 4) Lookahead shifts: a rise that starts at the END of a voice block moves
  //    `preRise` earlier (swell under the last words); a drop that starts at
  //    the START of a voice block moves `anticipate` earlier.
  const shifted = Float32Array.from(target);
  const preRise = H(p.preRiseMs), ant = H(p.anticipateMs);
  const voiceRuns = runs(voice, 1);
  for (const [vs, ve] of voiceRuns) {
    // Rise into the laugh: when the pause right after this phrase qualifies,
    // the raise starts `preRise` BEFORE the voice ends — the laugh swells
    // under the last words instead of jumping in after them.
    if (ve < n && target[ve] === hi) {
      for (let i = Math.max(vs, ve - preRise); i < ve; i++) shifted[i] = hi;
    }
    // Drop before the start of this phrase (wins over any raise tail).
    for (let i = Math.max(0, vs - ant); i < vs; i++) shifted[i] = lo;
  }
  // 4·b) The vetoes once more, on the SHIFTED target. A veto drawn over a
  //      box covers the engine's PERSISTED span, which is the post-shift run —
  //      applied only before the shift, the pre-rise of a neighbouring run or
  //      a drop's rounding could still leave a 100–200 ms sliver of raise
  //      inside the veto, and that sliver came back as its own "+4 dB auto"
  //      box next to the zone that replaced it.
  for (const [ms0, ms1] of p.noRaiseRangesMs ?? []) {
    const a = Math.max(0, Math.round(ms0 / hopMs));
    const b = Math.min(n, Math.round(ms1 / hopMs));
    if (b > a) shifted.fill(lo, a, b);
  }
  // 4·c) A raised run under 50 ms cannot be a decision — it is the rounding
  //      left beside a veto (measured: 30 ms after a taken-over raise) and it
  //      would climb under 1 dB through the release ramp. Drop it, so the
  //      persisted list never shows a box nobody can hear.
  for (let i = 0; i < n;) {
    if (shifted[i] === hi && hi > lo) {
      let j = i;
      while (j < n && shifted[j] === hi) j++;
      if ((j - i) * hopMs < 50) shifted.fill(lo, i, j);
      i = j;
    } else i++;
  }

  // What the engine DECIDED, as ranges (ms, envelope clock): each run at the
  // raised level after the lookahead shifts. Persisted on the part so the
  // editing timeline can show every automatic raise as a zone and the user
  // can veto one with a "no raise" zone over the same span.
  const raiseRangesMs: Array<[number, number]> = [];
  for (let i = 0; i < n;) {
    if (shifted[i] === hi && hi > lo) {
      let j = i;
      while (j < n && shifted[j] === hi) j++;
      raiseRangesMs.push([i * hopMs, j * hopMs]);
      i = j;
    } else i++;
  }

  // 5) Ramps: rate-limit the target — up at (hi−lo)/release per hop, down at
  //    (hi−lo)/attack per hop — so transitions are `release`/`attack` long.
  const span = Math.max(0.001, hi - lo);
  const upStep = span / Math.max(1, H(p.releaseMs));
  const downStep = span / Math.max(1, H(p.attackMs));
  const gainDb = new Float32Array(n);
  let g = shifted.length ? shifted[0] : lo;
  for (let i = 0; i < n; i++) {
    const t = shifted[i];
    if (t > g) g = Math.min(t, g + upStep);
    else if (t < g) g = Math.max(t, g - downStep);
    gainDb[i] = g;
  }
  const voiceFrac = n ? voice.reduce((s, v) => s + v, 0) / n : 0;
  return { gainDb, raiseRangesMs, voice, gateVoice, stats: { voiceFrac, mutedZones, longGaps, activeGaps, noEventGaps, noRaiseZones, shortGapsFilled, roomFloorDb: roomFloor, voiceRule, calibDeltaDb, calibFloorDb, calibLoudDb, calibMesaFloorDb, keepOpenZones } };
}

/**
 * Bake the user's manual LEVEL zones into the ramped curve: inside a zone the
 * level IS the zone's dB over the original ambient (cross-faded over its ramps
 * — linear in dB, like the curve's own ramps), replacing whatever the engine
 * decided there. Zones are on the envelope clock (the caller shifts them).
 * Done here rather than as a `volume` expression on the branch so (a) the
 * zone replaces instead of adding, and (b) the envelope pass that decides the
 * raises never sees the zone — a raised band read as a laugh to the audience
 * gate and re-decided a wider raise around it.
 */
export function applyManualBandsDb(
  gainDb: Float32Array,
  hopMs: number,
  bands: Array<Pick<BoardDuckRegion, 'startMs' | 'endMs' | 'attenuationDb' | 'fadeInMs' | 'fadeOutMs' | 'fadeShape'>>,
): number {
  let applied = 0;
  for (const r of bands) {
    if (!Number.isFinite(r.attenuationDb)) continue;
    const s = Math.min(r.startMs, r.endMs), e = Math.max(r.startMs, r.endMs);
    if (e <= s) continue;
    const fi = r.fadeInMs != null ? Math.max(0, r.fadeInMs) : 30;
    const fo = r.fadeOutMs != null ? Math.max(0, r.fadeOutMs) : 30;
    const a = Math.max(0, Math.floor((s - fi) / hopMs));
    const b = Math.min(gainDb.length, Math.ceil((e + fo) / hopMs) + 1);
    if (b <= a) continue;
    for (let i = a; i < b; i++) {
      const w = bandWeightAt(r, i * hopMs);
      if (w > 0) gainDb[i] = gainDb[i] * (1 - w) + r.attenuationDb * w;
    }
    applied++;
  }
  return applied;
}

/** Run a single-output filter graph over the inputs and return the 10 ms RMS
 *  envelope (dBFS) of the result, decoded at 8 kHz mono s16 through a pipe. */
export async function envelopeOfGraph(inputs: string[], filter: string, hopMs = CURVE_HOP_MS): Promise<Float32Array> {
  const args = ['-v', 'error'];
  for (const i of inputs) args.push('-i', i);
  args.push('-filter_complex', `${filter},aresample=${CURVE_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono[env]`,
    '-map', '[env]', '-f', 's16le', '-');
  const hop = Math.max(1, Math.round((CURVE_SAMPLE_RATE * hopMs) / 1000));
  return new Promise((resolve, reject) => {
    const proc = spawn(getFFmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: number[] = [];
    let carry: Buffer = Buffer.alloc(0);
    let acc = 0, cnt = 0;
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        acc += v * v; cnt++;
        if (cnt === hop) { out.push(20 * Math.log10(Math.sqrt(acc / cnt) + 1e-6)); acc = 0; cnt = 0; }
      }
      carry = buf.subarray(usable);
    });
    proc.stderr.on('data', (d) => { err += String(d); if (err.length > 4096) err = err.slice(-4096); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`envelope ffmpeg exited ${code}: ${err.slice(-300)}`));
      if (cnt > 0) out.push(20 * Math.log10(Math.sqrt(acc / cnt) + 1e-6));
      resolve(Float32Array.from(out));
    });
  });
}

/**
 * The MESA GATE, from the engine's `gateVoice` mask (cross-mic voice OR the
 * mesa follower over its floor, blips removed, short gaps filled): 0 dB while the comic
 * speaks — extended `leadMs` before each onset and `holdMs` after each end so
 * the natural tail of the last word ("…siones") passes at full level —
 * and −depthDb elsewhere, opening over `openMs` and closing over `closeMs`.
 * Applied on the board BEFORE the leveler: with the room pushed 24 dB down,
 * the leveler's knee can sit under the room floor and quiet tails keep the
 * full curve gain instead of collapsing on a steep knee. A static curve
 * cannot separate a word tail (−49…−55 on the compand's scale) from the
 * room between phrases (−54…−61): only time does, and this is offline.
 *
 * Returns the ramped curve AND the runs it decided to close (`closedRangesMs`,
 * read off the pre-ramp `open` mask — the DECISION, exactly like
 * `raiseRangesMs` comes from `shifted` and not from the ramped gain). Those
 * runs are what the timeline draws as read-only boxes so the user can veto
 * one. Runs under 50 ms are dropped: they never reach −depth through the close
 * ramp anyway and would only clutter the track.
 */
export function buildMesaGateDb(
  voice: Uint8Array,
  hopMs: number,
  o: { depthDb: number; holdMs: number; leadMs: number; openMs: number; closeMs: number },
): { gainDb: Float32Array; closedRangesMs: Array<[number, number]> } {
  const n = voice.length;
  const H = (ms: number) => Math.max(1, Math.round(ms / hopMs));
  const hold = H(o.holdMs), lead = H(o.leadMs);
  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!voice[i]) continue;
    const a = Math.max(0, i - lead), b = Math.min(n, i + hold + 1);
    for (let j = a; j < b; j++) open[j] = 1;
  }
  const closedRangesMs: Array<[number, number]> = [];
  for (let i = 0; i < n;) {
    if (!open[i]) {
      let j = i;
      while (j < n && !open[j]) j++;
      if ((j - i) * hopMs >= 50) closedRangesMs.push([i * hopMs, j * hopMs]);
      i = j;
    } else i++;
  }
  const out = new Float32Array(n);
  const upStep = o.depthDb / H(o.openMs), downStep = o.depthDb / H(o.closeMs);
  let g = open.length && open[0] ? 0 : -o.depthDb;
  for (let i = 0; i < n; i++) {
    const target = open[i] ? 0 : -o.depthDb;
    if (target > g) g = Math.min(target, g + upStep);
    else if (target < g) g = Math.max(target, g - downStep);
    out[i] = g;
  }
  return { gainDb: out, closedRangesMs };
}

/** Write the gain curve as a mono s16 wav at 8 kHz, scaled by 1/gainMax so it
 *  fits in [0,1]; the caller re-applies `volume=gainMax` after amultiply.
 *  Padded with the last value to `minDurationSec` so amultiply never runs out
 *  of gain before the ambient ends. */
export async function writeGainCurveWav(gainDb: Float32Array, hopMs: number, outPath: string, minDurationSec: number): Promise<{ gainMax: number }> {
  const sr = CURVE_SAMPLE_RATE;
  let maxLin = 1;
  const lin = new Float32Array(gainDb.length);
  for (let i = 0; i < gainDb.length; i++) { lin[i] = Math.pow(10, gainDb[i] / 20); if (lin[i] > maxLin) maxLin = lin[i]; }
  const gainMax = maxLin;
  const perHop = Math.max(1, Math.round((sr * hopMs) / 1000));
  const nHops = Math.max(gainDb.length, Math.ceil((minDurationSec * 1000) / hopMs) + 1);
  const nSamples = nHops * perHop;
  const data = Buffer.alloc(nSamples * 2);
  const last = lin.length ? lin[lin.length - 1] : 1;
  for (let h = 0; h < nHops; h++) {
    const a = h < lin.length ? lin[h] : last;
    const b = h + 1 < lin.length ? lin[h + 1] : a;
    for (let s = 0; s < perHop; s++) {
      const v = (a + (b - a) * (s / perHop)) / gainMax;
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), (h * perHop + s) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  await fs.writeFile(outPath, Buffer.concat([header, data]));
  return { gainMax };
}
