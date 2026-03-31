#!/usr/bin/env python3
"""
Guided voice subtraction using the desk microphone as reference.

Takes the desk microphone (clean voice) and camera audio (voice + ambient),
aligns them via cross-correlation, then removes voice from the camera audio
to isolate the ambient sound (laughter, applause, room noise).

Uses energy-envelope cross-correlation for alignment (works even with
multi-minute offsets) and Wiener-style soft masking with transfer function
estimation to avoid "musical noise" artifacts.

Usage:
    python3 scripts/subtract_voice.py \
        --mic <mic.wav> \
        --camera <camera.wav> \
        --output <ambient.wav> \
        [--method spectral|nlms] \
        [--alpha 1.5] \
        [--floor 0.02]

Methods:
    spectral (default): Wiener-style soft masking with transfer function.
    nlms: Normalized LMS adaptive filter.

Progress is printed to stderr as JSON lines: {"progress": 0-100, "message": "..."}
"""

import argparse
import json
import sys
import numpy as np
import wave
import struct


def log_progress(progress: int, message: str):
    """Print progress as JSON to stderr for the Node.js worker to parse."""
    print(json.dumps({"progress": progress, "message": message}), file=sys.stderr, flush=True)


def read_wav(path: str) -> tuple:
    """Read a WAV file and return (samples as float64 array, sample_rate, n_channels)."""
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

    return samples, sample_rate, n_channels


def write_wav(path: str, samples: np.ndarray, sample_rate: int):
    """Write a mono float64 array to a 16-bit WAV file."""
    samples = np.clip(samples, -1.0, 1.0)
    int_samples = (samples * 32767).astype(np.int16)

    with wave.open(path, 'w') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(int_samples.tobytes())


