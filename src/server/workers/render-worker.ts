import path from 'path';
import fs from 'fs/promises';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { renderVideo, renderReelVideo } from '@/server/ffmpeg-wrapper';
import { generateASS } from '@/server/ass-generator';
import type { ExportPreset, SubtitleStyle, SubtitleSegment, CropRegion, CompositionClip } from '@/types/project';

const BASE_HEIGHT = 1080;

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
  targetType?: 'youtube' | 'reel';
  reelId?: string;
}

const RENDER_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours max

/**
 * Remap subtitle segments from timeline-relative time to concatenated-output time.
 * When we concat clips, the output timeline is: clip0_duration + clip1_duration + ...
 * We need to map subtitle times from the original timeline positions to this new timeline.
 */
function remapSubtitlesToClips(segments: SubtitleSegment[], clips: CompositionClip[]): SubtitleSegment[] {
  if (clips.length === 0) return [];

  // Build mapping: for each clip, compute its output start time
  let outputOffset = 0;
  const clipMap = clips.map((c) => {
    const entry = {
      timelineStart: c.timelineStartMs,
      timelineEnd: c.timelineEndMs,
      outputStart: outputOffset,
      duration: c.timelineEndMs - c.timelineStartMs,
    };
    outputOffset += entry.duration;
    return entry;
  });

  const result: SubtitleSegment[] = [];
  for (const seg of segments) {
    // Find which clip(s) this segment overlaps
    for (const cm of clipMap) {
      const overlapStart = Math.max(seg.startMs, cm.timelineStart);
      const overlapEnd = Math.min(seg.endMs, cm.timelineEnd);
      if (overlapStart < overlapEnd) {
        // This segment is (partially) within this clip
        const outStart = cm.outputStart + (overlapStart - cm.timelineStart);
        const outEnd = cm.outputStart + (overlapEnd - cm.timelineStart);
        result.push({
          ...seg,
          id: seg.id + '_' + cm.outputStart,
          startMs: outStart,
          endMs: outEnd,
          words: seg.words?.filter((w) => w.startMs >= overlapStart && w.endMs <= overlapEnd)
            .map((w) => ({
              ...w,
              startMs: cm.outputStart + (w.startMs - cm.timelineStart),
              endMs: cm.outputStart + (w.endMs - cm.timelineStart),
            })),
        });
      }
    }
  }
  return result;
}

function shiftSegments(segments: SubtitleSegment[], offsetMs: number, endMs: number): SubtitleSegment[] {
  return segments
    .filter((seg) => seg.endMs > offsetMs && seg.startMs < endMs)
    .map((seg) => ({
      ...seg,
      startMs: Math.max(0, seg.startMs - offsetMs),
      endMs: seg.endMs - offsetMs,
      words: seg.words?.map((w) => ({
        ...w,
        startMs: Math.max(0, w.startMs - offsetMs),
        endMs: w.endMs - offsetMs,
      })),
    }));
}

