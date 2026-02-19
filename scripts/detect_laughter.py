#!/usr/bin/env python3
"""
Laughter/applause detection by energy analysis on the ambient track.

Analyzes the ambient audio (output from voice subtraction) and detects
segments with high energy that likely correspond to audience reactions
(laughter, applause, cheering).

Usage:
    python3 scripts/detect_laughter.py \
        --input <ambient.wav> \
        --output <laughter_segments.json> \
        [--threshold 2.0] \
        [--min-duration 0.3] \
        [--merge-gap 0.5] \
        [--window-ms 50]

Progress is printed to stderr as JSON lines: {"progress": 0-100, "message": "..."}
"""

import argparse
import json
import sys
import numpy as np
import wave
import struct
import uuid


def log_progress(progress: int, message: str):
    """Print progress as JSON to stderr for the Node.js worker to parse."""
    print(json.dumps({"progress": progress, "message": message}), file=sys.stderr, flush=True)


def read_wav(path: str) -> tuple:
    """Read a WAV file and return (samples as float64 array, sample_rate)."""
    with wave.open(path, 'r') as wf:
        n_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sample_width == 2:
        fmt = f"<{n_frames * n_channels}h"
        samples = np.array(struct.unpack(fmt, raw), dtype=np.float64) / 32768.0
    elif sample_width == 4:
        fmt = f"<{n_frames * n_channels}i"
        samples = np.array(struct.unpack(fmt, raw), dtype=np.float64) / 2147483648.0
    elif sample_width == 1:
        samples = np.array(list(raw), dtype=np.float64) / 128.0 - 1.0
    else:
        raise ValueError(f"Unsupported sample width: {sample_width}")

    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)

    return samples, sample_rate


def compute_energy_envelope(samples: np.ndarray, sample_rate: int,
                            window_ms: float = 50) -> tuple:
    """
    Compute energy envelope using a sliding window.
    Returns (energy_per_frame, frame_times_ms).
    """
    window_samples = int(sample_rate * window_ms / 1000)
    hop_samples = window_samples // 2

    n_frames = (len(samples) - window_samples) // hop_samples + 1
    if n_frames <= 0:
        return np.array([]), np.array([])

    energy = np.zeros(n_frames)
    times = np.zeros(n_frames)

    for i in range(n_frames):
        start = i * hop_samples
        frame = samples[start:start + window_samples]
        energy[i] = np.sqrt(np.mean(frame ** 2))  # RMS energy
        times[i] = (start + window_samples / 2) / sample_rate * 1000  # center time in ms

    return energy, times


def detect_segments(energy: np.ndarray, times_ms: np.ndarray,
                    threshold_factor: float = 2.0,
                    min_duration_ms: float = 300,
                    merge_gap_ms: float = 500) -> list:
    """
    Detect high-energy segments above threshold.

    Args:
        energy: RMS energy per frame
        times_ms: Time of each frame in ms
        threshold_factor: Multiplier over median energy to trigger detection
        min_duration_ms: Minimum segment duration to keep
        merge_gap_ms: Merge segments closer than this gap

    Returns:
        List of dicts with startMs, endMs, peakEnergy, avgEnergy
    """
    if len(energy) == 0:
        return []

    # Compute threshold as factor * median energy
    median_energy = np.median(energy)
    threshold = threshold_factor * median_energy

    # Find frames above threshold
    above = energy > threshold

    # Extract contiguous segments
    raw_segments = []
    in_segment = False
    seg_start = 0

    for i in range(len(above)):
        if above[i] and not in_segment:
            in_segment = True
            seg_start = i
        elif not above[i] and in_segment:
            in_segment = False
            raw_segments.append((seg_start, i - 1))

    if in_segment:
        raw_segments.append((seg_start, len(above) - 1))

    # Merge close segments
    merged = []
    for start_idx, end_idx in raw_segments:
        start_ms = times_ms[start_idx]
        end_ms = times_ms[end_idx]

        if merged and start_ms - merged[-1][1] < merge_gap_ms:
            merged[-1] = (merged[-1][0], end_ms, merged[-1][2], max(merged[-1][3], end_idx))
        else:
            merged.append((start_ms, end_ms, start_idx, end_idx))

    # Filter by minimum duration and compute stats
    segments = []
    for start_ms, end_ms, start_idx, end_idx in merged:
        duration = end_ms - start_ms
        if duration < min_duration_ms:
            continue

        seg_energy = energy[start_idx:end_idx + 1]
        segments.append({
            "id": str(uuid.uuid4())[:8],
            "startMs": round(start_ms),
            "endMs": round(end_ms),
            "durationMs": round(duration),
            "peakEnergy": round(float(np.max(seg_energy)), 4),
            "avgEnergy": round(float(np.mean(seg_energy)), 4),
            "label": "reaction",
        })

    return segments


