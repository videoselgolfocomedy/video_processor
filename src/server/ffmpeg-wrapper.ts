import { execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';

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

export interface ProbeResult {
  duration: number;
  codec: string;
  sampleRate?: number;
  channels?: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  format: string;
}

export interface ColorInfo {
  /** Pixel format, e.g. "yuv420p10le" — useful to detect 10-bit HDR sources */
  pixFmt?: string;
  /** Color primaries, e.g. "bt709" / "bt2020" */
  primaries?: string;
  /** Transfer characteristics, e.g. "bt709" / "smpte2084" (PQ) / "arib-std-b67" (HLG) */
  transfer?: string;
  /** Color matrix, e.g. "bt709" / "bt2020nc" */
  matrix?: string;
  /** Color range, "tv" (limited) or "pc" (full) */
  range?: string;
  /** Convenience flag: true when source is HDR (PQ/HLG transfer or BT.2020 primaries) */
  isHdr: boolean;
}

/**
 * Probe a video's color characteristics so the renderer can decide whether
 * to do HDR→SDR tone mapping. iPhone-shot HEVC is BT.2020 / HLG by default;
 * a plain `scale` filter renders that as washed-out / over-bright SDR.
 */
export async function probeColorInfo(filePath: string): Promise<ColorInfo> {
  const ffprobe = getFFprobePath();
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=pix_fmt,color_primaries,color_transfer,color_space,color_range',
      '-of', 'json',
      filePath,
    ], { timeout: 15000 });
    const data = JSON.parse(stdout);
    const stream = data.streams?.[0] ?? {};
    const pixFmt = stream.pix_fmt as string | undefined;
    const primaries = stream.color_primaries as string | undefined;
    const transfer = stream.color_transfer as string | undefined;
    const matrix = stream.color_space as string | undefined;
    const range = stream.color_range as string | undefined;

    const isHdrTransfer = transfer === 'smpte2084' || transfer === 'arib-std-b67';
    const isWideGamut = primaries === 'bt2020' || matrix === 'bt2020nc' || matrix === 'bt2020c';
    const is10bit = !!pixFmt && pixFmt.includes('10');
    const isHdr = isHdrTransfer || (isWideGamut && is10bit);

    return { pixFmt, primaries, transfer, matrix, range, isHdr };
  } catch (err) {
    console.warn(`[ffmpeg-wrapper] probeColorInfo failed for ${filePath}:`, (err as Error).message);
    return { isHdr: false };
  }
}

export async function probeFile(filePath: string): Promise<ProbeResult> {
  const ffprobe = getFFprobePath();
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { timeout: 30000 });

  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
  const audioStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio');

  return {
    duration: parseFloat(data.format?.duration || '0'),
    codec: videoStream?.codec_name || audioStream?.codec_name || 'unknown',
    sampleRate: audioStream ? parseInt(audioStream.sample_rate, 10) : undefined,
    channels: audioStream?.channels,
    width: videoStream?.width,
    height: videoStream?.height,
    hasAudio: !!audioStream,
    hasVideo: !!videoStream,
    format: data.format?.format_name || 'unknown',
  };
}

export interface ExtractAudioOptions {
  inputPath: string;
  outputPath: string;
  sampleRate?: number;
  channels?: number;
  onProgress?: (percent: number) => void;
}

export function extractAudio(options: ExtractAudioOptions): {
  promise: Promise<void>;
  process: ChildProcess;
} {
  const {
    inputPath,
    outputPath,
    sampleRate = 48000,
    channels = 1,
  } = options;

  const ffmpeg = getFFmpegPath();
  const args = [
    '-i', inputPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', String(sampleRate),
    '-ac', String(channels),
    '-y',
    '-progress', 'pipe:1',
    outputPath,
  ];

  const proc = execFile(ffmpeg, args);

  const promise = new Promise<void>((resolve, reject) => {
    let duration = 0;
    const stderrLines: string[] = [];

    // Parse progress from stdout
    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const us = parseInt(line.split('=')[1], 10);
          if (duration > 0 && options.onProgress) {
            const percent = Math.min(100, (us / 1_000_000 / duration) * 100);
            options.onProgress(percent);
          }
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrLines.push(text);
      // Keep only last 20 chunks to avoid unbounded memory
      if (stderrLines.length > 20) stderrLines.shift();
      const match = text.match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (match) {
        duration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Extract the last meaningful error line from stderr
        const allStderr = stderrLines.join('');
        const errorLines = allStderr.split('\n').filter(l => l.trim()).slice(-5);
        const detail = errorLines.join(' | ').substring(0, 300);
        reject(new Error(`FFmpeg exited with code ${code}: ${detail}`));
      }
    });

    proc.on('error', reject);
  });

  return { promise, process: proc };
}