export async function startRender(options: RenderOptions): Promise<void> {
  const {
    projectId, jobId, exportId, preset,
    includeSubtitles = true, trimInMs, trimOutMs,
    targetType = 'youtube', reelId,
  } = options;

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

  // Find audio
  const audioDir = getProjectDir(projectId, 'audio');
  const selectedAudio = project.sync.selectedAudioPath;
  const audioSrc = selectedAudio
    ? (selectedAudio.includes('/') ? selectedAudio : path.join(audioDir, selectedAudio))
    : project.sync.mixedAudioPath
    || (project.audio.extractedTracks[0]?.path);

  const fontsDirPath = path.resolve(process.cwd(), 'fonts');
  const sourceWidth = videoSource?.resolution?.width;
  const sourceHeight = videoSource?.resolution?.height;

  // Determine segments, style, crop, and trim based on target type
  let subtitleStyle: SubtitleStyle | undefined;
  let segments: SubtitleSegment[] = [];
  let cropRegion: CropRegion | undefined;
  let trimStartMs: number | undefined;
  let trimEndMs: number | undefined;
  let segmentsAlreadyShifted = false;

  if (targetType === 'reel' && reelId) {
    // Reel export — uses composition clips for timeline edits
    const reel = project.reels.find((r) => r.id === reelId);
    if (!reel) {
      jobManager.failJob(jobId, `Reel ${reelId} not found`);
      return;
    }
    subtitleStyle = reel.subtitleStyle;
    cropRegion = reel.cropRegion;

    // Get video clips from rv1 track, sorted by timeline position
    const videoClips = reel.composition.clips
      .filter((c) => c.trackId === 'rv1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

    if (videoClips.length > 0) {
      // Reel has timeline edits — use clip-based rendering
      console.log(`[render] Reel export with ${videoClips.length} video clip(s):`,
        videoClips.map((c) => `[${c.sourceInMs}-${c.sourceOutMs}ms]`).join(', '));
      console.log(`[render] Reel has ${reel.subtitleSegments.length} subtitle segments, includeSubtitles=${includeSubtitles}, hasStyle=${!!subtitleStyle}`);

      // Subtitle segments are already in timeline-relative time (0-based)
      // We need to remap them to match the concatenated clips output
      const remappedSegments = remapSubtitlesToClips(reel.subtitleSegments, videoClips);
      console.log(`[render] Remapped ${remappedSegments.length} subtitle segments for concat output`);

      // Generate ASS for the concatenated output
      let assFilePath2: string | undefined;
      if (includeSubtitles && remappedSegments.length > 0 && subtitleStyle) {
        const scaledStyle = scaleStyleForOutput(subtitleStyle, preset.height);
        const assContent = generateASS(remappedSegments, scaledStyle, preset.fps, preset.width, preset.height);
        assFilePath2 = path.join(exportDir, `subs_${exportId}.ass`);
        await fs.writeFile(assFilePath2, assContent, 'utf-8');
        const debugAssPath = path.join(exportDir, `debug_subs_${preset.id}.ass`);
        await fs.writeFile(debugAssPath, assContent, 'utf-8');
        console.log(`[render] ASS debug: ${debugAssPath}`);
      }

      jobManager.updateProgress(jobId, 2, 'Starting FFmpeg render...');

      const { promise: reelPromise, process: reelProc } = renderReelVideo({
        videoInputPath: videoSrc,
        audioInputPath: audioSrc,
        clips: videoClips,
        assFilePath: assFilePath2,
        fontsDirPath,
        outputPath,
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
        crf: preset.crf,
        audioBitrate: preset.audioBitrate,
        cropRegion,
        sourceWidth,
        sourceHeight,
        onProgress: (percent) => {
          jobManager.updateProgress(jobId, 2 + percent * 0.96, `Rendering... ${Math.round(percent)}%`);
        },
      });

      jobManager.setProcess(jobId, reelProc);

      const timeout = setTimeout(() => {
        const job = jobManager.getJob(jobId);
        if (job && job.status === 'running') {
          reelProc.kill('SIGTERM');
          jobManager.failJob(jobId, 'Render timed out (2h limit)');
        }
      }, RENDER_TIMEOUT_MS);

      reelPromise
        .then(async () => {
          clearTimeout(timeout);
          const currentProject = await getProject(projectId);
          if (currentProject) {
            const exports = currentProject.exports.map((e) =>
              e.id === exportId
                ? { ...e, status: 'done' as const, outputPath, completedAt: new Date().toISOString(), progress: 100 }
                : e
            );
            await updateProject(projectId, { exports });
          }
          jobManager.completeJob(jobId, { outputPath });
        })
        .catch((err) => {
          clearTimeout(timeout);
          console.error(`[render] Reel render failed:`, err);
          const job = jobManager.getJob(jobId);
          if (job && job.status === 'running') {
            jobManager.failJob(jobId, `Render failed: ${(err as Error).message}`);
          }
        })
        .finally(async () => {
          if (assFilePath2) {
            try { await fs.unlink(assFilePath2); } catch { /* ignore */ }
          }
        });
      return; // Early return — reel rendering is handled separately
    }

    // Fallback: no clips, use simple trim (reel.startMs to reel.endMs)
    segments = reel.subtitleSegments; // Already 0-based, don't shift again
    segmentsAlreadyShifted = true;
    trimStartMs = reel.startMs;
    trimEndMs = reel.endMs;
  } else {
    // YouTube export
    subtitleStyle = project.youtubeSubtitles?.style;
    segments = project.youtubeSubtitles?.segments ?? project.transcription.segments;

    // Apply user-specified trim
    const durationSec = videoSource?.duration
      || project.audio.extractedTracks[0]?.duration
      || 0;
    if (trimInMs !== undefined && trimOutMs !== undefined && (trimInMs > 0 || trimOutMs < durationSec * 1000)) {
      trimStartMs = trimInMs;
      trimEndMs = trimOutMs;
    }
  }

  // Generate ASS subtitle file
  let assFilePath: string | undefined;
  if (includeSubtitles && segments.length > 0 && subtitleStyle) {
    const scaledStyle = scaleStyleForOutput(subtitleStyle, preset.height);

    // Shift segment timestamps when trimming (skip for reel — already 0-based)
    let shiftedSegments = segments;
    if (!segmentsAlreadyShifted && trimStartMs != null && trimEndMs != null) {
      shiftedSegments = shiftSegments(segments, trimStartMs, trimEndMs);
    }

    const assContent = generateASS(
      shiftedSegments,
      scaledStyle,
      preset.fps,
      preset.width,
      preset.height,
    );
    assFilePath = path.join(exportDir, `subs_${exportId}.ass`);
    await fs.writeFile(assFilePath, assContent, 'utf-8');
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
    cropRegion,
    sourceWidth,
    sourceHeight,
    onProgress: (percent) => {
      jobManager.updateProgress(jobId, 2 + percent * 0.96, `Rendering... ${Math.round(percent)}%`);
    },
  });

  jobManager.setProcess(jobId, proc);

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
      if (assFilePath) {
        try { await fs.unlink(assFilePath); } catch { /* ignore */ }
      }
    });
}
