'use client';

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useReelStore } from '@/stores/reel-store';
import { useProjectStore } from '@/stores/project-store';
import { setReelVideoElement } from './reel-video-ref';
import { ReelOverlayVideos } from './reel-overlay-videos';
import { ReelExtraAudio } from './reel-extra-audio';
import { cropAtTime, clampCropToFrame } from '@/lib/crop-keyframes';
import { Button } from '@/components/ui/button';
import { Play, Pause, Crosshair, RotateCcw, SkipBack, SkipForward, ChevronLeft, ChevronRight } from 'lucide-react';
import type { CompositionClip } from '@/types/project';

function formatTimeCode(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function parseTimeCode(str: string): number | null {
  const trimmed = str.trim();
  const colonMatch = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (colonMatch) {
    const mins = parseInt(colonMatch[1]);
    const secs = parseFloat(colonMatch[2]);
    if (isNaN(mins) || isNaN(secs) || secs >= 60) return null;
    return (mins * 60 + secs) * 1000;
  }
  const num = parseFloat(trimmed);
  if (!isNaN(num) && num >= 0) return num * 1000;
  return null;
}

function EditableTimeInput({
  ms,
  maxMs,
  onChange,
}: {
  ms: number;
  maxMs: number;
  onChange: (ms: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = useCallback(() => {
    setEditValue(formatTimeCode(ms));
    setEditing(true);
  }, [ms]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const handleConfirm = () => {
    const parsed = parseTimeCode(editValue);
    if (parsed !== null) {
      onChange(Math.max(0, Math.min(maxMs, parsed)));
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="bg-muted/50 border border-primary rounded px-1 text-xs font-mono outline-none text-center w-[5.5em]"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleConfirm}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleConfirm();
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className="font-mono text-xs cursor-text hover:bg-muted/40 rounded px-0.5 tabular-nums"
      onClick={handleStartEdit}
      title="Click to edit time"
    >
      {formatTimeCode(ms)}
    </span>
  );
}

interface ReelVideoPlayerProps {
  reelId: string;
  videoSrc?: string;
  audioSrc?: string;
  /** Constant offset (ms) between the muxed-video timeline and the separate
   * audio file's timeline. The mux step input-seeks the video to the keyframe
   * at-or-after the alignment target, so the muxed video's t=0 sits this many
   * ms ahead of the standalone aligned-audio t=0 (SyncState.muxedAudioOffsetMs).
   * When a separate <audio> element drives sound (video is muted), its
   * currentTime must lead video.currentTime by this amount, otherwise the voice
   * lags the mouth by ~1s. Only applied when a separate audio file is used; the
   * muxed's own embedded audio needs no offset. */
  audioOffsetMs?: number;
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | null;

/**
 * Map timeline ms → absolute source ms using video clips on rv1.
 * Returns null if no clip covers the given timelineMs (gap).
 */
function timelineToSourceMs(
  timelineMs: number,
  clips: CompositionClip[],
  reelStartMs: number
): number | null {
  // Get video clips on the main video track, sorted by timeline position
  const videoClips = clips
    .filter((c) => c.trackId === 'rv1')
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  if (videoClips.length === 0) {
    // No timeline clips — fallback to linear mapping
    return reelStartMs + timelineMs;
  }

  for (const clip of videoClips) {
    if (timelineMs >= clip.timelineStartMs && timelineMs < clip.timelineEndMs) {
      const offset = timelineMs - clip.timelineStartMs;
      return clip.sourceInMs + offset;
    }
  }

  return null; // In a gap
}


/**
 * Find the next clip that starts after the given timeline position.
 */
function findNextClipAfter(
  timelineMs: number,
  clips: CompositionClip[]
): CompositionClip | null {
  const videoClips = clips
    .filter((c) => c.trackId === 'rv1')
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  for (const clip of videoClips) {
    // Use >= to avoid cascading skips: when we just seeked to a clip boundary
    // and the video hasn't finished seeking yet, the gap handler fires again.
    // With strict >, it would skip the clip we just seeked to.
    if (clip.timelineStartMs >= timelineMs) {
      return clip;
    }
  }
  return null;
}

/**
 * Get the total timeline duration based on clips (max end of all clips).
 */
function getTimelineDuration(clips: CompositionClip[]): number {
  if (clips.length === 0) return 0;
  return Math.max(...clips.map((c) => c.timelineEndMs));
}

export function ReelVideoPlayer({ reelId, videoSrc, audioSrc, audioOffsetMs }: ReelVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  // Track the last time value set by the animation tick, so the seek effect
  // can distinguish tick-driven store updates from user-initiated seeks.
  const lastTickSetMsRef = useRef<number>(-Infinity);
  // Track the last gap-seek target to avoid re-issuing the same seek every frame
  // while waiting for the video element to complete its seek operation.
  const lastGapSeekSourceMsRef = useRef<number>(-Infinity);
  const dragStart = useRef({ x: 0, y: 0, cx: 0, cy: 0, scale: 0 });
  const [, setDragMode] = useState<DragMode>(null);

  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const sourceResolution = useReelStore((s) => s.sourceResolution);
  // Compose v1 clips — used in setup phase to inherit the per-clip transform
  // (zoom/position/rotation) so the reel preview already reflects the straighten
  // applied in compose, before the reel timeline clips are created.
  const composeClips = useProjectStore((s) => s.currentProject?.composition?.clips);
  const composeClipsRef = useRef<CompositionClip[] | undefined>(composeClips);
  composeClipsRef.current = composeClips;
  const isPlaying = useReelStore((s) => s.isPlaying);
  const setIsPlaying = useReelStore((s) => s.setIsPlaying);
  const setCurrentTime = useReelStore((s) => s.setCurrentTime);
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const updateCropRegion = useReelStore((s) => s.updateCropRegion);
  const phase = useReelStore((s) => s.phase);

  // Source times for video seeking — these point into the muxed video file
  // sourceStartMs/sourceEndMs are computed from compose clips at reel creation
  const srcStartMs = reel ? (reel.sourceStartMs ?? reel.startMs) : 0;
  const srcEndMs = reel ? (reel.sourceEndMs ?? reel.endMs) : 0;
  const startSec = srcStartMs / 1000;
  const endSec = srcEndMs / 1000;
  // Reel display duration uses compose times
  const reelDurationMs = reel ? (reel.endMs - reel.startMs) : 0;
  const isTimelinePhase = phase === 'timeline';

  // Setup-phase cut-honoring playback. When the reel's compose range spans
  // compose cuts (reel.sourceSegments present), the SETUP preview must skip the
  // removed source material instead of playing a single linear [srcStart,
  // srcEnd] span. We synthesise virtual rv1 clips from the stored segments and
  // drive them through the SAME segmented playback path as the timeline phase.
  // The trim bar + crop box are unaffected.
  const setupSegmentClips = useMemo<CompositionClip[]>(() => {
    const segs = reel?.sourceSegments;
    if (!segs || segs.length === 0) return [];
    let off = 0;
    return segs.map((s, i) => {
      const dur = Math.max(0, s.sourceOutMs - s.sourceInMs);
      const clip: CompositionClip = {
        id: `setupseg-${i}`, type: 'video', fileName: '', originalName: '',
        trackId: 'rv1', timelineStartMs: off, timelineEndMs: off + dur,
        sourceInMs: s.sourceInMs, sourceOutMs: s.sourceOutMs,
      };
      off += dur;
      return clip;
    });
  }, [reel?.sourceSegments]);
  const setupSegmentClipsRef = useRef<CompositionClip[]>(setupSegmentClips);
  setupSegmentClipsRef.current = setupSegmentClips;
  const setupSegmented = !isTimelinePhase && setupSegmentClips.length > 0;

  // When a separate audio file (not the muxed's embedded track) drives sound,
  // its currentTime must LEAD the muxed video's currentTime by the mux
  // keyframe-snap offset, or the voice lags the mouth by ~1s. See the prop doc.
  const needsSeparateAudio = !!(audioSrc && videoSrc !== audioSrc);
  const audioOffsetSec = needsSeparateAudio ? (audioOffsetMs ?? 0) / 1000 : 0;

  // Register video element for canvas capture by other components
  useEffect(() => {
    setReelVideoElement(videoRef.current);
    return () => setReelVideoElement(null);
  }, []);

  // Main Audio (ra1) mute — "mesa y ambiente como pistas separadas" silences
  // the baked mix so only the stem layers (ReelExtraAudio) sound. Applied
  // immediately here (the tick loop re-asserts it every frame while playing,
  // and restores the gap-gated volume when unmuted).
  const ra1Muted = !!reel?.composition.tracks.find((t) => t.id === 'ra1')?.muted;
  useEffect(() => {
    const el: HTMLMediaElement | null = audioRef.current ?? videoRef.current;
    if (!el) return;
    el.volume = ra1Muted ? 0 : 1;
  }, [ra1Muted]);

  // Sync audio element to video (audio leads video by audioOffsetSec)
  const syncAudio = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) return;
    const target = video.currentTime + audioOffsetSec;
    if (Math.abs(audio.currentTime - target) > 0.1) {
      audio.currentTime = target;
    }
  }, [audioOffsetSec]);

  // Play/pause sync
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return;

    if (isPlaying) {
      video.play().catch(() => {});
      if (audio) {
        audio.currentTime = video.currentTime + audioOffsetSec;
        audio.play().catch(() => {});
      }
    } else {
      video.pause();
      audio?.pause();
    }
  }, [isPlaying, audioOffsetSec]);

  // Time update loop
  useEffect(() => {
    if (!isPlaying || !reel) return;

    const tick = () => {
      const video = videoRef.current;
      if (!video) return;
      // Skip tick if video is still seeking or has an error — prevents seek loops
      if (video.seeking || video.error) {
        animFrameRef.current = requestAnimationFrame(tick);
        return;
      }
      const currentSec = video.currentTime;
      const currentSourceMs = currentSec * 1000;

      if (isTimelinePhase || setupSegmented) {
        // Segmented playback. Timeline phase uses the reel's real rv1 clips;
        // the setup phase of a cut-spanning reel uses the synthesised segment
        // clips so playback skips the removed material.
        //
        // IMPORTANT: we anchor on the ACTIVE clip (the one under the store
        // playhead) and advance in TIMELINE order — we never inverse-map the
        // video's source position against ALL clips. After a copy/paste or
        // ripple insert, two timeline clips share the same SOURCE range, so a
        // global source→timeline lookup is ambiguous: playback would jump
        // from the pasted piece to the original's timeline position.
        const freshReel = useReelStore.getState().reels.find((r) => r.id === reelId);
        const freshClips = isTimelinePhase
          ? (freshReel?.composition.clips ?? [])
          : setupSegmentClipsRef.current;

        const videoClips = freshClips
          .filter((c) => c.trackId === 'rv1')
          .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
        const totalDur = getTimelineDuration(freshClips);
        const storeTimeMs = useReelStore.getState().currentTimeMs;
        const active = videoClips.find(
          (c) => storeTimeMs >= c.timelineStartMs && storeTimeMs < c.timelineEndMs
        );

        // Loop back to timeline 0: seek the video to the FIRST clip's in-point.
        const loopToStart = () => {
          const firstSourceMs = timelineToSourceMs(0, freshClips, reel.sourceStartMs ?? reel.startMs);
          if (firstSourceMs !== null) {
            lastGapSeekSourceMsRef.current = firstSourceMs;
            video.currentTime = firstSourceMs / 1000;
            if (audioRef.current) audioRef.current.currentTime = firstSourceMs / 1000 + audioOffsetSec;
          }
          lastTickSetMsRef.current = 0;
          setCurrentTime(0);
        };

        if (active) {
          const overshoot = currentSourceMs - active.sourceOutMs;
          const inRange = currentSourceMs >= active.sourceInMs - 1 && overshoot < 0;
          if (inRange) {
            // Inside the active clip — normal advance along ITS mapping.
            lastGapSeekSourceMsRef.current = -Infinity;
            const newMs = Math.max(0, active.timelineStartMs + (currentSourceMs - active.sourceInMs));
            if (newMs >= totalDur) {
              loopToStart();
            } else {
              lastTickSetMsRef.current = newMs;
              setCurrentTime(newMs);
            }
          } else if (overshoot >= 0 && overshoot < 800) {
            // Just played past the active clip's out-point (small overshoot =
            // a genuine boundary crossing) — advance to the next clip in
            // TIMELINE order (never by source position).
            const next = videoClips.find((c) => c.timelineStartMs >= active.timelineEndMs);
            if (next) {
              if (Math.abs(next.sourceInMs - currentSourceMs) < 40) {
                // Source-contiguous neighbor (e.g. split halves) — no seek
                // needed, keep playing and just remap onto the next clip.
                lastGapSeekSourceMsRef.current = -Infinity;
                const newMs = next.timelineStartMs + Math.max(0, currentSourceMs - next.sourceInMs);
                lastTickSetMsRef.current = newMs;
                setCurrentTime(newMs);
              } else {
                // Discontinuous — seek once (guarded: re-issuing every frame
                // restarts the seek and never lets it complete).
                const targetMs = next.sourceInMs;
                if (Math.abs(lastGapSeekSourceMsRef.current - targetMs) > 1) {
                  lastGapSeekSourceMsRef.current = targetMs;
                  video.currentTime = targetMs / 1000;
                  if (audioRef.current) audioRef.current.currentTime = targetMs / 1000 + audioOffsetSec;
                }
                lastTickSetMsRef.current = next.timelineStartMs;
                setCurrentTime(next.timelineStartMs);
              }
            } else {
              loopToStart();
            }
          } else {
            // Video source is FAR outside the active clip's range: stale
            // position (e.g. play pressed with the video parked elsewhere —
            // typical right after entering timeline phase with a pasted piece
            // whose source lives deep in the file) or a seek nobody issued.
            // Position the video at the store playhead WITHIN the active clip
            // (guarded so we only request it once per target).
            const targetMs = active.sourceInMs + Math.max(0, storeTimeMs - active.timelineStartMs);
            if (Math.abs(lastGapSeekSourceMsRef.current - targetMs) > 1) {
              lastGapSeekSourceMsRef.current = targetMs;
              video.currentTime = targetMs / 1000;
              if (audioRef.current) audioRef.current.currentTime = targetMs / 1000 + audioOffsetSec;
            }
          }
        } else {
          // Store playhead sits in a gap (or there are no clips) — skip to the
          // next clip in timeline order, or loop.
          const nextClip = findNextClipAfter(storeTimeMs, freshClips);
          if (nextClip) {
            const targetMs = nextClip.sourceInMs;
            if (Math.abs(lastGapSeekSourceMsRef.current - targetMs) > 1) {
              lastGapSeekSourceMsRef.current = targetMs;
              video.currentTime = targetMs / 1000;
              if (audioRef.current) audioRef.current.currentTime = targetMs / 1000 + audioOffsetSec;
            }
            lastTickSetMsRef.current = nextClip.timelineStartMs;
            setCurrentTime(nextClip.timelineStartMs);
          } else {
            loopToStart();
          }
        }
      } else {
        // Setup phase: linear mapping
        if (currentSec >= endSec) {
          video.currentTime = startSec;
          if (audioRef.current) audioRef.current.currentTime = startSec + audioOffsetSec;
          lastTickSetMsRef.current = 0;
          setCurrentTime(0);
        } else {
          const relMs = Math.max(0, (currentSec - startSec) * 1000);
          lastTickSetMsRef.current = relMs;
          setCurrentTime(relMs);
        }
      }

      // Mute audio during gaps in audio clips.
      //
      // Subtlety: when there are NO audio clips at all (typical for reels
      // created from compose without an explicit ra1 track, e.g. when the
      // selectedAudioPath was cleared by reconcile because the standalone
      // mix file is missing), do NOT mute — fall back to the muxed video's
      // embedded audio. Otherwise the player goes silent the whole time and
      // there's no way to hear anything in timeline phase.
      if (isTimelinePhase) {
        const freshReel2 = useReelStore.getState().reels.find((r) => r.id === reelId);
        // ONLY ra1 gates the main (muxed/separate) audio. Extra-audio tracks
        // (ra2, etc.) are mixed independently by ReelExtraAudio and must NOT
        // un-mute the main here — otherwise a pasted extra-audio clip would
        // keep the video's own audio playing under it.
        const mainAudioClips = freshReel2?.composition.clips.filter(
          (c) => c.trackId === 'ra1'
        ) ?? [];
        const ra1Muted = !!freshReel2?.composition.tracks.find((t) => t.id === 'ra1')?.muted;
        if (ra1Muted) {
          // Main Audio muted ("mesa y ambiente como pistas separadas"): only
          // the extra layers (ReelExtraAudio) sound. Export does the same.
          if (audioRef.current) audioRef.current.volume = 0;
          else video.volume = 0;
        } else if (mainAudioClips.length === 0) {
          // No main audio clips: let the video play its embedded audio.
          if (audioRef.current) audioRef.current.volume = 1;
          else video.volume = 1;
        } else {
          const storeTime = useReelStore.getState().currentTimeMs;
          const inAudioClip = mainAudioClips.some(
            (c) => storeTime >= c.timelineStartMs && storeTime < c.timelineEndMs
          );
          const vol = inAudioClip ? 1 : 0;
          if (audioRef.current) audioRef.current.volume = vol;
          // If no separate audio, mute/unmute video's embedded audio via volume
          if (!audioRef.current) video.volume = vol;
        }
      }

      syncAudio();
      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, reel, reelId, startSec, endSec, setCurrentTime, syncAudio, isTimelinePhase, setupSegmented, audioOffsetSec]);

  // Seek when store currentTimeMs changes externally (user scrub, button, etc.)
  // During playback, skip if the change came from the animation tick to prevent
  // a feedback loop: tick → setCurrentTime → seek effect → video.currentTime → tick
  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.seeking) return;

    // If playing, only respond to user-initiated seeks (not tick updates).
    // Tick always sets lastTickSetMsRef to the exact value it passes to setCurrentTime,
    // so matching values reliably identify tick-driven updates.
    if (isPlaying && Math.abs(currentTimeMs - lastTickSetMsRef.current) < 1) return;

    const currentClips = isTimelinePhase
      ? (reel?.composition.clips ?? [])
      : setupSegmentClipsRef.current;
    let targetSec: number;
    if (isTimelinePhase || setupSegmented) {
      const sourceMs = timelineToSourceMs(currentTimeMs, currentClips, reel?.sourceStartMs ?? reel?.startMs ?? 0);
      if (sourceMs === null) {
        // In a gap — find next clip and seek there
        const nextClip = findNextClipAfter(currentTimeMs, currentClips);
        targetSec = nextClip ? nextClip.sourceInMs / 1000 : startSec;
      } else {
        targetSec = sourceMs / 1000;
      }
    } else {
      targetSec = startSec + currentTimeMs / 1000;
    }

    if (Math.abs(video.currentTime - targetSec) > 0.05) {
      video.currentTime = targetSec;
      if (audioRef.current) audioRef.current.currentTime = targetSec + audioOffsetSec;
      // Clear gap seek tracker so the tick loop won't treat this as a duplicate
      lastGapSeekSourceMsRef.current = -Infinity;
    }

    // Mute audio during gaps when seeking — only ra1 gates the main audio
    // (ra2+ extra audio is mixed separately by ReelExtraAudio).
    if (audioRef.current && isTimelinePhase) {
      const audioClips = currentClips.filter(
        (c) => c.trackId === 'ra1'
      );
      const inAudioClip = audioClips.some(
        (c) => currentTimeMs >= c.timelineStartMs && currentTimeMs < c.timelineEndMs
      );
      const ra1Muted = !!reel?.composition.tracks.find((t) => t.id === 'ra1')?.muted;
      audioRef.current.volume = inAudioClip && !ra1Muted ? 1 : 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTimeMs, startSec, isTimelinePhase, setupSegmented, reel?.startMs, reel?.composition.clips, reel?.composition.tracks, isPlaying]);

  // When reel range changes, ensure video is within range
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !reel) return;
    // Linear bounds only apply to the plain (non-segmented) setup preview; a
    // segmented setup deliberately seeks the video into later source ranges
    // (the segments), which fall outside [startSec, endSec].
    if (!isTimelinePhase && !setupSegmented && (video.currentTime < startSec || video.currentTime > endSec)) {
      video.currentTime = startSec;
      if (audioRef.current) audioRef.current.currentTime = startSec + audioOffsetSec;
      setCurrentTime(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reel?.startMs, reel?.endMs, startSec, endSec, setCurrentTime, isTimelinePhase, setupSegmented]);

  const togglePlay = useCallback(() => {
    setIsPlaying(!isPlaying);
  }, [isPlaying, setIsPlaying]);

  // --- Crop overlay drag ---
  // With crop KEYFRAMES active, a drag upserts the keyframe at the playhead
  // (Premiere-style auto-keyframe) instead of moving the static crop — so you
  // scrub, frame the subject, and the animation records itself.
  const handleCropMouseDown = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      if (!reel) return;
      const rs = useReelStore.getState();
      const hasKfs = (reel.cropKeyframes?.length ?? 0) > 0;
      const dragT = rs.currentTimeMs; // freeze the keyframe time at drag start
      const crop = cropAtTime(reel.cropRegion, reel.cropKeyframes, dragT);
      e.preventDefault();
      e.stopPropagation();
      dragStart.current = { x: e.clientX, y: e.clientY, cx: crop.centerX, cy: crop.centerY, scale: crop.scale };
      setDragMode(mode);

      // One undo entry for the whole drag — pushed lazily on the first actual
      // movement so a plain click doesn't spend an undo step / clear redo.
      let snapshotTaken = false;
      const applyCrop = (updates: Partial<typeof crop>) => {
        if (hasKfs) {
          if (!snapshotTaken) {
            snapshotTaken = true;
            useReelStore.getState().saveSnapshot();
          }
          // Keyframed crops stay fully in-frame so the interpolated window
          // never leaves the source (parity with the zoompan export).
          const res = useReelStore.getState().sourceResolution;
          const next = clampCropToFrame({ ...crop, ...updates }, res?.width ?? 1920, res?.height ?? 1080);
          useReelStore.getState().upsertCropKeyframeAt(reelId, dragT, next);
        } else {
          updateCropRegion(reelId, updates);
        }
      };

      const handleMouseMove = (ev: MouseEvent) => {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const dx = (ev.clientX - dragStart.current.x) / rect.width;
        const dy = (ev.clientY - dragStart.current.y) / rect.height;

        if (mode === 'move') {
          applyCrop({
            centerX: Math.max(0, Math.min(1, dragStart.current.cx + dx)),
            centerY: Math.max(0, Math.min(1, dragStart.current.cy + dy)),
          });
        } else {
          const scaleChange = mode === 'nw' || mode === 'sw' ? -dy : dy;
          const newScale = Math.max(0.1, Math.min(1.0, dragStart.current.scale + scaleChange));
          applyCrop({ scale: newScale });
        }
      };

      const handleMouseUp = () => {
        setDragMode(null);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [reel, reelId, updateCropRegion]
  );

  if (!reel) return null;

  // Effective crop at the playhead (interpolated when keyframes exist) — the
  // overlay rect follows the animation.
  const crop = cropAtTime(reel.cropRegion, reel.cropKeyframes, currentTimeMs);
  const srcW = sourceResolution?.width ?? 1920;
  const srcH = sourceResolution?.height ?? 1080;
  const cropH = crop.scale;
  const cropW = (cropH * srcH * 9) / (16 * srcW);
  const cropLeft = (crop.centerX - cropW / 2) * 100;
  const cropTop = (crop.centerY - cropH / 2) * 100;
  const cropWidthPct = cropW * 100;
  const cropHeightPct = cropH * 100;

  // Per-clip motion transform (zoom/position/rotation) inherited from compose.
  // - Timeline phase: the reel has its own rv1 clips (which inherited the
  //   compose transform at creation); use the one covering the current time.
  // - Setup phase: the reel has no clips yet, so read the transform straight
  //   from the COMPOSE v1 clip that covers the current source position. This
  //   makes the setup preview already show the straightened / zoomed image.
  const activeTransform = (() => {
    if (isTimelinePhase) {
      const rv1 = reel.composition.clips
        .filter((c) => c.trackId === 'rv1')
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
      const active = rv1.find((c) => currentTimeMs >= c.timelineStartMs && currentTimeMs < c.timelineEndMs)
        ?? rv1[0];
      return active?.transform;
    }
    // Setup phase: map the current playhead to source time, then find the
    // compose v1 clip whose source range contains it.
    const composeClips = composeClipsRef.current;
    if (!composeClips || composeClips.length === 0) return undefined;
    const curSourceMs = srcStartMs + currentTimeMs; // setup is a linear span
    const v1 = composeClips
      .filter((c) => c.trackId === 'v1')
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const inSource = v1.find((c) => curSourceMs >= c.sourceInMs && curSourceMs < c.sourceOutMs);
    // Fall back to whichever compose clip overlaps the reel's compose window.
    const overlap = v1.find((c) => c.timelineEndMs > reel.startMs && c.timelineStartMs < reel.endMs);
    return (inSource ?? overlap)?.transform;
  })();
  const videoTransformCss = (() => {
    const t = activeTransform;
    if (!t) return undefined;
    const scale = t.scale ?? 1;
    const x = t.x ?? 0;
    const y = t.y ?? 0;
    const rot = t.rotation ?? 0;
    if (Math.abs(scale - 1) < 0.001 && Math.abs(x) < 0.001 && Math.abs(y) < 0.001 && Math.abs(rot) < 0.001) return undefined;
    const parts: string[] = [];
    if (Math.abs(x) > 0.001 || Math.abs(y) > 0.001) parts.push(`translate(${x * 100}%, ${y * 100}%)`);
    if (Math.abs(rot) > 0.001) parts.push(`rotate(${rot}deg)`);
    if (Math.abs(scale - 1) > 0.001) parts.push(`scale(${scale})`);
    return parts.join(' ');
  })();

  return (
    <div className="space-y-2">
      {/* Hidden PiP overlay video elements — frame source for canvas previews */}
      <ReelOverlayVideos reelId={reelId} />
      {/* Hidden extra-audio elements — mixed layers played live */}
      <ReelExtraAudio reelId={reelId} />
      {/* Video with crop overlay */}
      <div
        ref={containerRef}
        className="relative bg-black rounded-lg overflow-hidden"
        style={{ aspectRatio: '16/9' }}
      >
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            className="w-full h-full object-contain"
            style={videoTransformCss ? { transform: videoTransformCss, transformOrigin: 'center center' } : undefined}
            muted={!!needsSeparateAudio}
            playsInline
            preload="auto"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
            No video source
          </div>
        )}

        {/* Crop overlay mask */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          <defs>
            <mask id={`crop-mask-${reelId}`}>
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={`${cropLeft}%`}
                y={`${cropTop}%`}
                width={`${cropWidthPct}%`}
                height={`${cropHeightPct}%`}
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.5)"
            mask={`url(#crop-mask-${reelId})`}
          />
        </svg>

        {/* Crop border (interactive) */}
        <div
          className="absolute border-2 border-white/80 cursor-move"
          style={{
            left: `${cropLeft}%`,
            top: `${cropTop}%`,
            width: `${cropWidthPct}%`,
            height: `${cropHeightPct}%`,
          }}
          onMouseDown={(e) => handleCropMouseDown(e, 'move')}
        >
          {/* Rule of thirds */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/20" />
            <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/20" />
            <div className="absolute top-1/3 left-0 right-0 h-px bg-white/20" />
            <div className="absolute top-2/3 left-0 right-0 h-px bg-white/20" />
          </div>

          {/* Corner handles */}
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <div
              key={corner}
              className="absolute w-3 h-3 bg-white border border-black/40 rounded-sm"
              style={{
                top: corner.startsWith('n') ? -6 : undefined,
                bottom: corner.startsWith('s') ? -6 : undefined,
                left: corner.endsWith('w') ? -6 : undefined,
                right: corner.endsWith('e') ? -6 : undefined,
                cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
              }}
              onMouseDown={(e) => handleCropMouseDown(e, corner)}
            />
          ))}
        </div>
      </div>

      {/* Separate audio element if needed */}
      {needsSeparateAudio && (
        <audio ref={audioRef} src={audioSrc} preload="auto" />
      )}

      {/* Controls row: transport + time + crop */}
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setCurrentTime(0)} title="Go to start">
          <SkipBack className="h-3 w-3" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setCurrentTime(Math.max(0, currentTimeMs - 100))} title="Step back 0.1s">
          <ChevronLeft className="h-3 w-3" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={togglePlay}>
          {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setCurrentTime(Math.min(reelDurationMs, currentTimeMs + 100))} title="Step forward 0.1s">
          <ChevronRight className="h-3 w-3" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setCurrentTime(reelDurationMs)} title="Go to end">
          <SkipForward className="h-3 w-3" />
        </Button>

        {/* Editable timecode */}
        <EditableTimeInput
          ms={currentTimeMs}
          maxMs={reelDurationMs}
          onChange={setCurrentTime}
        />
        <span className="text-xs text-muted-foreground font-mono">/ {formatTimeCode(reelDurationMs)}</span>

        <div className="flex-1" />

        {/* Crop controls inline */}
        <Button
          size="sm" variant="ghost" className="h-7 px-1.5"
          onClick={() => updateCropRegion(reelId, { centerX: 0.5, centerY: 0.5 })}
          title="Center crop"
        >
          <Crosshair className="h-3 w-3" />
        </Button>
        <Button
          size="sm" variant="ghost" className="h-7 px-1.5"
          onClick={() => updateCropRegion(reelId, { centerX: 0.5, centerY: 0.5, scale: 1.0 })}
          title="Reset crop"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
        <div className="flex items-center gap-1">
          <input
            type="range"
            min={10}
            max={100}
            value={Math.round(crop.scale * 100)}
            onChange={(e) => updateCropRegion(reelId, { scale: parseInt(e.target.value) / 100 })}
            className="w-16 h-1"
          />
          <span className="text-[10px] text-muted-foreground w-7 text-right">{Math.round(crop.scale * 100)}%</span>
        </div>
      </div>
    </div>
  );
}