export interface AudioFilterOptions {
  inputPath: string;
  outputPath: string;
  filters: string;
  onProgress?: (percent: number) => void;
}

export function applyAudioFilters(options: AudioFilterOptions): {
  promise: Promise<void>;
  process: ChildProcess;
} {
  const ffmpeg = getFFmpegPath();
  const args = [
    '-i', options.inputPath,
    '-af', options.filters,
    '-y',
    '-progress', 'pipe:1',
    options.outputPath,
  ];

  const proc = execFile(ffmpeg, args);

  const promise = new Promise<void>((resolve, reject) => {
    let stderrData = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderrData += data.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const lastLines = stderrData.split('\n').filter(Boolean).slice(-5).join(' | ');
        reject(new Error(`FFmpeg filter exited with code ${code}: ${lastLines}`));
      }
    });
    proc.on('error', reject);
  });

  return { promise, process: proc };
}

export async function convertForWhisper(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const ffmpeg = getFFmpegPath();
  await execFileAsync(ffmpeg, [
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-acodec', 'pcm_s16le',
    '-y',
    outputPath,
  ], { timeout: 300000 });
}

export async function convertForGroq(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const ffmpeg = getFFmpegPath();
  // Compress to mp3 mono 48kbps to fit Groq's 25MB limit
  // 30 min audio ≈ 11MB at 48kbps
  await execFileAsync(ffmpeg, [
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-codec:a', 'libmp3lame',
    '-b:a', '48k',
    '-y',
    outputPath,
  ], { timeout: 300000 });
}

export interface CreateProxyOptions {
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  onProgress?: (percent: number) => void;
}