def classify_segments(segments: list, energy: np.ndarray, times_ms: np.ndarray) -> list:
    """
    Simple classification: high peak + short = laugh, sustained = applause.
    """
    for seg in segments:
        duration = seg["durationMs"]
        peak = seg["peakEnergy"]
        avg = seg["avgEnergy"]

        # Ratio of peak to average indicates shape
        ratio = peak / avg if avg > 0 else 1.0

        if duration > 3000:
            seg["label"] = "applause"
        elif ratio > 2.0 and duration < 1500:
            seg["label"] = "laugh"
        else:
            seg["label"] = "reaction"

    return segments


def main():
    parser = argparse.ArgumentParser(description="Laughter/applause detection")
    parser.add_argument("--input", required=True, help="Path to ambient audio")
    parser.add_argument("--output", required=True, help="Output JSON path for segments")
    parser.add_argument("--threshold", type=float, default=2.0,
                        help="Energy threshold factor over median (default: 2.0)")
    parser.add_argument("--min-duration", type=float, default=300,
                        help="Minimum segment duration in ms (default: 300)")
    parser.add_argument("--merge-gap", type=float, default=500,
                        help="Merge segments closer than this gap in ms (default: 500)")
    parser.add_argument("--window-ms", type=float, default=50,
                        help="Analysis window size in ms (default: 50)")
    args = parser.parse_args()

    log_progress(0, "Cargando audio de ambiente...")

    try:
        samples, sample_rate = read_wav(args.input)
    except Exception as e:
        log_progress(0, f"Error leyendo audio: {e}")
        sys.exit(1)

    duration_sec = len(samples) / sample_rate
    log_progress(10, f"Audio cargado: {duration_sec:.1f}s @ {sample_rate}Hz")

    log_progress(20, "Calculando envolvente de energía...")
    energy, times_ms = compute_energy_envelope(samples, sample_rate, args.window_ms)

    log_progress(50, "Detectando segmentos de alta energía...")
    segments = detect_segments(
        energy, times_ms,
        threshold_factor=args.threshold,
        min_duration_ms=args.min_duration,
        merge_gap_ms=args.merge_gap,
    )

    log_progress(70, "Clasificando segmentos...")
    segments = classify_segments(segments, energy, times_ms)

    log_progress(85, f"Encontrados {len(segments)} segmentos")

    # Build volume curve: for each frame, compute a volume multiplier
    # High energy frames get volume boost, low energy frames get base volume
    log_progress(90, "Generando curva de volumen...")

    # Compute a smooth volume curve from the energy envelope
    if len(energy) > 0:
        median_energy = np.median(energy)
        # Normalize energy relative to median
        normalized = energy / (median_energy + 1e-8)
        # Clamp to reasonable range
        normalized = np.clip(normalized, 0, 5)
        # Smooth with a larger window
        kernel_size = min(21, len(normalized))
        if kernel_size % 2 == 0:
            kernel_size -= 1
        if kernel_size >= 3:
            kernel = np.ones(kernel_size) / kernel_size
            smooth = np.convolve(normalized, kernel, mode='same')
        else:
            smooth = normalized

        volume_curve = [
            {
                "timeMs": round(float(times_ms[i])),
                "volume": round(float(min(smooth[i], 3.0)), 3),
            }
            for i in range(0, len(smooth), max(1, len(smooth) // 500))  # Max ~500 points
        ]
    else:
        volume_curve = []

    log_progress(95, "Escribiendo resultados...")

    result = {
        "segments": segments,
        "volumeCurve": volume_curve,
        "stats": {
            "totalSegments": len(segments),
            "laughs": sum(1 for s in segments if s["label"] == "laugh"),
            "applause": sum(1 for s in segments if s["label"] == "applause"),
            "reactions": sum(1 for s in segments if s["label"] == "reaction"),
            "totalReactionTimeMs": sum(s["durationMs"] for s in segments),
            "audioDurationMs": round(duration_sec * 1000),
        },
        "config": {
            "threshold": args.threshold,
            "minDurationMs": args.min_duration,
            "mergeGapMs": args.merge_gap,
            "windowMs": args.window_ms,
        },
    }

    with open(args.output, 'w') as f:
        json.dump(result, f, indent=2)

    log_progress(100, f"Detección completada: {len(segments)} segmentos")

    # Print summary to stdout as JSON
    print(json.dumps(result["stats"]))


if __name__ == "__main__":
    main()
