import path from 'path';
import fs from 'fs/promises';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { renderVideo } from '@/server/ffmpeg-wrapper';
import { generateASS } from '@/server/ass-generator';
import type { ExportPreset, SubtitleStyle } from '@/types/project';

const BASE_HEIGHT = 1080;

/**
 * Scale all pixel-based style properties to match the output resolution.
 * Styles are authored at 1080p — this multiplies every pixel value by
 * outputHeight / 1080 so the ASS file is fully pre-computed for the
 * target resolution (no libass scaling needed).
 */
function scaleStyleForOutput(style: SubtitleStyle, outputHeight: number): SubtitleStyle {
  const s = outputHeight / BASE_HEIGHT;
  if (s === 1) return style;
  return {
    ...style,
    fontSize: Math.round(style.fontSize * s),
    strokeWidth: Math.round(style.strokeWidth * s * 10) / 10,
    maxWidth: Math.round(style.maxWidth * s),
    marginBottom: Math.round(style.marginBottom * s),
    backgroundPadding: Math.round(style.backgroundPadding * s),
    shadowBlur: Math.round(style.shadowBlur * s),
    shadowOffsetX: Math.round(style.shadowOffsetX * s),
    shadowOffsetY: Math.round(style.shadowOffsetY * s),
  };
}

export interface RenderOptions {
  projectId: string;
  jobId: string;
  exportId: string;
  preset: ExportPreset;
  includeSubtitles?: boolean;
  trimInMs?: number;
  trimOutMs?: number;
}

const RENDER_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours max

export async function startRender(options: RenderOptions): Promise<void> {
  const { projectId, jobId, exportId, preset, includeSubtitles = true, trimInMs, trimOutMs } = options;

  const project = await getProject(projectId);
  if (!project) {
    jobManager.failJob(jobId, 'Project not found');
    return;
  }

  const exportDir = getProjectDir(projectId, 'export');
  const outputPath = path.join(exportDir, `${preset.id}_${Date.now()}.mp4`);

  // Find video source
  const videoSource = project.sources.find((s) => s.type === 'video');
  const videoSrc = videoSource
    ? path.join(getProjectDir(projectId, 'source'), videoSource.storedName)
    : undefined;

  if (!videoSrc) {
    jobManager.failJob(jobId, 'No video source found');
    return;
  }

  // Find audio (same priority as transcription)
  const audioDir = getProjectDir(projectId, 'audio');
  const selectedAudio = project.sync.selectedAudioPath;
  const audioSrc = selectedAudio
    ? (selectedAudio.includes('/') ? selectedAudio : path.join(audioDir, selectedAudio))
    : project.sync.mixedAudioPath
    || (project.audio.extractedTracks[0]?.path);

  const fontsDirPath = path.resolve(process.cwd(), 'fonts');

  // Compute trim parameters — only apply if range differs from full duration
  const durationSec = videoSource?.duration
    || project.audio.extractedTracks[0]?.duration
    || 0;
  let trimStartMs: number | undefined;
  let trimEndMs: number | undefined;
  if (trimInMs !== undefined && trimOutMs !== undefined && (trimInMs > 0 || trimOutMs < durationSec * 1000)) {
    trimStartMs = trimInMs;
    trimEndMs = trimOutMs;
  }

  // Generate ASS subtitle file if needed
  let assFilePath: string | undefined;
  if (includeSubtitles && project.transcription.segments.length > 0 && project.transcription.style) {
    // Scale all pixel-based style values to the output resolution.
    // PlayRes in the ASS will match the output dimensions exactly,
    // so libass renders at scale=1 — no auto-scaling ambiguity.
    const scaledStyle = scaleStyleForOutput(project.transcription.style, preset.height);

    // When trimming, filter segments to the trim range and shift timestamps
    // so they start at 0 (FFmpeg -ss makes the output timeline start at 0)
    let segments = project.transcription.segments;
    if (trimStartMs != null && trimEndMs != null) {
      const offset = trimStartMs;
      segments = segments
        .filter((seg) => seg.endMs > offset && seg.startMs < trimEndMs!)
        .map((seg) => ({
          ...seg,
          startMs: Math.max(0, seg.startMs - offset),
          endMs: seg.endMs - offset,
          words: seg.words?.map((w) => ({
            ...w,
            startMs: Math.max(0, w.startMs - offset),
            endMs: w.endMs - offset,
          })),
        }));
    }

    const assContent = generateASS(
      segments,
      scaledStyle,
      preset.fps,
      preset.width,
      preset.height,
    );
    assFilePath = path.join(exportDir, `subs_${exportId}.ass`);
    await fs.writeFile(assFilePath, assContent, 'utf-8');
    // Debug: also write a persistent copy so we can inspect the ASS content
    const debugAssPath = path.join(exportDir, `debug_subs_${preset.id}.ass`);
    await fs.writeFile(debugAssPath, assContent, 'utf-8');
    console.log(`[render] ASS debug copy: ${debugAssPath} (PlayRes ${preset.width}x${preset.height}, fontSize=${scaledStyle.fontSize})`);

  }

  jobManager.updateProgress(jobId, 2, 'Starting FFmpeg render...');

  const { promise, process: proc } = renderVideo({
    videoInputPath: videoSrc,
    audioInputPath: audioSrc,
    assFilePath,
    fontsDirPath,
    outputPath,
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    crf: preset.crf,
    audioBitrate: preset.audioBitrate,
    trimStartMs,
    trimEndMs,
    onProgress: (percent) => {
      jobManager.updateProgress(jobId, 2 + percent * 0.96, `Rendering... ${Math.round(percent)}%`);
    },
  });

  jobManager.setProcess(jobId, proc);

  // Timeout: fail the job if render takes too long
  const timeout = setTimeout(() => {
    const job = jobManager.getJob(jobId);
    if (job && job.status === 'running') {
      proc.kill('SIGTERM');
      jobManager.failJob(jobId, 'Render timed out (2h limit)');
    }
  }, RENDER_TIMEOUT_MS);

  promise
    .then(async () => {
      clearTimeout(timeout);
      const currentProject = await getProject(projectId);
      if (currentProject) {
        const exports = currentProject.exports.map((e) =>
          e.id === exportId
            ? {
                ...e,
                status: 'done' as const,
                outputPath,
                completedAt: new Date().toISOString(),
                progress: 100,
              }
            : e
        );
        await updateProject(projectId, { exports });
      }
      jobManager.completeJob(jobId, { outputPath });
    })
    .catch((err) => {
      clearTimeout(timeout);
      const job = jobManager.getJob(jobId);
      if (job && job.status === 'running') {
        jobManager.failJob(jobId, `Render failed: ${(err as Error).message}`);
      }
    })
    .finally(async () => {
      // Clean up temporary ASS file
      if (assFilePath) {
        try {
          await fs.unlink(assFilePath);
        } catch {
          // Ignore
        }
      }
    });
}