export function createVideoProxy(options: CreateProxyOptions): {
  promise: Promise<void>;
  process: ChildProcess;
} {
  const ffmpeg = getFFmpegPath();
  // Transcode to H.264 proxy at target resolution for Remotion (headless Chromium).
  // -g 1       → every frame is an I-frame so Chromium can seek to any frame instantly.
  // -bf 0      → no B-frames (required when -g 1).
  // -preset ultrafast → speed over size (this is a temp file for rendering, not the output).
  const args = [
    '-i', options.inputPath,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '18',
    '-g', '1',
    '-bf', '0',
    '-vf', `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2`,
    '-an',
    '-y',
    '-progress', 'pipe:1',
    options.outputPath,
  ];

  const proc = execFile(ffmpeg, args);

  const promise = new Promise<void>((resolve, reject) => {
    let duration = 0;

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const us = parseInt(line.split('=')[1], 10);
          if (duration > 0 && options.onProgress) {
            const percent = Math.min(100, (us / 1_000_000 / duration) * 100);
            options.onProgress(percent);
          }
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const match = data.toString().match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (match) {
        duration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg proxy exited with code ${code}`));
    });

    proc.on('error', reject);
  });

  return { promise, process: proc };
}

export interface RenderVideoOptions {
  videoInputPath: string;
  audioInputPath?: string;
  assFilePath?: string;
  fontsDirPath?: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  crf: number;
  audioBitrate: string;
  trimStartMs?: number;
  trimEndMs?: number;
  cropRegion?: { centerX: number; centerY: number; scale: number };
  sourceWidth?: number;
  sourceHeight?: number;
  onProgress?: (percent: number) => void;
}

export function renderVideo(options: RenderVideoOptions): {
  promise: Promise<void>;
  process: ChildProcess;
} {
  const ffmpeg = getFFmpegPath();
  const args: string[] = [];

  // Input seeking for trim (fast, placed before -i)
  const trimStartSec = options.trimStartMs != null ? options.trimStartMs / 1000 : undefined;
  if (trimStartSec != null && trimStartSec > 0) {
    args.push('-ss', String(trimStartSec));
  }

  // Video input
  args.push('-i', options.videoInputPath);

  // Audio input (separate file if provided)
  if (options.audioInputPath) {
    if (trimStartSec != null && trimStartSec > 0) {
      args.push('-ss', String(trimStartSec));
    }
    args.push('-i', options.audioInputPath);
  }

  // Duration (trim end - start)
  if (options.trimStartMs != null && options.trimEndMs != null) {
    const durationSec = (options.trimEndMs - options.trimStartMs) / 1000;
    if (durationSec > 0) {
      args.push('-t', String(durationSec));
    }
  }

  // Video filter chain
  const filters: string[] = [];

  if (options.cropRegion && options.sourceWidth && options.sourceHeight) {
    // Crop mode: extract 9:16 region from source, then scale to output
    const srcW = options.sourceWidth;
    const srcH = options.sourceHeight;
    const { centerX, centerY, scale } = options.cropRegion;

    let cropH = Math.round(srcH * scale);
    let cropW = Math.round(cropH * (9 / 16));

    // Clamp to source dimensions
    if (cropW > srcW) {
      cropW = srcW;
      cropH = Math.round(cropW * (16 / 9));
    }

    // Round to even for H.264 compatibility
    cropW = cropW % 2 === 0 ? cropW : cropW - 1;
    cropH = cropH % 2 === 0 ? cropH : cropH - 1;

    // Compute top-left offsets, clamped to source bounds
    let cropX = Math.round(centerX * srcW - cropW / 2);
    let cropY = Math.round(centerY * srcH - cropH / 2);
    cropX = Math.max(0, Math.min(srcW - cropW, cropX));
    cropY = Math.max(0, Math.min(srcH - cropH, cropY));

    filters.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
    filters.push(`scale=${options.width}:${options.height}`);
  } else {
    // Standard scale + pad (letterbox)
    filters.push(
      `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease`
    );
    filters.push(
      `pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2`
    );
  }

  if (options.assFilePath) {
    // Escape special chars in path for ffmpeg filter syntax (: \ ' [ ])
    const escapedAssPath = options.assFilePath
      .replace(/\\/g, '\\\\\\\\')
      .replace(/:/g, '\\\\:')
      .replace(/'/g, "\\\\'")
      .replace(/\[/g, '\\\\[')
      .replace(/\]/g, '\\\\]');

    let assFilter = `ass='${escapedAssPath}'`;
    if (options.fontsDirPath) {
      const escapedFontsDir = options.fontsDirPath
        .replace(/\\/g, '\\\\\\\\')
        .replace(/:/g, '\\\\:')
        .replace(/'/g, "\\\\'");
      assFilter = `ass='${escapedAssPath}':fontsdir='${escapedFontsDir}'`;
    }
    filters.push(assFilter);
  }

  args.push('-vf', filters.join(','));

  // Mapping: video from input 0, audio from input 1 (or input 0 if no separate audio)
  args.push('-map', '0:v:0');
  if (options.audioInputPath) {
    args.push('-map', '1:a:0');
  } else {
    // Try to use audio from the video file itself
    args.push('-map', '0:a:0?');
  }

  // Video codec. No explicit color tagging — see comment in renderReelVideo.
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(options.crf),
    '-r', String(options.fps),
    '-pix_fmt', 'yuv420p',
  );

  // Audio codec
  args.push(
    '-c:a', 'aac',
    '-b:a', options.audioBitrate,
  );

  // Fast-start for web playback
  args.push('-movflags', '+faststart');

  // Overwrite + progress
  args.push('-y', '-progress', 'pipe:1', options.outputPath);

  console.log(`[ffmpeg-render] ${ffmpeg} ${args.join(' ')}`);

  const proc = execFile(ffmpeg, args, { maxBuffer: 1024 * 1024 * 64 });

  const promise = new Promise<void>((resolve, reject) => {
    let duration = 0;
    let stderrLog = '';
    let stderrLineBuf = '';
    let lastProgressMs = Date.now();

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const us = parseInt(line.split('=')[1], 10);
          if (duration > 0 && options.onProgress) {
            const percent = Math.min(100, (us / 1_000_000 / duration) * 100);
            options.onProgress(percent);
          }
          lastProgressMs = Date.now();
        }
      }
    });

    // Live-stream stderr line-by-line, the same way renderReelVideo does, so
    // we can see what FFmpeg is doing in real time. Without this, a hung
    // simple render produces zero diagnostics.
    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrLog += chunk;
      stderrLineBuf += chunk;
      const match = chunk.match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (match) {
        duration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
      }
      let idx;
      while ((idx = stderrLineBuf.indexOf('\n')) !== -1) {
        const line = stderrLineBuf.slice(0, idx).trimEnd();
        stderrLineBuf = stderrLineBuf.slice(idx + 1);
        if (line) console.log(`[ffmpeg-render] ${line}`);
      }
      lastProgressMs = Date.now();
    });

    // Watchdog: kill FFmpeg after 90s with no stderr/progress activity.
    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastProgressMs;
      if (idleMs > 90_000) {
        console.error(`[ffmpeg-render] watchdog: no progress for ${Math.round(idleMs / 1000)}s, killing FFmpeg`);
        clearInterval(watchdog);
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
      }
    }, 10_000);

    proc.on('close', (code) => {
      clearInterval(watchdog);
      if (stderrLineBuf.trim()) console.log(`[ffmpeg-render] ${stderrLineBuf.trimEnd()}`);
      if (code === 0) resolve();
      else {
        const tail = stderrLog.slice(-1500);
        console.error(`[ffmpeg-render] FFmpeg exited with code ${code}. stderr tail:\n${tail}`);
        reject(new Error(`FFmpeg render exited with code ${code}: ${tail.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
      }
    });

    proc.on('error', (err) => {
      clearInterval(watchdog);
      reject(err);
    });
  });

  return { promise, process: proc };
}

