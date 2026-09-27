#!/usr/bin/env python3
"""
Board (mesa) filler detection.

Finds two kinds of mic filler sounds the comic makes, picked up by the board
microphone, so the editor can attenuate ("duck") them:

  - "je-je": rhythmic chuckle = a train of short bursts. Shows up as the RMS
    envelope OSCILLATING at ~4-10 Hz. Detected by autocorrelation of the
    envelope inside sliding windows.
  - "eehh": a sustained filler = a plateau of roughly constant energy held for
    ~1-3 s. Detected as runs where the envelope stays above a threshold with
    LOW variance (steady, not oscillating).

Also emits the RMS envelope itself so the UI can render the waveform cheaply
(no in-browser decode of a 30-min file).

Usage:
    python3 scripts/detect_board_fillers.py \
        --input  <board.wav> \
        --output <fillers.json> \
        [--hop-ms 25] \
        [--jeje-autocorr 0.35] \
        [--eehh-cv 0.35] \
        [--min-jeje-ms 350] \
        [--min-eehh-ms 800] \
        [--merge-gap-ms 200]

Progress is printed to stderr as JSON lines: {"progress": 0-100, "message": "..."}
Result summary is printed to stdout as one JSON line.
"""

import argparse
import json
import sys
import uuid
import wave
import struct
import numpy as np


def log_progress(progress: int, message: str):
    print(json.dumps({"progress": progress, "message": message}), file=sys.stderr, flush=True)


def read_wav(path: str):
    """Read a WAV file → (mono float64 samples in [-1,1], sample_rate)."""
    with wave.open(path, 'r') as wf:
        n_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sample_width == 2:
        samples = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768.0
    elif sample_width == 4:
        samples = np.frombuffer(raw, dtype='<i4').astype(np.float64) / 2147483648.0
    elif sample_width == 1:
        samples = (np.frombuffer(raw, dtype='u1').astype(np.float64) - 128.0) / 128.0
    else:
        raise ValueError(f"Unsupported sample width: {sample_width}")

    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return samples, sample_rate


def rms_envelope(samples: np.ndarray, sample_rate: int, hop_ms: float):
    """Non-overlapping RMS envelope at the given hop. Returns float32 array."""
    hop = max(1, int(sample_rate * hop_ms / 1000))
    n = len(samples) // hop
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    trimmed = samples[: n * hop].reshape(n, hop)
    env = np.sqrt(np.mean(trimmed ** 2, axis=1))
    return env.astype(np.float32)


def merge_regions(regions, merge_gap_ms, min_dur_ms):
    """Merge same-type regions closer than merge_gap_ms, drop short ones."""
    if not regions:
        return []
    regions = sorted(regions, key=lambda r: r["start_ms"])
    merged = [dict(regions[0])]
    for r in regions[1:]:
        last = merged[-1]
        if r["type"] == last["type"] and r["start_ms"] - last["end_ms"] <= merge_gap_ms:
            last["end_ms"] = max(last["end_ms"], r["end_ms"])
            last["confidence"] = max(last["confidence"], r["confidence"])
        else:
            merged.append(dict(r))
    return [r for r in merged if r["end_ms"] - r["start_ms"] >= min_dur_ms]


def _find_peaks(env, floor):
    """Local maxima in the envelope above `floor` (index array)."""
    if len(env) < 3:
        return np.zeros(0, dtype=int)
    up = env[1:-1] >= env[:-2]
    down = env[1:-1] > env[2:]
    peaks = np.where(up & down & (env[1:-1] > floor))[0] + 1
    return peaks