def align_signals(mic: np.ndarray, camera: np.ndarray, sample_rate: int) -> tuple:
    """
    Two-stage alignment (like Adobe Premiere):

    Stage 1 — Coarse: Energy-envelope cross-correlation (50ms resolution).
              Fast, handles multi-minute offsets.
    Stage 2 — Fine:   Sample-level cross-correlation in a ±100ms window
              around the coarse offset. Gives sub-ms precision.

    Returns (aligned_mic, aligned_camera, offset_samples, offset_ms, alignment_data).
    Both outputs will have the same length (the overlap region).
    """
    # === Stage 1: Coarse alignment via energy envelopes ===
    frame_len = int(sample_rate * 0.1)   # 100ms frames
    hop_len = int(sample_rate * 0.05)    # 50ms hop

    def energy_envelope(signal):
        n_frames = max(1, (len(signal) - frame_len) // hop_len + 1)
        env = np.zeros(n_frames)
        for i in range(n_frames):
            start = i * hop_len
            frame = signal[start:start + frame_len]
            env[i] = np.sqrt(np.mean(frame ** 2))
        return env

    log_progress(8, "Fase 1: Alineación gruesa por envolventes de energía...")
    mic_env = energy_envelope(mic)
    cam_env = energy_envelope(camera)

    mic_dur = len(mic) / sample_rate
    cam_dur = len(camera) / sample_rate
    log_progress(9, f"Envolventes: mic={len(mic_env)} frames ({mic_dur:.0f}s), "
                     f"cam={len(cam_env)} frames ({cam_dur:.0f}s)")

    n = len(mic_env) + len(cam_env) - 1
    fft_size = 1
    while fft_size < n:
        fft_size *= 2

    mic_fft = np.fft.rfft(mic_env, fft_size)
    cam_fft = np.fft.rfft(cam_env, fft_size)
    corr = np.fft.irfft(cam_fft * np.conj(mic_fft), fft_size)

    peak_idx = np.argmax(np.abs(corr))
    if peak_idx > fft_size // 2:
        offset_env = peak_idx - fft_size
    else:
        offset_env = peak_idx

    coarse_offset = -offset_env * hop_len
    coarse_ms = round(coarse_offset / sample_rate * 1000, 1)
    log_progress(11, f"Offset grueso: {coarse_ms}ms ({coarse_ms/1000:.1f}s)")

    # === Stage 2: Fine alignment via waveform cross-correlation ===
    # Use a ±100ms search window around the coarse offset
    # Cross-correlate 5s of actual audio for sample-level precision
    log_progress(12, "Fase 2: Refinamiento muestra a muestra (±100ms)...")

    search_radius = int(sample_rate * 0.1)  # ±100ms in samples
    check_duration = int(sample_rate * 5)     # 5 seconds of audio

    # Extract overlapping chunks at the coarse offset
    if coarse_offset > 0:
        mic_start = coarse_offset
        cam_start = 0
    else:
        mic_start = 0
        cam_start = -coarse_offset

    # Ensure enough samples for cross-correlation
    avail_mic = len(mic) - mic_start
    avail_cam = len(camera) - cam_start
    chunk_len = min(check_duration, avail_mic - search_radius, avail_cam - search_radius)

    if chunk_len > sample_rate:  # Only refine if we have >1s of overlap
        # Camera chunk: fixed reference
        cam_chunk = camera[cam_start:cam_start + chunk_len].astype(np.float64)

        # Mic chunk: wider to allow searching ±search_radius
        mic_wide_start = max(0, mic_start - search_radius)
        mic_wide_end = min(len(mic), mic_start + chunk_len + search_radius)
        mic_wide = mic[mic_wide_start:mic_wide_end].astype(np.float64)

        # Cross-correlate using FFT
        cc_len = len(mic_wide) + len(cam_chunk) - 1
        cc_fft_size = 1
        while cc_fft_size < cc_len:
            cc_fft_size *= 2

        mic_fft2 = np.fft.rfft(mic_wide, cc_fft_size)
        cam_fft2 = np.fft.rfft(cam_chunk, cc_fft_size)
        fine_corr = np.fft.irfft(mic_fft2 * np.conj(cam_fft2), cc_fft_size)

        # The peak in fine_corr tells us where cam_chunk best aligns within mic_wide
        fine_peak = np.argmax(fine_corr[:len(mic_wide)])

        # Convert to absolute offset adjustment
        # fine_peak is where cam_chunk starts in mic_wide
        # mic_wide starts at mic_wide_start in the original mic signal
        # So mic position = mic_wide_start + fine_peak
        # And the offset = mic_position - cam_start
        fine_offset = (mic_wide_start + fine_peak) - cam_start
        fine_adjustment = fine_offset - coarse_offset
        fine_ms = round(fine_adjustment / sample_rate * 1000, 2)

        log_progress(14, f"Ajuste fino: {fine_ms:+.2f}ms (de {coarse_ms}ms a {round(fine_offset/sample_rate*1000, 2)}ms)")
        offset_samples = fine_offset
    else:
        log_progress(14, "Solapamiento insuficiente para refinamiento, usando offset grueso")
        offset_samples = coarse_offset

    offset_ms = round(offset_samples / sample_rate * 1000, 2)
    offset_sec = round(offset_ms / 1000, 2)

    # Apply offset: positive means mic starts before camera
    if offset_samples > 0:
        aligned_mic = mic[offset_samples:]
        aligned_camera = camera
    elif offset_samples < 0:
        aligned_mic = mic
        aligned_camera = camera[-offset_samples:]
    else:
        aligned_mic = mic
        aligned_camera = camera

    # Trim to overlap
    min_len = min(len(aligned_mic), len(aligned_camera))
    aligned_mic = aligned_mic[:min_len]
    aligned_camera = aligned_camera[:min_len]

    # Quality check
    check_len = min(10 * sample_rate, min_len)
    a = aligned_mic[:check_len]
    b = aligned_camera[:check_len]
    norm = np.sqrt(np.dot(a, a) * np.dot(b, b))
    corr_coeff = np.abs(np.dot(a, b)) / (norm + 1e-10) if norm > 0 else 0

    log_progress(15, f"Alineado: offset={offset_sec}s, overlap={min_len/sample_rate:.1f}s, "
                     f"correlación={corr_coeff:.3f}")

    # Visualization data
    alignment_data = {
        "mic_envelope": np.round(mic_env, 4).tolist(),
        "camera_envelope": np.round(cam_env, 4).tolist(),
        "envelope_hop_ms": round(hop_len / sample_rate * 1000, 1),
        "coarse_offset_ms": coarse_ms,
        "fine_offset_ms": offset_ms,
        "offset_ms": offset_ms,
        "offset_seconds": offset_sec,
        "mic_duration_s": round(len(mic) / sample_rate, 1),
        "camera_duration_s": round(len(camera) / sample_rate, 1),
        "overlap_s": round(min_len / sample_rate, 1),
        "correlation": round(float(corr_coeff), 4),
    }

    return aligned_mic, aligned_camera, offset_samples, offset_ms, alignment_data


def estimate_scale(mic: np.ndarray, camera: np.ndarray) -> np.ndarray:
    """
    Least-squares optimal scaling: find c such that ||camera - c*mic||^2 is minimized.
    c = dot(mic, camera) / dot(mic, mic)
    Only used for NLMS (spectral method uses transfer function instead).
    """
    dot_mm = np.dot(mic, mic)
    if dot_mm < 1e-10:
        return mic
    c = np.dot(mic, camera) / dot_mm
    return mic * c


def spectral_subtraction(mic: np.ndarray, camera: np.ndarray,
                         alpha: float = 1.5, floor: float = 0.02,
                         n_fft: int = 2048, hop: int = 512) -> np.ndarray:
    """
    Wiener-style voice removal using mic as reference.

    Instead of simple magnitude subtraction (which produces musical noise),
    this method:
    1. Estimates the acoustic transfer function H(f) from mic to camera
       (captures room acoustics, distance, frequency response differences)
    2. Applies a soft gain mask per frame based on estimated voice contribution
    3. Smooths the gain across frequency and time to eliminate artifacts
    """
    log_progress(30, "Calculando STFT de ambas pistas...")

    window = np.hanning(n_fft)
    min_len = min(len(mic), len(camera))
    mic = mic[:min_len]
    camera = camera[:min_len]

    n_frames = 1 + (min_len - n_fft) // hop
    if n_frames <= 0:
        raise ValueError("Audio too short for STFT processing")

    n_bins = n_fft // 2 + 1

    def stft(signal):
        frames = []
        for i in range(n_frames):
            start = i * hop
            frame = signal[start:start + n_fft] * window
            frames.append(np.fft.rfft(frame))
        return np.array(frames)

    mic_stft = stft(mic)
    log_progress(40, "STFT del micro completado")

    camera_stft = stft(camera)
    log_progress(50, "STFT de cámara completado")

    # --- Estimate acoustic transfer function H(f) ---
    # H(f) = S_mc(f) / S_mm(f) where:
    #   S_mm = auto-spectral density of mic
    #   S_mc = cross-spectral density (camera × conj(mic))
    # This captures how the voice travels from mic position to camera position
    # (room acoustics, distance attenuation, frequency response differences)
    log_progress(55, "Estimando función de transferencia acústica...")

    S_mm = np.mean(np.abs(mic_stft) ** 2, axis=0) + 1e-10
    S_mc = np.mean(camera_stft * np.conj(mic_stft), axis=0)
    H = S_mc / S_mm

    # --- Apply soft gain mask per frame ---
    log_progress(60, "Aplicando máscara Wiener suave...")

    output_stft = np.zeros_like(camera_stft)
    prev_gain = np.ones(n_bins)

    # Smoothing: frequency kernel (moving average across bins)
    freq_smooth_bins = 5
    freq_kernel = np.ones(freq_smooth_bins) / freq_smooth_bins

    # Temporal smoothing factor (0 = no smoothing, higher = smoother)
    time_smooth = 0.3

    report_interval = max(1, n_frames // 20)

    for i in range(n_frames):
        # Estimate voice contribution in camera through transfer function
        voice_est = H * mic_stft[i]
        voice_power = np.abs(voice_est) ** 2
        camera_power = np.abs(camera_stft[i]) ** 2 + 1e-10

        # Wiener-style gain: suppress where voice dominates, keep where ambient dominates
        # gain ≈ 1 when camera_power >> voice_power (ambient)
        # gain ≈ floor when voice_power ≈ camera_power (voice)
        gain = 1.0 - alpha * (voice_power / camera_power)
        gain = np.clip(gain, floor, 1.0)

        # Frequency smoothing: moving average to prevent isolated peaks (musical noise)
        if n_bins > freq_smooth_bins:
            gain = np.convolve(gain, freq_kernel, mode='same')
            gain = np.clip(gain, floor, 1.0)

        # Temporal smoothing: exponential moving average across frames
        gain = time_smooth * prev_gain + (1.0 - time_smooth) * gain
        prev_gain = gain.copy()

        output_stft[i] = gain * camera_stft[i]

        if i % report_interval == 0:
            pct = 60 + int(30 * i / n_frames)
            log_progress(pct, f"Máscara Wiener... {i}/{n_frames} frames")

    log_progress(90, "Reconstruyendo señal de ambiente...")

    # ISTFT with overlap-add
    output_len = (n_frames - 1) * hop + n_fft
    output = np.zeros(output_len)
    window_sum = np.zeros(output_len)

    for i in range(n_frames):
        start = i * hop
        frame = np.fft.irfft(output_stft[i]) * window
        output[start:start + n_fft] += frame
        window_sum[start:start + n_fft] += window ** 2

    nonzero = window_sum > 1e-8
    output[nonzero] /= window_sum[nonzero]

    return output


def nlms_subtraction(mic: np.ndarray, camera: np.ndarray,
                     filter_length: int = 2048, mu: float = 0.5) -> np.ndarray:
    """
    Normalized LMS adaptive filter subtraction.
    The adaptive filter learns to predict the camera's voice component from the mic,
    and the error signal is the ambient.
    """
    log_progress(30, "Inicializando filtro adaptativo NLMS...")

    min_len = min(len(mic), len(camera))
    mic = mic[:min_len]
    camera = camera[:min_len]

    w = np.zeros(filter_length)
    output = np.zeros(min_len)
    eps = 1e-8

    report_interval = max(1, min_len // 60)

    for n in range(filter_length, min_len):
        x = mic[n - filter_length:n][::-1]
        y_hat = np.dot(w, x)
        e = camera[n] - y_hat
        norm = np.dot(x, x) + eps
        w += (mu / norm) * e * x
        output[n] = e

        if n % report_interval == 0:
            pct = 30 + int(60 * n / min_len)
            log_progress(pct, f"Filtro adaptativo... {pct}%")

    return output


def main():
    parser = argparse.ArgumentParser(description="Guided voice subtraction")
    parser.add_argument("--mic", required=True, help="Path to desk mic audio")
    parser.add_argument("--camera", required=True, help="Path to camera audio")
    parser.add_argument("--output", required=True, help="Output path for ambient audio")
    parser.add_argument("--method", choices=["spectral", "nlms"], default="spectral",
                        help="Subtraction method (default: spectral)")
    parser.add_argument("--alpha", type=float, default=1.5,
                        help="Voice suppression strength for spectral method (default: 1.5)")
    parser.add_argument("--floor", type=float, default=0.02,
                        help="Minimum gain floor for spectral method (default: 0.02)")
    parser.add_argument("--filter-length", type=int, default=2048,
                        help="Filter length for NLMS method (default: 2048)")
    parser.add_argument("--mu", type=float, default=0.5,
                        help="Step size for NLMS method (default: 0.5)")
    parser.add_argument("--alignment-out", type=str, default=None,
                        help="Path to save alignment visualization data (JSON)")
    parser.add_argument("--align-only", action="store_true",
                        help="Only align signals, skip voice subtraction. Output is aligned camera audio.")
    args = parser.parse_args()

    log_progress(0, "Cargando archivos de audio...")

    try:
        mic, mic_sr, _ = read_wav(args.mic)
        camera, cam_sr, _ = read_wav(args.camera)
    except Exception as e:
        log_progress(0, f"Error leyendo audio: {e}")
        sys.exit(1)

    if mic_sr != cam_sr:
        log_progress(0, f"Error: sample rates don't match (mic={mic_sr}, camera={cam_sr})")
        sys.exit(1)

    log_progress(5, f"Audio cargado: mic={len(mic)/mic_sr:.1f}s, camera={len(camera)/cam_sr:.1f}s @ {mic_sr}Hz")

    # Step 1: Align signals via energy-envelope cross-correlation
    # Works for arbitrary offsets (even 15+ minutes apart)
    log_progress(7, "Alineando señales por correlación cruzada de envolventes...")
    mic, camera, offset_samples, offset_ms, alignment_data = align_signals(mic, camera, mic_sr)

    # Save alignment visualization data if requested
    if args.alignment_out:
        with open(args.alignment_out, 'w') as f:
            json.dump(alignment_data, f)
        log_progress(16, f"Datos de alineación guardados en {args.alignment_out}")

    if args.align_only:
        # Align-only mode: write aligned camera audio directly (no voice subtraction)
        log_progress(90, "Modo solo-alineación: escribiendo audio de cámara alineado...")
        ambient = camera  # already aligned by align_signals()

        # Normalize
        peak = np.max(np.abs(ambient))
        if peak > 0:
            ambient = ambient / peak * 0.95

        log_progress(95, "Escribiendo archivo de salida...")
        write_wav(args.output, ambient, mic_sr)
        log_progress(100, "Alineación completada")

        result = {
            "output": args.output,
            "method": "align-only",
            "sample_rate": mic_sr,
            "offset_ms": offset_ms,
            "offset_seconds": round(offset_ms / 1000, 1),
            "duration_samples": len(ambient),
            "duration_seconds": round(len(ambient) / mic_sr, 2),
        }
        print(json.dumps(result))
        return

    # Step 2: Level matching (only for NLMS — spectral uses transfer function)
    if args.method == "nlms":
        log_progress(20, "Ajustando niveles por mínimos cuadrados...")
        mic = estimate_scale(mic, camera)
    else:
        log_progress(20, "Niveles se estimarán por función de transferencia")

    # Step 3: Subtract
    if args.method == "spectral":
        ambient = spectral_subtraction(mic, camera, alpha=args.alpha, floor=args.floor)
    else:
        ambient = nlms_subtraction(mic, camera, filter_length=args.filter_length, mu=args.mu)

    # Step 4: Normalize output
    log_progress(92, "Normalizando salida...")
    peak = np.max(np.abs(ambient))
    if peak > 0:
        ambient = ambient / peak * 0.95

    log_progress(95, "Escribiendo archivo de salida...")
    write_wav(args.output, ambient, mic_sr)

    log_progress(100, "Sustracción completada")

    result = {
        "output": args.output,
        "method": args.method,
        "sample_rate": mic_sr,
        "offset_ms": offset_ms,
        "offset_seconds": round(offset_ms / 1000, 1),
        "duration_samples": len(ambient),
        "duration_seconds": round(len(ambient) / mic_sr, 2),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