/* ── Reel rendering: concatenate edited clip segments ────────────────── */

export interface ImageOverlayInput {
  filePath: string;
  startMs: number;   // in concat output timeline
  endMs: number;
  x: number;         // 0-1 fraction
  y: number;
  width: number;     // 0-1 fraction
  opacity: number;   // 0-1
}

export interface ClipTransform {
  scale: number;  // 1 = original; >1 zoom in; <1 zoom out
  x: number;      // -1..1 fraction of output width (positive = shift right)
  y: number;      // -1..1 fraction of output height (positive = shift down)
}

export interface RenderReelOptions {
  videoInputPath: string;
  audioInputPath?: string;
  clips: { sourceInMs: number; sourceOutMs: number; transform?: ClipTransform }[];
  /** Audio clips mapped to the video concat timeline — specifies silent gaps */
  audioClipRanges?: { startMs: number; endMs: number }[];
  /** Image overlays to burn into the video */
  imageOverlays?: ImageOverlayInput[];
  assFilePath?: string;
  fontsDirPath?: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  crf: number;
  audioBitrate: string;
  cropRegion?: { centerX: number; centerY: number; scale: number };
  sourceWidth?: number;
  sourceHeight?: number;
  /** Source color characteristics. When .isHdr=true, an HDR→SDR tone-mapping
   * filter chain is inserted after concat so iPhone HLG (or any BT.2020/PQ)
   * footage doesn't render washed out as plain SDR. */
  sourceColorInfo?: ColorInfo;
  /** Output video codec. 'h264' (default, libx264 8-bit) or 'h265' (libx265,
   * supports 10-bit yuv420p10le + HDR tags so iPhone HLG sources are
   * preserved end-to-end and play back identically to the camera-original. */
  codec?: 'h264' | 'h265';
  onProgress?: (percent: number) => void;
}

/**
 * Render a reel by concatenating clip segments from the source video.
 * Each clip gets its own input with -ss for fast seeking (avoids slow sequential decode).
 * The clips are concatenated in order to produce the final output.
 */