def detect_jeje(env, hop_ms, silence, min_pulses, interval_cv, depth_ratio):
    """Chuckle-train detection.

    A "je je je je" is a train of near-identical short bursts, distinct from
    normal (rhythmic-ish) speech by being MORE regular and deeply modulated.
    Detected structurally rather than by raw envelope autocorrelation (which
    also fires on syllabic speech at 4-7 Hz):
      1. peak-pick the envelope,
      2. take runs of consecutive peaks whose inter-peak interval is 90-260 ms
         (~4-11 Hz),
      3. keep a run only if it has >= min_pulses peaks, the intervals are
         REGULAR (coeff. of variation <= interval_cv), and the valleys between
         peaks are DEEP (valley <= depth_ratio * neighbouring peak) — i.e. a
         clean pulse train, not continuous speech.
    """
    hop_s = hop_ms / 1000.0
    floor = silence * 1.3
    peaks = _find_peaks(env, floor)
    if len(peaks) < min_pulses:
        return []
    min_int = 0.090 / hop_s   # 11 Hz
    max_int = 0.260 / hop_s   # ~3.8 Hz
    regions = []

    # Sweep peaks, growing runs where consecutive intervals stay in-band.
    i = 0
    npk = len(peaks)
    while i < npk - 1:
        run = [peaks[i]]
        j = i
        while j + 1 < npk:
            d = peaks[j + 1] - peaks[j]
            if min_int <= d <= max_int:
                run.append(peaks[j + 1])
                j += 1
            else:
                break
        if len(run) >= min_pulses:
            run = np.array(run)
            intervals = np.diff(run).astype(np.float64)
            cv = intervals.std() / intervals.mean() if intervals.mean() > 0 else 1.0
            # Modulation depth: valley between each adjacent peak pair vs the
            # smaller of the two peaks. Deep valleys → a real pulse train.
            deep = 0
            for k in range(len(run) - 1):
                valley = env[run[k]:run[k + 1] + 1].min()
                ref = min(env[run[k]], env[run[k + 1]])
                if ref > 0 and valley <= depth_ratio * ref:
                    deep += 1
            depth_frac = deep / (len(run) - 1)
            if cv <= interval_cv and depth_frac >= 0.6:
                # Confidence: regular + deep + many pulses.
                conf = (1.0 - cv / interval_cv) * 0.5 + depth_frac * 0.3 + min(1.0, len(run) / 8.0) * 0.2
                regions.append({
                    "start_ms": int(run[0] * hop_ms),
                    "end_ms": int(run[-1] * hop_ms),
                    "type": "jeje",
                    "confidence": round(float(min(1.0, conf)), 3),
                })
        i = j + 1 if j > i else i + 1
    return regions


# ─────────────────────────────────────────────────────────────────────────
# je-je v2 — burst-train detector on a 10 ms dB envelope with LOCAL context.
#
# Measured on the user's real mesa (9 confirmed chuckles): bursts 10–90 ms
# long, every 150–350 ms (3–5.5 Hz, very regular), 2–13 per train, peaks
# 5–20 dB BELOW the nearby speech (though a chuckle can match the loudest
# nearby phrase when the surroundings are quiet), valleys 15–25 dB deep,
# and they sit in GAPS between phrases. detect_jeje() missed most of them:
# it wanted ≥6 pulses at 90–260 ms on a 25 ms RMS envelope that smears a
# 30 ms burst. This one works at 10 ms, uses rolling percentiles for "how
# loud is speech here" / "how quiet is the room here", and scores trains
# by pulse count, regularity, valley depth and level-below-speech.
# ─────────────────────────────────────────────────────────────────────────

def db_envelope(samples, sr, hop_ms):
    hop = max(1, int(sr * hop_ms / 1000))
    n = len(samples) // hop
    if n <= 0:
        return np.zeros(0, dtype=np.float64), hop
    env = np.sqrt(np.mean(samples[: n * hop].reshape(n, hop) ** 2, axis=1))
    return 20.0 * np.log10(env + 1e-6), hop


