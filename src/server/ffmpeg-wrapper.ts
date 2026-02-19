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
      const match = data.toString().match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (match) {
        duration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
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

  // Video filter chain: scale → pad → ass (subtitles applied after scaling)
  const filters: string[] = [];
  filters.push(
    `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease`,
    `pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2`
  );

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

  // Video codec
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
      else reject(new Error(`FFmpeg render exited with code ${code}`));
    });

    proc.on('error', reject);
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
