import path from 'path';
import fs from 'fs/promises';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { renderVideo, renderReelVideo, type ImageOverlayInput } from '@/server/ffmpeg-wrapper';
import { generateASS } from '@/server/ass-generator';
import type { ASSTextOverlay } from '@/server/ass-generator';
import type { ExportPreset, SubtitleStyle, SubtitleSegment, CropRegion, CompositionClip } from '@/types/project';

/**
 * Subtitle styles are designed at 1080px width base (the "design canvas").
 * For vertical 1080x1920: output width = 1080 → scale = 1 (no scaling).
 * For horizontal 1920x1080: output width = 1920 → scale = 1.78 (scales up).
 * For 4K 3840x2160: output width = 3840 → scale = 3.56 (scales up).
 */
const BASE_WIDTH = 1080;

function scaleStyleForOutput(style: SubtitleStyle, outputWidth: number): SubtitleStyle {
  const s = outputWidth / BASE_WIDTH;
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
        // Remap words: include any word that overlaps with the clip range
        let remappedWords = seg.words
          ?.filter((w) => w.startMs < overlapEnd + 50 && w.endMs > overlapStart - 50)
          .map((w) => ({
            ...w,
            startMs: Math.max(outStart, cm.outputStart + (w.startMs - cm.timelineStart)),
            endMs: Math.min(outEnd, cm.outputStart + (w.endMs - cm.timelineStart)),
          }));

        // If all words were filtered out but original had words (possibly with styles),
        // the word timing is corrupted (outside segment range). Redistribute words
        // within the segment timing to preserve per-word styles.
        if ((!remappedWords || remappedWords.length === 0) && seg.words && seg.words.length > 0) {
          const segDur = outEnd - outStart;
          const wc = seg.words.length;
          remappedWords = seg.words.map((w, i) => ({
            ...w,
            startMs: outStart + Math.round(i * segDur / wc),
            endMs: outStart + Math.round((i + 1) * segDur / wc),
          }));
        }

        result.push({
          ...seg,
          id: seg.id + '_' + cm.outputStart,
          startMs: outStart,
          endMs: outEnd,
          words: remappedWords,
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

      // Extract text overlay clips and remap to concat output timeline
      const textClips = reel.composition.clips
        .filter((c) => c.type === 'text' && c.textContent)
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

      let assTextOverlays: ASSTextOverlay[] | undefined;
      if (textClips.length > 0) {
        let concatOffset = 0;
        const clipTimeMap = videoClips.map((vc) => {
          const entry = {
            timelineStart: vc.timelineStartMs,
            timelineEnd: vc.timelineEndMs,
            outputStart: concatOffset,
          };
          concatOffset += vc.timelineEndMs - vc.timelineStartMs;
          return entry;
        });

        assTextOverlays = [];
        const scale = preset.width / BASE_WIDTH;
        for (const tc of textClips) {
          for (const cm of clipTimeMap) {
            const overlapStart = Math.max(tc.timelineStartMs, cm.timelineStart);
            const overlapEnd = Math.min(tc.timelineEndMs, cm.timelineEnd);
            if (overlapStart < overlapEnd) {
              const outStart = cm.outputStart + (overlapStart - cm.timelineStart);
              const outEnd = cm.outputStart + (overlapEnd - cm.timelineStart);
              assTextOverlays.push({
                text: tc.textContent!,
                startMs: outStart,
                endMs: outEnd,
                x: tc.overlayPosition?.x ?? 0.5,
                y: tc.overlayPosition?.y ?? 0.5,
                width: tc.overlayPosition?.width ?? 0.8,
                fontSize: Math.round((tc.textStyle?.fontSize ?? 40) * scale),
                fontFamily: tc.textStyle?.fontFamily ?? 'Inter',
                fontWeight: tc.textStyle?.fontWeight ?? 400,
                color: tc.textStyle?.color ?? '#ffffff',
                backgroundColor: tc.textStyle?.backgroundColor,
                shadowX: tc.textStyle?.shadowX,
                shadowY: tc.textStyle?.shadowY,
                shadowBlur: tc.textStyle?.shadowBlur,
                shadowColor: tc.textStyle?.shadowColor,
                lineHeight: tc.textStyle?.lineHeight,
              });
            }
          }
        }
        console.log(`[render] ${assTextOverlays.length} text overlay(s) for ASS export`);
      }

      // Generate ASS for the concatenated output (subtitles + text overlays)
      let assFilePath2: string | undefined;
      const hasSubtitles = includeSubtitles && remappedSegments.length > 0 && subtitleStyle;
      const hasTextOverlays = assTextOverlays && assTextOverlays.length > 0;
      if (hasSubtitles || hasTextOverlays) {
        const scaledStyle = subtitleStyle
          ? scaleStyleForOutput(subtitleStyle, preset.width)
          : scaleStyleForOutput(reel.subtitleStyle, preset.width);
        const segs = hasSubtitles ? remappedSegments : [];
        const assContent = generateASS(segs, scaledStyle, preset.fps, preset.width, preset.height, assTextOverlays);
        assFilePath2 = path.join(exportDir, `subs_${exportId}.ass`);
        await fs.writeFile(assFilePath2, assContent, 'utf-8');
        const debugAssPath = path.join(exportDir, `debug_subs_${preset.id}.ass`);
        await fs.writeFile(debugAssPath, assContent, 'utf-8');
        console.log(`[render] ASS debug: ${debugAssPath}`);
      }

      // Compute audio clip ranges remapped to concat output timeline
      // This allows muting audio during gaps where audio clips were removed
      const audioClips = reel.composition.clips
        .filter((c) => c.trackId === 'ra1' || c.trackId === 'ra2')
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

      let audioClipRanges: { startMs: number; endMs: number }[] | undefined;
      if (audioClips.length > 0) {
        // Build same clipTimeMap as for text overlays
        let concatOff = 0;
        const vcTimeMap = videoClips.map((vc) => {
          const entry = {
            timelineStart: vc.timelineStartMs,
            timelineEnd: vc.timelineEndMs,
            outputStart: concatOff,
          };
          concatOff += vc.timelineEndMs - vc.timelineStartMs;
          return entry;
        });

        audioClipRanges = [];
        for (const ac of audioClips) {
          for (const cm of vcTimeMap) {
            const overlapStart = Math.max(ac.timelineStartMs, cm.timelineStart);
            const overlapEnd = Math.min(ac.timelineEndMs, cm.timelineEnd);
            if (overlapStart < overlapEnd) {
              audioClipRanges.push({
                startMs: cm.outputStart + (overlapStart - cm.timelineStart),
                endMs: cm.outputStart + (overlapEnd - cm.timelineStart),
              });
            }
          }
        }

        // Check if audio covers the full video duration — if so, no gaps to mute
        const totalConcatMs = concatOff;
        const totalAudioMs = audioClipRanges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
        if (totalAudioMs >= totalConcatMs - 100) {
          audioClipRanges = undefined; // No gaps, skip the volume filter
        } else {
          console.log(`[render] Audio has gaps: ${audioClipRanges.length} range(s) covering ${totalAudioMs}ms of ${totalConcatMs}ms`);
        }
      }

      // Extract image/gif overlay clips and remap to concat output timeline
      const imageGifClips = reel.composition.clips
        .filter((c) => (c.type === 'image' || c.type === 'gif') && c.fileName)
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

      let imageOverlays: ImageOverlayInput[] | undefined;
      if (imageGifClips.length > 0) {
        let concatOff2 = 0;
        const vcTimeMap2 = videoClips.map((vc) => {
          const entry = {
            timelineStart: vc.timelineStartMs,
            timelineEnd: vc.timelineEndMs,
            outputStart: concatOff2,
          };
          concatOff2 += vc.timelineEndMs - vc.timelineStartMs;
          return entry;
        });

        imageOverlays = [];
        const projectDir = getProjectDir(projectId);
        for (const ic of imageGifClips) {
          for (const cm of vcTimeMap2) {
            const overlapStart = Math.max(ic.timelineStartMs, cm.timelineStart);
            const overlapEnd = Math.min(ic.timelineEndMs, cm.timelineEnd);
            if (overlapStart < overlapEnd) {
              const filePath = path.join(projectDir, ic.fileName!);
              imageOverlays.push({
                filePath,
                startMs: cm.outputStart + (overlapStart - cm.timelineStart),
                endMs: cm.outputStart + (overlapEnd - cm.timelineStart),
                x: ic.overlayPosition?.x ?? 0.5,
                y: ic.overlayPosition?.y ?? 0.5,
                width: ic.overlayPosition?.width ?? 0.8,
                opacity: ic.opacity ?? 1,
              });
            }
          }
        }
        console.log(`[render] ${imageOverlays.length} image overlay(s) for FFmpeg export`);
        if (imageOverlays.length === 0) imageOverlays = undefined;
      }

      jobManager.updateProgress(jobId, 2, 'Starting FFmpeg render...');

      const { promise: reelPromise, process: reelProc } = renderReelVideo({
        videoInputPath: videoSrc,
        audioInputPath: audioSrc,
        clips: videoClips,
        audioClipRanges,
        imageOverlays,
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

    // Check for compose timeline clips on v1 track
    const composeVideoClips = (project.composition?.clips ?? [])
      .filter((c: CompositionClip) => c.trackId === 'v1')
      .sort((a: CompositionClip, b: CompositionClip) => a.timelineStartMs - b.timelineStartMs);

    if (composeVideoClips.length > 0) {
      // ---- COMPOSE-BASED YOUTUBE EXPORT ----
      console.log(`[render] YouTube compose export with ${composeVideoClips.length} video clip(s):`,
        composeVideoClips.map((c: CompositionClip) => `[${c.sourceInMs}-${c.sourceOutMs}ms]`).join(', '));

      // Apply trim range to compose clips (trim operates on compose timeline)
      let videoClips = composeVideoClips;
      if (trimInMs !== undefined && trimOutMs !== undefined && (trimInMs > 0 || trimOutMs < Math.max(...composeVideoClips.map((c: CompositionClip) => c.timelineEndMs)))) {
        videoClips = composeVideoClips
          .filter((c: CompositionClip) => c.timelineEndMs > trimInMs && c.timelineStartMs < trimOutMs)
          .map((c: CompositionClip) => ({
            ...c,
            sourceInMs: c.sourceInMs + Math.max(0, trimInMs - c.timelineStartMs),
            sourceOutMs: c.sourceOutMs - Math.max(0, c.timelineEndMs - trimOutMs),
            timelineStartMs: Math.max(c.timelineStartMs, trimInMs) - trimInMs,
            timelineEndMs: Math.min(c.timelineEndMs, trimOutMs) - trimInMs,
          }));
        console.log(`[render] After trim [${trimInMs}-${trimOutMs}]: ${videoClips.length} clip(s)`);
      }

      if (videoClips.length === 0) {
        jobManager.failJob(jobId, 'No video clips within trim range');
        return;
      }

      // Use muxed video as source if available (has synced audio+video)
      // Check export dir first, then compose dir for muxed files
      let composeVideoSrc = videoSrc;
      let composeAudioSrc = audioSrc;

      const exportDirFiles = await fs.readdir(exportDir).catch(() => [] as string[]);
      const composeDirPath = getProjectDir(projectId, 'compose');
      const composeDirFiles = await fs.readdir(composeDirPath).catch(() => [] as string[]);

      const muxedFile = exportDirFiles.find((f) => f.startsWith('muxed_') && f.endsWith('.mp4'))
        || composeDirFiles.find((f) => f.startsWith('muxed_') && f.endsWith('.mp4'));
      if (muxedFile) {
        const muxedPath = exportDirFiles.includes(muxedFile)
          ? path.join(exportDir, muxedFile)
          : path.join(composeDirPath, muxedFile);
        composeVideoSrc = muxedPath;
        console.log(`[render] Using muxed video: ${muxedPath}`);
      }

      const mixFile = composeDirFiles.find((f) => f.startsWith('mix_'))
        || exportDirFiles.find((f) => f.startsWith('mix_'));
      if (mixFile) {
        const mixPath = composeDirFiles.includes(mixFile)
          ? path.join(composeDirPath, mixFile)
          : path.join(exportDir, mixFile);
        composeAudioSrc = mixPath;
        console.log(`[render] Using mix audio: ${mixPath}`);
      }

      // Remap subtitles to concatenated clips output
      const remappedSegments = remapSubtitlesToClips(segments, videoClips);
      console.log(`[render] Remapped ${remappedSegments.length} subtitle segments for compose concat`);

      // Extract text overlay clips from compose
      const textClips = (project.composition?.clips ?? [])
        .filter((c: CompositionClip) => c.type === 'text' && c.textContent)
        .sort((a: CompositionClip, b: CompositionClip) => a.timelineStartMs - b.timelineStartMs);

      let assTextOverlays: ASSTextOverlay[] | undefined;
      if (textClips.length > 0) {
        let concatOffset = 0;
        const clipTimeMap = videoClips.map((vc: CompositionClip) => {
          const entry = {
            timelineStart: vc.timelineStartMs,
            timelineEnd: vc.timelineEndMs,
            outputStart: concatOffset,
          };
          concatOffset += vc.timelineEndMs - vc.timelineStartMs;
          return entry;
        });

        assTextOverlays = [];
        const scale = preset.width / BASE_WIDTH;
        for (const tc of textClips) {
          for (const cm of clipTimeMap) {
            const overlapStart = Math.max(tc.timelineStartMs, cm.timelineStart);
            const overlapEnd = Math.min(tc.timelineEndMs, cm.timelineEnd);
            if (overlapStart < overlapEnd) {
              const outStart = cm.outputStart + (overlapStart - cm.timelineStart);
              const outEnd = cm.outputStart + (overlapEnd - cm.timelineStart);
              assTextOverlays.push({
                text: tc.textContent!,
                startMs: outStart,
                endMs: outEnd,
                x: tc.overlayPosition?.x ?? 0.5,
                y: tc.overlayPosition?.y ?? 0.5,
                width: tc.overlayPosition?.width ?? 0.8,
                fontSize: Math.round((tc.textStyle?.fontSize ?? 40) * scale),
                fontFamily: tc.textStyle?.fontFamily ?? 'Inter',
                fontWeight: tc.textStyle?.fontWeight ?? 400,
                color: tc.textStyle?.color ?? '#ffffff',
                backgroundColor: tc.textStyle?.backgroundColor,
                shadowX: tc.textStyle?.shadowX,
                shadowY: tc.textStyle?.shadowY,
                shadowBlur: tc.textStyle?.shadowBlur,
                shadowColor: tc.textStyle?.shadowColor,
                lineHeight: tc.textStyle?.lineHeight,
              });
            }
          }
        }
      }

      // Audio gap muting from a1 clips
      const composeAudioClips = (project.composition?.clips ?? [])
        .filter((c: CompositionClip) => c.trackId === 'a1' || c.trackId === 'a2')
        .sort((a: CompositionClip, b: CompositionClip) => a.timelineStartMs - b.timelineStartMs);

      let audioClipRanges: { startMs: number; endMs: number }[] | undefined;
      if (composeAudioClips.length > 0) {
        let concatOff = 0;
        const vcTimeMap = videoClips.map((vc: CompositionClip) => {
          const entry = {
            timelineStart: vc.timelineStartMs,
            timelineEnd: vc.timelineEndMs,
            outputStart: concatOff,
          };
          concatOff += vc.timelineEndMs - vc.timelineStartMs;
          return entry;
        });

        audioClipRanges = [];
        for (const ac of composeAudioClips) {
          for (const cm of vcTimeMap) {
            const overlapStart = Math.max(ac.timelineStartMs, cm.timelineStart);
            const overlapEnd = Math.min(ac.timelineEndMs, cm.timelineEnd);
            if (overlapStart < overlapEnd) {
              audioClipRanges.push({
                startMs: cm.outputStart + (overlapStart - cm.timelineStart),
                endMs: cm.outputStart + (overlapEnd - cm.timelineStart),
              });
            }
          }
        }

        const totalConcatMs = concatOff;
        const totalAudioMs = audioClipRanges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
        if (totalAudioMs >= totalConcatMs - 100) {
          audioClipRanges = undefined;
        }
      }

      // Extract image/gif overlays from compose
      const imageGifClips = (project.composition?.clips ?? [])
        .filter((c: CompositionClip) => (c.type === 'image' || c.type === 'gif') && c.fileName)
        .sort((a: CompositionClip, b: CompositionClip) => a.timelineStartMs - b.timelineStartMs);

      let imageOverlays: ImageOverlayInput[] | undefined;
      if (imageGifClips.length > 0) {
        let concatOff2 = 0;
        const vcTimeMap2 = videoClips.map((vc: CompositionClip) => {
          const entry = {
            timelineStart: vc.timelineStartMs,
            timelineEnd: vc.timelineEndMs,
            outputStart: concatOff2,
          };
          concatOff2 += vc.timelineEndMs - vc.timelineStartMs;
          return entry;
        });

        imageOverlays = [];
        const projectDir = getProjectDir(projectId);
        for (const ic of imageGifClips) {
          for (const cm of vcTimeMap2) {
            const overlapStart = Math.max(ic.timelineStartMs, cm.timelineStart);
            const overlapEnd = Math.min(ic.timelineEndMs, cm.timelineEnd);
            if (overlapStart < overlapEnd) {
              const filePath = path.join(projectDir, ic.fileName!);
              imageOverlays.push({
                filePath,
                startMs: cm.outputStart + (overlapStart - cm.timelineStart),
                endMs: cm.outputStart + (overlapEnd - cm.timelineStart),
                x: ic.overlayPosition?.x ?? 0.5,
                y: ic.overlayPosition?.y ?? 0.5,
                width: ic.overlayPosition?.width ?? 0.8,
                opacity: ic.opacity ?? 1,
              });
            }
          }
        }
        if (imageOverlays.length === 0) imageOverlays = undefined;
      }

      // Generate ASS subtitle file for compose export
      let composeAssFilePath: string | undefined;
      const hasSubtitles = includeSubtitles && remappedSegments.length > 0 && subtitleStyle;
      const hasTextOverlays = assTextOverlays && assTextOverlays.length > 0;
      if (hasSubtitles || hasTextOverlays) {
        const scaledStyle = scaleStyleForOutput(subtitleStyle!, preset.width);
        const segs = hasSubtitles ? remappedSegments : [];
        const assContent = generateASS(segs, scaledStyle, preset.fps, preset.width, preset.height, assTextOverlays);
        composeAssFilePath = path.join(exportDir, `subs_${exportId}.ass`);
        await fs.writeFile(composeAssFilePath, assContent, 'utf-8');
        const debugAssPath = path.join(exportDir, `debug_subs_${preset.id}.ass`);
        await fs.writeFile(debugAssPath, assContent, 'utf-8');
        console.log(`[render] YouTube compose ASS: ${debugAssPath}`);
      }

      jobManager.updateProgress(jobId, 2, 'Starting FFmpeg compose render...');

      const { promise: composePromise, process: composeProc } = renderReelVideo({
        videoInputPath: composeVideoSrc,
        audioInputPath: composeAudioSrc,
        clips: videoClips,
        audioClipRanges,
        imageOverlays,
        assFilePath: composeAssFilePath,
        fontsDirPath,
        outputPath,
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
        crf: preset.crf,
        audioBitrate: preset.audioBitrate,
        cropRegion: undefined, // YouTube exports don't crop
        sourceWidth,
        sourceHeight,
        onProgress: (percent) => {
          jobManager.updateProgress(jobId, 2 + percent * 0.96, `Rendering... ${Math.round(percent)}%`);
        },
      });

      jobManager.setProcess(jobId, composeProc);

      const composeTimeout = setTimeout(() => {
        const job = jobManager.getJob(jobId);
        if (job && job.status === 'running') {
          composeProc.kill('SIGTERM');
          jobManager.failJob(jobId, 'Render timed out (2h limit)');
        }
      }, RENDER_TIMEOUT_MS);

      composePromise
        .then(async () => {
          clearTimeout(composeTimeout);
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
          clearTimeout(composeTimeout);
          console.error(`[render] YouTube compose render failed:`, err);
          const job = jobManager.getJob(jobId);
          if (job && job.status === 'running') {
            jobManager.failJob(jobId, `Render failed: ${(err as Error).message}`);
          }
        })
        .finally(async () => {
          if (composeAssFilePath) {
            try { await fs.unlink(composeAssFilePath); } catch { /* ignore */ }
          }
        });
      return; // Early return — compose rendering handled separately
    }

    // Fallback: no compose clips, use simple trim
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
    const scaledStyle = scaleStyleForOutput(subtitleStyle, preset.width);

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