def rolling_percentiles(db, hop_ms, ctx_sec=3.0, block_ms=250.0, hi=95, lo=10):
    """Per-frame (hi, lo) percentiles of db over ±ctx_sec, computed on a
    coarse block grid and interpolated (a 24-min set at 10 ms is ~146k
    frames; a per-frame sliding percentile would need ~700 MB)."""
    n = len(db)
    if n == 0:
        return db, db
    blk = max(1, int(round(block_ms / hop_ms)))
    half = max(blk, int(round(ctx_sec * 1000 / hop_ms)))
    centers = np.arange(blk // 2, n, blk)
    his = np.empty(len(centers)); los = np.empty(len(centers))
    for k, c in enumerate(centers):
        seg = db[max(0, c - half): min(n, c + half + 1)]
        his[k] = np.percentile(seg, hi)
        los[k] = np.percentile(seg, lo)
    idx = np.arange(n)
    return np.interp(idx, centers, his), np.interp(idx, centers, los)


def find_bursts(db, hop_ms, floor, min_above_floor_db, min_ms, max_ms, merge_ms=60.0):
    """Short local maxima: index, peak dB, width at −6 dB (ms). Peaks closer
    than merge_ms collapse into the louder one (a double-peaked burst)."""
    n = len(db)
    if n < 3:
        return []
    up = db[1:-1] >= db[:-2]
    down = db[1:-1] > db[2:]
    cand = np.where(up & down & (db[1:-1] >= floor[1:-1] + min_above_floor_db))[0] + 1
    out = []
    for i in cand:
        pk = db[i]
        thr = pk - 6.0
        a = i
        while a > 0 and db[a - 1] >= thr:
            a -= 1
        b = i
        while b < n - 1 and db[b + 1] >= thr:
            b += 1
        width = (b - a + 1) * hop_ms
        if min_ms <= width <= max_ms:
            out.append((int(i), float(pk), float(width), int(a), int(b)))
    # merge near-duplicates
    merged = []
    mg = merge_ms / hop_ms
    for c in out:
        if merged and c[0] - merged[-1][0] <= mg:
            if c[1] > merged[-1][1]:
                merged[-1] = c
        else:
            merged.append(c)
    return merged


def detect_jeje_v2(samples, sr, hop_ms=10.0, min_pulses=2, min_period_ms=165.0,
                   max_period_ms=400.0, interval_cv=0.45, valley_db=8.0,
                   burst_above_floor_db=8.0, min_burst_ms=10.0, max_burst_ms=200.0,
                   max_median_width_ms=100.0, max_duty=0.5, max_valley_above_floor_db=12.0,
                   gap_below_speech_db=14.0, min_below_speech_db=-6.0,
                   ctx_sec=3.0, speech_ctx_sec=8.0, pad_ms=50.0,
                   min_conf=0.30, allow_two=True):
    """Gates derived from the user's confirmed chuckles on TWO nights (9 on
    29-ago, 83 on 30-ago — p03/p97 of the positives' own trains):
      · period ≥ 165 ms (syllable trains run faster, 135–180),
      · valleys ≤ +12 dB above the room floor (speech valleys sit higher),
      · the region median ≥ 14 dB under the local speech level (a gap),
      · peaks may be up to 6 dB ABOVE the local speech level (the 30-ago
        chuckles were as loud as the phrases — the old "≥ 2 dB under"
        gate rejected 34 of 74 reachable positives),
      · bursts ≤ 100 ms wide with duty ≤ 0.5, regular (cv ≤ 0.45).
    Envelope features cannot separate real chuckles from other pulse trains
    beyond this, so the rest is ranked by confidence and left to the ✓/✗
    review — and "Buscar parecidos" re-calibrates per recording."""
    db, hop = db_envelope(samples, sr, hop_ms)
    if len(db) < 10:
        return []
    # Speech reference over a LONG window (a chuckle inside a long gap must
    # not become its own reference); room floor over a short one.
    speech, _ = rolling_percentiles(db, hop_ms, ctx_sec=speech_ctx_sec)
    _, floor = rolling_percentiles(db, hop_ms, ctx_sec=ctx_sec)
    bursts = find_bursts(db, hop_ms, floor, burst_above_floor_db, min_burst_ms, max_burst_ms)
    if len(bursts) < 2:
        return []
    lo_i = min_period_ms / hop_ms
    hi_i = max_period_ms / hop_ms
    regions = []
    i = 0
    nb = len(bursts)
    while i < nb - 1:
        run = [bursts[i]]
        j = i
        while j + 1 < nb:
            d = bursts[j + 1][0] - bursts[j][0]
            if lo_i <= d <= hi_i:
                run.append(bursts[j + 1]); j += 1
            else:
                break
        npulse = len(run)
        if npulse >= 2 and (npulse >= min_pulses or allow_two):
            idxs = np.array([r[0] for r in run])
            intervals = np.diff(idxs).astype(np.float64) * hop_ms
            cv = float(intervals.std() / intervals.mean()) if len(intervals) > 1 and intervals.mean() > 0 else 0.0
            depths = []
            valleys = []
            for k in range(npulse - 1):
                valley = db[run[k][0]: run[k + 1][0] + 1].min()
                valleys.append(valley)
                depths.append(min(run[k][1], run[k + 1][1]) - valley)
            depth_ok = float(np.mean([d >= valley_db for d in depths]))
            mean_depth = float(np.mean(depths))
            a = max(0, run[0][3] - int(pad_ms / hop_ms))
            b = min(len(db) - 1, run[-1][4] + int(pad_ms / hop_ms))
            reg_med = float(np.median(db[a:b + 1]))
            sp = float(np.median(speech[a:b + 1]))
            fl = float(np.median(floor[a:b + 1]))
            peak = max(r[1] for r in run)
            below = sp - peak
            valley_above_floor = float(np.mean(valleys)) - fl
            in_gap = (reg_med <= sp - gap_below_speech_db) and (below >= min_below_speech_db)
            regular = cv <= interval_cv
            # Syllables are wide and dense and their valleys stay well above
            # the room floor; chuckle bursts are narrow puffs whose valleys
            # drop back to the floor — that is what separates "je-je-je" from
            # "y-en-ton-ces" in the measured data.
            med_width = float(np.median([r[2] for r in run]))
            duty = med_width / max(1.0, float(intervals.mean()))
            shape_ok = (med_width <= max_median_width_ms and duty <= max_duty
                        and valley_above_floor <= max_valley_above_floor_db)
            if depth_ok >= 0.6 and in_gap and regular and shape_ok:
                conf = (0.30 * min(1.0, max(0.0, below) / 15.0)
                        + 0.20 * min(1.0, max(0.0, -(reg_med - sp) - gap_below_speech_db) / 12.0)
                        + 0.20 * max(0.0, 1.0 - max(0.0, valley_above_floor) / max_valley_above_floor_db)
                        + 0.15 * min(1.0, (npulse - 1) / 4.0)
                        + 0.15 * max(0.0, 1.0 - cv / interval_cv))
                if npulse == 2:
                    conf = min(conf, 0.5)
                if conf >= min_conf:
                    regions.append({
                        "start_ms": int(a * hop_ms),
                        "end_ms": int((b + 1) * hop_ms),
                        "type": "jeje",
                        "confidence": round(float(min(1.0, conf)), 3),
                        "pulses": int(npulse),
                        "period_ms": round(float(intervals.mean()), 1),
                        "level_below_ctx_db": round(float(below), 1),
                        # internal descriptors for the example-based calibration
                        # (underscore keys never reach the output JSON)
                        "_width": med_width, "_duty": duty, "_valley_floor": valley_above_floor,
                        "_regmed": reg_med - sp, "_cv": cv,
                    })
        i = j + 1 if j > i else i + 1
    return regions


def merge_v2(regions, merge_gap_ms=250):
    """Merge overlapping/near trains, keeping the best descriptors."""
    if not regions:
        return []
    regions = sorted(regions, key=lambda r: r["start_ms"])
    out = [dict(regions[0])]
    for r in regions[1:]:
        last = out[-1]
        if r["start_ms"] - last["end_ms"] <= merge_gap_ms:
            last["end_ms"] = max(last["end_ms"], r["end_ms"])
            last["confidence"] = max(last["confidence"], r["confidence"])
            last["pulses"] = last.get("pulses", 0) + r.get("pulses", 0)
            last["period_ms"] = round((last.get("period_ms", 0) + r.get("period_ms", 0)) / 2, 1)
            last["level_below_ctx_db"] = max(last.get("level_below_ctx_db", 0), r.get("level_below_ctx_db", 0))
        else:
            out.append(dict(r))
    return out


def detect_eehh(env, hop_ms, energy_thresh, cv_thresh):
    """Sustained-plateau detection: above threshold with low coeff. of variation."""
    hop_s = hop_ms / 1000.0
    win = max(6, int(round(0.6 / hop_s)))        # ~0.6 s window for local stats
    step = max(1, int(round(0.10 / hop_s)))
    regions = []
    i = 0
    n = len(env)
    while i + win <= n:
        seg = env[i:i + win].astype(np.float64)
        m = seg.mean()
        if m > energy_thresh:
            cv = seg.std() / m if m > 0 else 1.0
            if cv <= cv_thresh:
                regions.append({
                    "start_ms": int(i * hop_ms),
                    "end_ms": int((i + win) * hop_ms),
                    "type": "eehh",
                    "confidence": round(float(max(0.0, 1.0 - cv / cv_thresh)), 3),
                })
        i += step
    return regions


def subtract_overlap(eehh_regions, jeje_regions):
    """Drop eehh regions that mostly overlap a jeje region (je-je wins — it
    oscillates, so it's not a steady plateau even if the mean is high)."""
    if not jeje_regions:
        return eehh_regions
    out = []
    for r in eehh_regions:
        dur = max(1, r["end_ms"] - r["start_ms"])
        overlap = 0
        for j in jeje_regions:
            lo = max(r["start_ms"], j["start_ms"])
            hi = min(r["end_ms"], j["end_ms"])
            if hi > lo:
                overlap += hi - lo
        if overlap / dur < 0.5:
            out.append(r)
    return out


# ─────────────────────────────────────────────────────────────────────────
# Example-based ("teach the detector") second search.
#
# The user marks real fillers (positives = enabled regions) and rejects wrong
# proposals (negatives = disabled regions). We describe each region with a small
# feature vector, generate a loose superset of candidates, and keep the ones that
# look like a positive AND unlike every negative (nearest-prototype in z-scored
# feature space). This directly leverages the negatives — usually normal speech
# the heuristic misfired on — to resolve the je-je-vs-speech ambiguity.
# ─────────────────────────────────────────────────────────────────────────

def region_features(env, hop_ms, samples, sr, s_ms, e_ms, env_median):
    """8-dim descriptor of a [s_ms, e_ms] window. None if too short/empty."""
    hop_s = hop_ms / 1000.0
    i0 = max(0, int(s_ms / hop_ms)); i1 = min(len(env), int(e_ms / hop_ms))
    seg = env[i0:i1].astype(np.float64)
    if len(seg) < 3 or seg.mean() <= 0:
        return None
    dur = (e_ms - s_ms) / 1000.0
    m = seg.mean()
    lvl = m / max(1e-9, env_median)
    cv = seg.std() / m
    # Envelope modulation spectrum (how "pulsey" and at what rate).
    x = seg - m
    n = len(x)
    modf, mods = 0.0, 0.0
    if n >= 8:
        sp = np.abs(np.fft.rfft(x * np.hanning(n)))
        freqs = np.fft.rfftfreq(n, d=hop_s)
        band = (freqs >= 2) & (freqs <= 14)
        if band.any() and sp[band].sum() > 0:
            modf = float(freqs[band][int(np.argmax(sp[band]))])
            mods = float(sp[band].max() / (sp.mean() + 1e-9))
    # Modulation depth from envelope peaks.
    peaks = _find_peaks(seg, m * 0.8)
    depth = 1.0
    if len(peaks) >= 2:
        ds = []
        for k in range(len(peaks) - 1):
            valley = seg[peaks[k]:peaks[k + 1] + 1].min()
            ref = min(seg[peaks[k]], seg[peaks[k + 1]])
            ds.append(valley / ref if ref > 0 else 1.0)
        depth = float(np.median(ds))
    # Spectral centroid + ZCR from the raw samples (timbre).
    a0 = max(0, int(s_ms / 1000.0 * sr)); a1 = min(len(samples), int(e_ms / 1000.0 * sr))
    sig = samples[a0:a1]
    cent, zcr = 0.0, 0.0
    if len(sig) >= 256:
        w = sig * np.hanning(len(sig))
        S = np.abs(np.fft.rfft(w))
        f = np.fft.rfftfreq(len(sig), d=1.0 / sr)
        if S.sum() > 0:
            cent = float((f * S).sum() / S.sum())
        zcr = float(np.mean(np.abs(np.diff(np.sign(sig))) > 0))
    return np.array([dur, lvl, cv, modf, mods, depth, cent, zcr], dtype=np.float64)


def _dedup_overlap(regions):
    """Keep the best (lowest dpos) among overlapping candidate regions."""
    regions = sorted(regions, key=lambda r: r.get("dpos", 0.0))
    kept = []
    for r in regions:
        if any(min(r["end_ms"], k["end_ms"]) - max(r["start_ms"], k["start_ms"]) > 0 for k in kept):
            continue
        kept.append(r)
    return sorted(kept, key=lambda r: r["start_ms"])


V2_DESC_KEYS = ("period_ms", "_width", "_duty", "_valley_floor", "_regmed", "level_below_ctx_db", "_cv")


def _desc_vec(c):
    return np.array([float(c.get(k, 0.0)) for k in V2_DESC_KEYS], dtype=np.float64)


def _best_train_in(cands, s_ms, e_ms):
    """The loose candidate overlapping [s,e] the most (None if none)."""
    best, bo = None, 0
    for c in cands:
        o = min(e_ms, c["end_ms"]) - max(s_ms, c["start_ms"])
        if o > bo:
            best, bo = c, o
    return best


def learn_search(env, hop_ms, samples, sr, silence, energy_thresh, env_median,
                 positives, negatives, threshold, max_regions):
    """Example-based search ("Buscar parecidos").

    je-je: CALIBRATE the v2 detector's gates from the confirmed examples —
    every gate is widened just enough to admit all positives' own trains (so
    a positive is always re-found) — then run the loose v2 superset through
    those gates and drop any candidate whose descriptor vector is closer to
    a rejected (✗) example than to a confirmed (✓) one. Works in the SAME
    descriptor space the detector uses (period, width, duty, valley-above-
    floor, region-below-speech, peak-below-speech, regularity).

    eehh: unchanged nearest-prototype search on the plateau candidates."""
    out = []

    # ── je-je ──────────────────────────────────────────────────────────────
    loose = merge_v2(detect_jeje_v2(
        samples, sr, min_period_ms=140.0, interval_cv=0.6, valley_db=4.0,
        max_median_width_ms=120.0, max_duty=0.7, max_valley_above_floor_db=12.0,
        gap_below_speech_db=8.0, min_below_speech_db=-3.0, min_conf=0.0,
    ), 250)
    jpos = [p for p in positives if p.get("type", "jeje") == "jeje"]
    pos_tr = [t for t in (_best_train_in(loose, p["start_ms"], p["end_ms"]) for p in jpos) if t]
    neg_tr = [t for t in (_best_train_in(loose, n["start_ms"], n["end_ms"]) for n in negatives) if t]
    if pos_tr:
        P = np.array([_desc_vec(t) for t in pos_tr])
        # Gates widened by a margin around the positives' own range.
        g_period = P[:, 0].min() - 20
        g_width = P[:, 1].max() + 10
        g_duty = P[:, 2].max() + 0.05
        g_vfloor = P[:, 3].max() + 2
        g_regmed = P[:, 4].max() + 3
        g_below = P[:, 5].min() - 2
        g_cv = P[:, 6].max() + 0.1
        N = np.array([_desc_vec(t) for t in neg_tr]) if neg_tr else None
        allv = np.array([_desc_vec(t) for t in loose] + [v for v in P] + ([v for v in N] if N is not None else []))
        mu = allv.mean(axis=0); sd = allv.std(axis=0); sd[sd < 1e-9] = 1.0
        zP = (P - mu) / sd
        zN = (N - mu) / sd if N is not None else None
        pos_keys = {(t["start_ms"], t["end_ms"]) for t in pos_tr}
        for c in loose:
            v = _desc_vec(c)
            key = (c["start_ms"], c["end_ms"])
            passes = (v[0] >= g_period and v[1] <= g_width and v[2] <= g_duty and v[3] <= g_vfloor
                      and v[4] <= g_regmed and v[5] >= g_below and v[6] <= g_cv)
            if not passes and key not in pos_keys:
                continue
            z = (v - mu) / sd
            dpos = float(np.min(np.linalg.norm(zP - z, axis=1)))
            dneg = float(np.min(np.linalg.norm(zN - z, axis=1))) if zN is not None else 1e9
            if key not in pos_keys and dneg <= dpos:
                continue  # looks more like something the user rejected
            conf = 1.0 if key in pos_keys else max(0.0, 1.0 - dpos / max(threshold, 1e-6))
            r = {"start_ms": int(c["start_ms"]), "end_ms": int(c["end_ms"]), "type": "jeje",
                 "confidence": round(float(min(1.0, conf)), 3), "dpos": dpos}
            for k in ("pulses", "period_ms", "level_below_ctx_db"):
                if k in c:
                    r[k] = c[k]
            out.append(r)

    # ── eehh (legacy nearest-prototype on the old 8-dim features) ──────────
    epos = [p for p in positives if p.get("type") == "eehh"]
    if epos:
        feat = lambda s, e: region_features(env, hop_ms, samples, sr, s, e, env_median)
        pf = [f for f in (feat(p["start_ms"], p["end_ms"]) for p in epos) if f is not None]
        nf = [f for f in (feat(n["start_ms"], n["end_ms"]) for n in negatives) if f is not None]
        ce = merge_regions(detect_eehh(env, hop_ms, silence, 0.55), 200, 500)
        cf = [(f, c) for f, c in ((feat(c["start_ms"], c["end_ms"]), c) for c in ce) if f is not None]
        if pf and cf:
            allf = np.array(pf + nf + [f for f, _ in cf])
            mu = allf.mean(axis=0); sd = allf.std(axis=0); sd[sd < 1e-9] = 1.0
            zp = [(f - mu) / sd for f in pf]
            zn = [(f - mu) / sd for f in nf]
            for f, c in cf:
                zf = (f - mu) / sd
                dpos = min(float(np.linalg.norm(zf - z)) for z in zp)
                dneg = min((float(np.linalg.norm(zf - z)) for z in zn), default=1e9)
                if dpos < dneg and dpos <= threshold:
                    out.append({"start_ms": int(c["start_ms"]), "end_ms": int(c["end_ms"]), "type": "eehh",
                                "confidence": round(max(0.0, 1.0 - dpos / threshold), 3), "dpos": dpos})

    # Cap by SIMILARITY (dpos), not by time — the old `[:max_regions]` after
    # the time-sorted dedup kept the first N seconds of the file and dropped
    # the user's own examples further in.
    out = sorted(_dedup_overlap(out), key=lambda r: r.get("dpos", 0.0))[:max_regions]
    out.sort(key=lambda r: r["start_ms"])
    for r in out:
        r.pop("dpos", None)
        r["id"] = str(uuid.uuid4())[:8]
    return out


def main():
    p = argparse.ArgumentParser(description="Board filler (je-je / eehh) detection")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--hop-ms", type=float, default=25.0)
    # Chuckle "je-je" vs normal speech is genuinely ambiguous from the envelope
    # alone (both have deep syllabic pulse trains at 4-8 Hz), so the defaults are
    # deliberately CONSERVATIVE: propose few, strong candidates. The user tunes
    # via the UI and confirms each. Loosen these for more (noisier) proposals.
    p.add_argument("--jeje-min-pulses", type=int, default=6,
                   help="min consecutive in-band pulses to flag a chuckle train")
    p.add_argument("--jeje-interval-cv", type=float, default=0.22,
                   help="max coeff. of variation of inter-pulse intervals (regularity)")
    p.add_argument("--jeje-depth", type=float, default=0.5,
                   help="valley must be <= this * neighbouring peak (modulation depth)")
    p.add_argument("--jeje-min-conf", type=float, default=0.30,
                   help="drop je-je proposals below this confidence")
    # v2 burst-train detector (default). --jeje-v1 restores the old one.
    p.add_argument("--jeje-v1", action="store_true", help="use the legacy autocorrelation-style detector")
    p.add_argument("--v2-min-pulses", type=int, default=2)
    p.add_argument("--v2-min-period-ms", type=float, default=165.0)
    p.add_argument("--v2-max-period-ms", type=float, default=400.0)
    p.add_argument("--v2-interval-cv", type=float, default=0.45)
    p.add_argument("--v2-valley-db", type=float, default=6.0)
    p.add_argument("--v2-max-width-ms", type=float, default=100.0,
                   help="median burst width at -6 dB must be at most this (syllables are wider)")
    p.add_argument("--v2-max-duty", type=float, default=0.5,
                   help="median width / period must be at most this (chuckles are sparse puffs)")
    p.add_argument("--v2-max-valley-floor-db", type=float, default=12.0,
                   help="mean valley level may sit at most this many dB above the room floor")
    p.add_argument("--v2-gap-below-db", type=float, default=14.0,
                   help="region median must sit this many dB under the local speech level")
    p.add_argument("--v2-min-below-db", type=float, default=-6.0,
                   help="peak must sit at least this many dB under the local speech level (negative = may exceed it)")
    p.add_argument("--v2-no-pairs", action="store_true", help="never propose 2-pulse trains")
    p.add_argument("--eehh-cv", type=float, default=0.3,
                   help="max coefficient of variation to flag a sustained plateau")
    p.add_argument("--eehh-min-conf", type=float, default=0.4,
                   help="drop eehh proposals below this confidence")
    p.add_argument("--min-jeje-ms", type=float, default=700)
    p.add_argument("--min-eehh-ms", type=float, default=900)
    p.add_argument("--merge-gap-ms", type=float, default=200)
    p.add_argument("--display-max-points", type=int, default=80000,
                   help="cap the emitted envelope length (decimated for display)")
    # "Teach the detector": JSON file {positives:[{start_ms,end_ms,type}],
    # negatives:[{start_ms,end_ms}]}. When present, run the example-based search
    # instead of the heuristic pass.
    p.add_argument("--examples", default=None)
    p.add_argument("--learn-threshold", type=float, default=2.5,
                   help="max z-distance to a positive example to accept a candidate")
    p.add_argument("--learn-max", type=int, default=120)
    args = p.parse_args()

    log_progress(5, "Leyendo audio de mesa...")
    samples, sr = read_wav(args.input)
    duration_s = len(samples) / sr if sr else 0.0

    log_progress(25, "Calculando envolvente...")
    env = rms_envelope(samples, sr, args.hop_ms)
    if len(env) == 0:
        result = {"envelope": [], "hop_ms": args.hop_ms, "duration_s": duration_s,
                  "sample_rate": sr, "regions": []}
        with open(args.output, "w") as f:
            json.dump(result, f)
        print(json.dumps({"regions": 0}))
        return

    # Robust references from the envelope distribution.
    median = float(np.median(env))
    p90 = float(np.percentile(env, 90))
    silence = max(1e-4, median * 1.2)             # rough voice-activity floor
    energy_thresh = max(silence, median + 0.4 * (p90 - median))  # "loud enough" for eehh

    examples = None
    if args.examples:
        try:
            with open(args.examples) as f:
                examples = json.load(f)
        except Exception:
            examples = None

    if examples and examples.get("positives"):
        log_progress(50, "Buscando patrones parecidos a tus ejemplos...")
        found = learn_search(
            env, args.hop_ms, samples, sr, silence, energy_thresh, median,
            examples.get("positives", []), examples.get("negatives", []),
            args.learn_threshold, args.learn_max,
        )
        regions = sorted(found, key=lambda r: r["start_ms"])
    else:
        log_progress(50, "Detectando risas de micro (je-je)...")
        if args.jeje_v1:
            jeje = detect_jeje(env, args.hop_ms, silence, args.jeje_min_pulses,
                               args.jeje_interval_cv, args.jeje_depth)
            jeje = merge_regions(jeje, args.merge_gap_ms, args.min_jeje_ms)
        else:
            jeje = merge_v2(detect_jeje_v2(
                samples, sr, hop_ms=10.0, min_pulses=args.v2_min_pulses,
                min_period_ms=args.v2_min_period_ms, max_period_ms=args.v2_max_period_ms,
                interval_cv=args.v2_interval_cv, valley_db=args.v2_valley_db,
                max_median_width_ms=args.v2_max_width_ms, max_duty=args.v2_max_duty,
                max_valley_above_floor_db=args.v2_max_valley_floor_db,
                gap_below_speech_db=args.v2_gap_below_db, min_below_speech_db=args.v2_min_below_db,
                min_conf=args.jeje_min_conf,
                allow_two=not args.v2_no_pairs,
            ), args.merge_gap_ms)

        log_progress(70, "Detectando rellenos sostenidos (eehh)...")
        eehh = detect_eehh(env, args.hop_ms, energy_thresh, args.eehh_cv)
        eehh = merge_regions(eehh, args.merge_gap_ms, args.min_eehh_ms)
        eehh = subtract_overlap(eehh, jeje)

        # Confidence gating — auto je-je/eehh classification is fuzzy, so only surface
        # the stronger candidates as proposals (the user confirms/adds the rest).
        jeje = [r for r in jeje if r["confidence"] >= args.jeje_min_conf]
        eehh = [r for r in eehh if r["confidence"] >= args.eehh_min_conf]

        regions = []
        for r in jeje + eehh:
            entry = {
                "id": str(uuid.uuid4())[:8],
                "start_ms": int(r["start_ms"]),
                "end_ms": int(r["end_ms"]),
                "type": r["type"],
                "confidence": r["confidence"],
            }
            # v2 descriptors (optional — the UI shows them as "why").
            for k in ("pulses", "period_ms", "level_below_ctx_db"):
                if k in r:
                    entry[k] = r[k]
            regions.append(entry)
        regions.sort(key=lambda r: r["start_ms"])

    # Decimate the envelope for display if huge (keeps the JSON small). The
    # effective hop grows by the decimation factor so time mapping stays correct.
    log_progress(88, "Preparando envolvente para la UI...")
    disp = env
    disp_hop = args.hop_ms
    if len(env) > args.display_max_points:
        factor = int(np.ceil(len(env) / args.display_max_points))
        n = (len(env) // factor) * factor
        disp = env[:n].reshape(-1, factor).max(axis=1)  # peak-decimate (keeps transients)
        disp_hop = args.hop_ms * factor

    result = {
        "envelope": [round(float(v), 4) for v in disp],
        "hop_ms": disp_hop,
        "duration_s": round(duration_s, 3),
        "sample_rate": sr,
        "regions": regions,
    }
    with open(args.output, "w") as f:
        json.dump(result, f)

    log_progress(100, f"{len(regions)} zona(s) detectada(s)")
    print(json.dumps({"regions": len(regions),
                      "jeje": sum(1 for r in regions if r["type"] == "jeje"),
                      "eehh": sum(1 for r in regions if r["type"] == "eehh")}))


if __name__ == "__main__":
    main()