export function renderReelVideo(options: RenderReelOptions): {
  promise: Promise<void>;
  process: ChildProcess;
} {
  const ffmpeg = getFFmpegPath();
  const args: string[] = [];
  const { clips } = options;
  const hasAudio = !!options.audioInputPath;

  // Each clip gets its own input pair (video + audio) with -ss fast-seek.
  // This avoids the slow sequential decode that trim= causes.
  // Input layout: [v0, a0, v1, a1, v2, a2, ...] or [v0, v1, ...] if no separate audio
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const seekSec = clip.sourceInMs / 1000;
    const durSec = (clip.sourceOutMs - clip.sourceInMs) / 1000;

    // Video input with seek
    args.push('-ss', String(seekSec), '-t', String(durSec), '-i', options.videoInputPath);

    // Audio input with seek (same time range)
    if (hasAudio) {
      args.push('-ss', String(seekSec), '-t', String(durSec), '-i', options.audioInputPath!);
    }
  }

  // Add image overlay inputs (after all clip inputs)
  const imageOverlays = options.imageOverlays ?? [];
  const firstImageInputIdx = clips.length * (hasAudio ? 2 : 1);
  for (const img of imageOverlays) {
    const ext = img.filePath.toLowerCase().split('.').pop() ?? '';
    if (ext === 'gif') {
      // GIF: use ignore_loop to keep looping, stream_loop for duration coverage
      args.push('-ignore_loop', '0', '-stream_loop', '-1', '-i', img.filePath);
    } else {
      // Still image: loop to create a video stream
      args.push('-loop', '1', '-i', img.filePath);
    }
  }

  // Build crop filter string
  let cropFilter = '';
  if (options.cropRegion && options.sourceWidth && options.sourceHeight) {
    const srcW = options.sourceWidth;
    const srcH = options.sourceHeight;
    const { centerX, centerY, scale } = options.cropRegion;
    let cropH = Math.round(srcH * scale);
    let cropW = Math.round(cropH * (9 / 16));
    if (cropW > srcW) { cropW = srcW; cropH = Math.round(cropW * (16 / 9)); }
    cropW = cropW % 2 === 0 ? cropW : cropW - 1;
    cropH = cropH % 2 === 0 ? cropH : cropH - 1;
    let cropX = Math.round(centerX * srcW - cropW / 2);
    let cropY = Math.round(centerY * srcH - cropH / 2);
    cropX = Math.max(0, Math.min(srcW - cropW, cropX));
    cropY = Math.max(0, Math.min(srcH - cropH, cropY));
    cropFilter = `,crop=${cropW}:${cropH}:${cropX}:${cropY}`;
  }

  // Build filter_complex
  const filterParts: string[] = [];

  // Input indices: if hasAudio, inputs are [v0=0, a0=1, v1=2, a1=3, ...]
  // If no separate audio, inputs are [v0=0, v1=1, v2=2, ...]
  const inputsPerClip = hasAudio ? 2 : 1;

  // Helper: detect non-identity transform
  const isIdentityTransform = (t?: ClipTransform): boolean => {
    if (!t) return true;
    return Math.abs((t.scale ?? 1) - 1) < 0.001 && Math.abs(t.x ?? 0) < 0.001 && Math.abs(t.y ?? 0) < 0.001;
  };

  const Wout = options.width;
  const Hout = options.height;

  // Are any clips using a per-clip transform? We use the heavier per-clip pipeline
  // (pre-scale + format normalization + optional overlay-on-black) ONLY when at
  // least one clip has a transform. Otherwise we keep the original concat → scale
  // pipeline, which preserves the source's color characteristics (range / primaries
  // / transfer) end-to-end. Forcing yuv420p / pad on every clip — even with no
  // transform — was washing out the colors on iPhone footage because of how
  // FFmpeg's scale + color filter sources interact with limited-range source.
  const anyTransform = clips.some((c) => !isIdentityTransform(c.transform));

  let videoLabel: string;

  if (!anyTransform) {
    // ── ORIGINAL PIPELINE ─────────────────────────────────────────────
    // Per-clip: setpts + (optional) crop only.
    // Concat → single scale to output. Color metadata (incl. HLG/BT.2020 tags
    // for HDR iPhone footage) flows through unchanged. libx264 inherits the
    // tags onto the output H.264, so QuickTime / iOS render the export with
    // the same tone-mapping it applies to the original file.
    for (let i = 0; i < clips.length; i++) {
      const vidIdx = i * inputsPerClip;
      const audIdx = hasAudio ? vidIdx + 1 : vidIdx;
      filterParts.push(`[${vidIdx}:v]setpts=PTS-STARTPTS${cropFilter}[v${i}]`);
      filterParts.push(`[${audIdx}:a]asetpts=PTS-STARTPTS[a${i}]`);
    }
    const concatInputs = clips.map((_, i) => `[v${i}][a${i}]`).join('');
    filterParts.push(`${concatInputs}concat=n=${clips.length}:v=1:a=1[outv][outa]`);
    filterParts.push(`[outv]scale=${Wout}:${Hout}[scaled]`);
    videoLabel = 'scaled';
  } else {
    // ── TRANSFORM PIPELINE ────────────────────────────────────────────
    // Each clip goes through pre-scale + pad + format=yuv420p so we have a
    // consistent canvas for the optional zoom/translate overlay. We do NOT
    // attempt our own HDR→SDR tone mapping here — instead we let the colour
    // metadata flow through the chain unchanged. libx264 inherits the source
    // tags (HLG / BT.2020) and writes them to the output H.264, matching the
    // colour treatment of the no-transform pipeline and of the source file
    // when played back in QuickTime.
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const vidIdx = i * inputsPerClip;
      const audIdx = hasAudio ? vidIdx + 1 : vidIdx;

      filterParts.push(
        `[${vidIdx}:v]setpts=PTS-STARTPTS${cropFilter},scale=${Wout}:${Hout}:force_original_aspect_ratio=decrease,pad=${Wout}:${Hout}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[v${i}_pre]`
      );

      if (isIdentityTransform(clip.transform)) {
        filterParts.push(`[v${i}_pre]setpts=PTS[v${i}]`);
      } else {
        const t = clip.transform!;
        const s = t.scale ?? 1;
        const x = t.x ?? 0;
        const y = t.y ?? 0;
        const durSec = ((clip.sourceOutMs - clip.sourceInMs) / 1000).toFixed(3);

        const scaledW = `trunc(iw*${s.toFixed(4)}/2)*2`;
        const scaledH = `trunc(ih*${s.toFixed(4)}/2)*2`;

        const offsetX = Math.round(Wout * (1 - s) / 2 + x * Wout);
        const offsetY = Math.round(Hout * (1 - s) / 2 + y * Hout);

        filterParts.push(`[v${i}_pre]scale=${scaledW}:${scaledH}[v${i}_zoom]`);
        // Black canvas. format=yuv420p chained (not as option — that throws on FFmpeg 6.x).
        filterParts.push(`color=c=black:s=${Wout}x${Hout}:r=${options.fps}:d=${durSec},format=yuv420p[v${i}_bg]`);
        filterParts.push(`[v${i}_bg][v${i}_zoom]overlay=x=${offsetX}:y=${offsetY}:eof_action=endall,format=yuv420p,setsar=1[v${i}]`);
      }

      filterParts.push(`[${audIdx}:a]asetpts=PTS-STARTPTS[a${i}]`);
    }

    const concatInputs = clips.map((_, i) => `[v${i}][a${i}]`).join('');
    filterParts.push(`${concatInputs}concat=n=${clips.length}:v=1:a=1[outv][outa]`);
    videoLabel = 'outv';
  }

  // Apply image overlays (between scale and ASS subtitles)
  for (let imgIdx = 0; imgIdx < imageOverlays.length; imgIdx++) {
    const img = imageOverlays[imgIdx];
    const imgInputIdx = firstImageInputIdx + imgIdx;
    const imgW = Math.round(img.width * options.width);
    // Center position: x*W - overlayW/2, y*H - overlayH/2
    // Use FFmpeg overlay expressions so overlay_h is resolved at runtime
    const ox = Math.round(img.x * options.width - imgW / 2);
    const oy = `${Math.round(img.y * options.height)}-overlay_h/2`;
    const startSec = (img.startMs / 1000).toFixed(3);
    const endSec = (img.endMs / 1000).toFixed(3);
    const nextLabel = `imgov${imgIdx}`;

    // Scale the image to the target width, preserve aspect ratio; apply opacity
    filterParts.push(
      `[${imgInputIdx}:v]scale=${imgW}:-1,format=rgba,colorchannelmixer=aa=${img.opacity.toFixed(2)}[img${imgIdx}]`
    );
    // Overlay onto the video with enable expression for timing
    // shortest=1 ensures the overlay doesn't extend beyond the main video
    filterParts.push(
      `[${videoLabel}][img${imgIdx}]overlay=x=${ox}:y=${oy}:shortest=1:enable='between(t,${startSec},${endSec})'[${nextLabel}]`
    );
    videoLabel = nextLabel;
  }

  // Optional ASS subtitles (on top of everything)
  let finalFilter = `[${videoLabel}]`;
  if (options.assFilePath) {
    const escapedAssPath = options.assFilePath
      .replace(/\\/g, '\\\\\\\\')
      .replace(/:/g, '\\\\:')
      .replace(/'/g, "\\\\'")
      .replace(/\[/g, '\\\\[')
      .replace(/\]/g, '\\\\]');
    let assFilter = `ass='${escapedAssPath}'`;
    if (options.fontsDirPath) {
      const escapedFontsDir = options.fontsDirPath
        .replace(/\\/g, '\\\\\\\\')
        .replace(/:/g, '\\\\:')
        .replace(/'/g, "\\\\'");
      assFilter = `ass='${escapedAssPath}':fontsdir='${escapedFontsDir}'`;
    }
    finalFilter += `${assFilter}[finalv]`;
  } else {
    // No ASS — just copy through with label rename
    finalFilter += `null[finalv]`;
  }

  filterParts.push(finalFilter);

  // Apply audio muting for gaps if audioClipRanges are provided
  let audioLabel = '[outa]';
  if (options.audioClipRanges && options.audioClipRanges.length > 0) {
    // Build volume expression: volume=1 during audio clips, 0 during gaps
    // Use between() for each audio range, sum > 0 means audio is active
    const enableParts = options.audioClipRanges.map((r) => {
      const startSec = r.startMs / 1000;
      const endSec = r.endMs / 1000;
      return `between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})`;
    });
    // volume = if(any_range_active, 1, 0)
    const enableExpr = enableParts.join('+');
    filterParts.push(`[outa]volume=if(${enableExpr}\\,1\\,0):eval=frame[finala]`);
    audioLabel = '[finala]';
  }

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[finalv]', '-map', audioLabel);

  // Encoding. Two paths:
  //
  // h264 (default): libx264 8-bit yuv420p with NO explicit color tagging — we
  //   let libx264 inherit the source's color metadata so QuickTime / iOS still
  //   render the export with the same tone-mapping path they use for the
  //   camera-original (otherwise they treat it as plain SDR BT.709 and skip
  //   tone-mapping entirely → washed look).
  //
  // h265: libx265 10-bit yuv420p10le with explicit HLG/BT.2020 tags. Required
  //   when source is HDR (e.g. iPhone HEVC HLG) and we want the export to
  //   match the original visually in QuickTime — H.264 cannot carry the
  //   bit-depth or wide-gamut metadata needed for accurate HDR playback,
  //   HEVC + HLG tags can. Output is still playable in any modern player and
  //   accepted by YouTube uploads.
  const codec = options.codec ?? 'h264';
  if (codec === 'h265') {
    args.push(
      '-c:v', 'libx265',
      '-preset', 'medium',
      '-crf', String(options.crf),
      '-r', String(options.fps),
      '-pix_fmt', 'yuv420p10le',
      '-tag:v', 'hvc1',
      // HDR (HLG) color tagging: keeps iPhone HLG content rendering identically
      // in QuickTime and other HDR-aware players.
      '-color_range', 'tv',
      '-colorspace', 'bt2020nc',
      '-color_primaries', 'bt2020',
      '-color_trc', 'arib-std-b67',
      // libx265-specific params for HDR signalling
      '-x265-params',
      'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited',
    );
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(options.crf),
      '-r', String(options.fps),
      '-pix_fmt', 'yuv420p',
    );
  }
  args.push(
    '-c:a', 'aac',
    '-b:a', options.audioBitrate,
    '-movflags', '+faststart',
    '-y', '-progress', 'pipe:1',
    options.outputPath,
  );

  console.log(`[ffmpeg-render-reel] ${ffmpeg} ${args.join(' ')}`);

  const proc = execFile(ffmpeg, args, { maxBuffer: 1024 * 1024 * 64 });

  const promise = new Promise<void>((resolve, reject) => {
    let duration = 0;
    // Compute expected duration from clips
    const expectedDurSec = clips.reduce((sum, c) => sum + (c.sourceOutMs - c.sourceInMs) / 1000, 0);
    duration = expectedDurSec;

    let stderrLog = '';
    let stderrLineBuf = '';
    let lastProgressMs = Date.now();

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const us = parseInt(line.split('=')[1], 10);
          if (duration > 0 && options.onProgress) {
            const percent = Math.min(100, (us / 1_000_000 / duration) * 100);
            options.onProgress(percent);
          }
          lastProgressMs = Date.now();
        }
      }
    });

    // Stream stderr to the server log line-by-line so we can see in real time
    // what FFmpeg is doing. Without this we'd only see stderr at process close,
    // which never fires when FFmpeg hangs during init.
    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrLog += chunk;
      stderrLineBuf += chunk;
      let idx;
      while ((idx = stderrLineBuf.indexOf('\n')) !== -1) {
        const line = stderrLineBuf.slice(0, idx).trimEnd();
        stderrLineBuf = stderrLineBuf.slice(idx + 1);
        if (line) console.log(`[ffmpeg-render-reel] ${line}`);
      }
      // Reset the watchdog on any stderr too — FFmpeg prints lots of init text.
      lastProgressMs = Date.now();
    });

    // Watchdog: if no progress and no stderr for 90s, assume FFmpeg is hung
    // and kill it so the user sees a real error instead of waiting forever.
    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastProgressMs;
      if (idleMs > 90_000) {
        console.error(`[ffmpeg-render-reel] watchdog: no progress for ${Math.round(idleMs / 1000)}s, killing FFmpeg`);
        clearInterval(watchdog);
        proc.kill('SIGTERM');
        // Give it a moment to exit cleanly, then SIGKILL
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
      }
    }, 10_000);

    proc.on('close', (code) => {
      clearInterval(watchdog);
      // Flush any remaining buffered stderr
      if (stderrLineBuf.trim()) console.log(`[ffmpeg-render-reel] ${stderrLineBuf.trimEnd()}`);
      if (code === 0) resolve();
      else {
        const tail = stderrLog.slice(-1500);
        console.error(`[ffmpeg-render-reel] FFmpeg exited with code ${code}. stderr tail:\n${tail}`);
        reject(new Error(`FFmpeg reel render exited with code ${code}: ${tail.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
      }
    });

    proc.on('error', (err) => {
      clearInterval(watchdog);
      reject(err);
    });
  });

  return { promise, process: proc };
}

export async function mixAudio(
  inputs: { path: string; volume: number }[],
  outputPath: string,
  offsetMs?: number
): Promise<void> {
  const ffmpeg = getFFmpegPath();
  const args: string[] = [];

  for (const input of inputs) {
    args.push('-i', input.path);
  }

  // Build filter complex
  const filterParts: string[] = [];
  const mixInputs: string[] = [];

  inputs.forEach((input, i) => {
    let filterChain = `[${i}:a]volume=${input.volume}`;
    if (i > 0 && offsetMs) {
      filterChain += `,adelay=${offsetMs}|${offsetMs}`;
    }
    filterChain += `[a${i}]`;
    filterParts.push(filterChain);
    mixInputs.push(`[a${i}]`);
  });

  filterParts.push(`${mixInputs.join('')}amix=inputs=${inputs.length}:duration=longest[out]`);

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[out]');
  args.push('-acodec', 'pcm_s16le', '-ar', '48000', '-y', outputPath);

  await execFileAsync(ffmpeg, args, { timeout: 600000 });
}
