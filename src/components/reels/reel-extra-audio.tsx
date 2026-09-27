'use client';

import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useReelStore } from '@/stores/reel-store';
import { fadeInGain } from '@/lib/audio-fade';
import { regionGainAt } from '@/lib/clip-gain';
import { trackMixerGain } from '@/lib/audio-stems';

/**
 * Plays the reel's EXTRA audio clips (audio on any track other than the main
 * ra1) as real, mixed sound — each from its own file at its own source offset,
 * synced to the playhead. ra1 stays the "main audio" (it gates the muxed
 * video's embedded audio in reel-video-player); these are additive layers
 * (music, SFX, a pasted clip, audio from another reel).
 *
 * Mirrors reel-overlay-videos: hidden, muted-until-active <audio> elements.
 * Synced via a REACTIVE effect keyed on `currentTimeMs`/`isPlaying`, NOT an
 * independent rAF loop — during playback reel-video-player's own tick already
 * pushes `currentTimeMs` every frame, so this fires just as often for free;
 * while paused it fires only on an actual scrub, instead of the previous
 * self-rescheduling loop that ran forever at 60fps even sitting idle on the
 * reels page (found in a "why does the whole app feel heavy" perf sweep).
 * Mounted inside ReelVideoPlayer so it lives in both setup and timeline phases.
 */
export function ReelExtraAudio({ reelId }: { reelId: string }) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const isPlaying = useReelStore((s) => s.isPlaying);

  const extraClips = (reel?.composition.clips ?? []).filter(
    (c) => c.type === 'audio' && c.trackId !== 'ra1' && c.fileName
  );

  const elsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Gain above 1.0 (a stem pushed to "mesa × 1.5") is impossible through
  // HTMLMediaElement.volume (throws past 1), so elements route through a
  // shared AudioContext + one GainNode each, created lazily on first use. A
  // MediaElementSource can only be created ONCE per element, hence the map.
  const ctxRef = useRef<AudioContext | null>(null);
  const gainsRef = useRef<Map<HTMLAudioElement, GainNode>>(new Map());
  const setGain = (el: HTMLAudioElement, value: number) => {
    const v = Math.max(0, value);
    let g = gainsRef.current.get(el);
    if (!g && v > 1) {
      try {
        if (!ctxRef.current) ctxRef.current = new AudioContext();
        const ctx = ctxRef.current;
        const src = ctx.createMediaElementSource(el);
        g = ctx.createGain();
        src.connect(g).connect(ctx.destination);
        gainsRef.current.set(el, g);
        if (ctx.state === 'suspended') void ctx.resume();
      } catch {
        g = undefined;
      }
    }
    if (g) {
      el.volume = 1;
      g.gain.value = v;
    } else {
      el.volume = Math.min(1, v);
    }
  };

  useEffect(() => {
    const r = useReelStore.getState().reels.find((x) => x.id === reelId);
    if (!r) return;
    const t = currentTimeMs;
    // Muted extra tracks stay silent (export honors the mute the same way).
    const mutedTracks = new Set(r.composition.tracks.filter((tr) => tr.muted).map((tr) => tr.id));
    for (const clip of r.composition.clips) {
      if (clip.type !== 'audio' || clip.trackId === 'ra1' || !clip.fileName) continue;
      const el = elsRef.current.get(clip.id);
      if (!el) continue;
      const inRange = t >= clip.timelineStartMs && t < clip.timelineEndMs && !mutedTracks.has(clip.trackId);
      if (inRange) {
        // Stem tracks enter the mixer at ×0.5 (see STEM_MIX_NORMALIZATION).
        const base = (clip.volume ?? 1) * trackMixerGain(clip.trackId);
        // Apply fade-in ramp over the first fadeInMs of the clip.
        const fadeMs = clip.fadeInMs ?? 0;
        const posInClip = t - clip.timelineStartMs;
        // × the clip's own volume zones at this point of its file (same maths
        // the export runs through buildDuckVolumeExpr).
        const zoneGain = regionGainAt(clip.gainRegions, clip.sourceInMs + posInClip);
        const gain = fadeMs > 0 && posInClip < fadeMs
          ? fadeInGain(posInClip / fadeMs, clip.fadeInCurve) * zoneGain
          : zoneGain;
        setGain(el, base * gain);
        const expected = (clip.sourceInMs + (t - clip.timelineStartMs)) / 1000;
        if (el.readyState >= 1 && Math.abs(el.currentTime - expected) > 0.25) {
          el.currentTime = Math.max(0, expected);
        }
        if (isPlaying && el.paused) el.play().catch(() => {});
        if (!isPlaying && !el.paused) el.pause();
      } else if (!el.paused) {
        el.pause();
      }
    }
  }, [reelId, currentTimeMs, isPlaying]);

  if (!projectId) return null;

  return (
    <div className="w-0 h-0 overflow-hidden" aria-hidden>
      {extraClips.map((clip) => (
        <audio
          key={clip.id}
          src={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(clip.fileName)}`}
          preload="auto"
          ref={(el) => {
            if (el) elsRef.current.set(clip.id, el);
            else elsRef.current.delete(clip.id);
          }}
        />
      ))}
    </div>
  );
}
