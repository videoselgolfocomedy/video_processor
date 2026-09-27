'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Headphones, Loader2, Pause, Play } from 'lucide-react';

/**
 * "Comprobar de oído" — plays the BOARD (mesa) and the CAMERA audio TOGETHER
 * at a given alignment offset, THROUGH a WebAudio graph that mirrors the real
 * part-mix chain (compand → board gain dB → limiter → board volume; ambient
 * volume; master limiter). What you hear is what "Mezclar y muxar" will
 * produce — so both the ALIGNMENT and the LEVELS (echo!) can be judged and
 * tuned live, before mixing:
 *
 *  - offset nudge ±10/±50 ms while playing, "Usar este offset" saves it;
 *  - mesa/cámara volume sliders EDIT THE PART's mix settings (committed on
 *    release), so the eventual mix uses exactly what you dialed in by ear.
 *
 * Mapping: board_time = camera_time + offsetMs (positive offset = the mesa
 * recording started BEFORE the camera).
 */
interface EarCheckMix {
  boardGainDb: number;
  boardCompress: boolean;
  boardVolume: number;
  ambientVolume: number;
}

interface AlignmentEarCheckProps {
  boardUrl: string;
  cameraUrl: string;
  /** Override for the chain description in the header (e.g. when the real
   *  mix uses the speechnorm leveler, which WebAudio can only approximate). */
  chainLabel?: string;
  /** Fired on EVERY slider move (not just on release) so the caller can redraw
   *  live; the persisted change still goes through onMixChange on pointer-up. */
  onMixLive?: (p: { boardVolume?: number; ambientVolume?: number }) => void;
  /** Current alignment offset in ms (positive = mesa starts earlier). */
  offsetMs: number;
  /** The stretch of the VIDEO the part covers (camera clock): playback is
   *  confined to it, so you audition exactly what will be mixed. */
  rangeMs?: { startMs: number; endMs: number };
  /** Live mix settings (drafts from the part card) — the preview chain follows them. */
  mix: EarCheckMix;
  /** Commit a volume tweak back to the part (slider release). */
  onMixChange?: (patch: { boardVolume?: number; ambientVolume?: number }) => void;
  onApplyOffset?: (offsetMs: number) => Promise<void>;
  onApplied?: () => void;
}

export function AlignmentEarCheck({
  boardUrl, cameraUrl, offsetMs, rangeMs, mix, onMixChange, onMixLive, onApplyOffset, onApplied, chainLabel,
}: AlignmentEarCheckProps) {
  const { toast } = useToast();
  const boardRef = useRef<HTMLAudioElement>(null);
  const camRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const rangeStartSec = rangeMs ? Math.min(rangeMs.startMs, rangeMs.endMs) / 1000 : 0;
  const rangeEndSecRaw = rangeMs ? Math.max(rangeMs.startMs, rangeMs.endMs) / 1000 : Infinity;
  const [posSec, setPosSec] = useState(rangeStartSec + 5); // camera-time seconds
  const [camDur, setCamDur] = useState(0);
  const rangeEndSec = Math.min(rangeEndSecRaw, camDur || rangeEndSecRaw);
  useEffect(() => { setPosSec(rangeStartSec + 5); }, [rangeStartSec]);
  const [deltaMs, setDeltaMs] = useState(0); // live nudge on top of offsetMs
  const [applying, setApplying] = useState(false);
  // Local volume drafts (slider drag updates the graph live; release commits).
  const [bv, setBv] = useState(mix.boardVolume);
  const [av, setAv] = useState(mix.ambientVolume);
  useEffect(() => setBv(mix.boardVolume), [mix.boardVolume]);
  useEffect(() => setAv(mix.ambientVolume), [mix.ambientVolume]);

  const effOffsetMs = offsetMs + deltaMs;
  const effOffsetRef = useRef(effOffsetMs);
  useEffect(() => { effOffsetRef.current = effOffsetMs; }, [effOffsetMs]);
  useEffect(() => { setDeltaMs(0); }, [offsetMs]);

  // ── WebAudio graph mirroring the mix chain ────────────────────────────────
  // board: source → [compand≈compressor] → gain(10^(dB/20) · boardVolume) → master
  // cam:   source → gain(ambientVolume) → master
  // master: limiter(≈alimiter 0.95) → destination
  const graphRef = useRef<{
    ctx: AudioContext;
    boardSrc: MediaElementAudioSourceNode;
    camSrc: MediaElementAudioSourceNode;
    comp: DynamicsCompressorNode;
    boardGain: GainNode;
    camGain: GainNode;
    limiter: DynamicsCompressorNode;
  } | null>(null);

  const ensureGraph = useCallback(() => {
    if (graphRef.current) return graphRef.current;
    const board = boardRef.current;
    const cam = camRef.current;
    if (!board || !cam) return null;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const boardSrc = ctx.createMediaElementSource(board);
    const camSrc = ctx.createMediaElementSource(cam);
    // compand=attacks=0.005:decays=0.1:points=-80/-80|-25/-25|0/-6 ≈ soft-knee
    // compression above -25 dB (≈1.3:1 with that curve).
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -25;
    comp.ratio.value = 1.4;
    comp.knee.value = 6;
    comp.attack.value = 0.005;
    comp.release.value = 0.1;
    const boardGain = ctx.createGain();
    const camGain = ctx.createGain();
    // alimiter=limit=0.95 ≈ hard limiter just under full scale.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.ratio.value = 20;
    limiter.knee.value = 0;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.05;
    boardGain.connect(limiter);
    camSrc.connect(camGain);
    camGain.connect(limiter);
    limiter.connect(ctx.destination);
    graphRef.current = { ctx, boardSrc, camSrc, comp, boardGain, camGain, limiter };
    return graphRef.current;
  }, []);

  // (Re)wire the board branch + gain values whenever settings change.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.boardSrc.disconnect();
    g.comp.disconnect();
    if (mix.boardCompress) {
      g.boardSrc.connect(g.comp);
      g.comp.connect(g.boardGain);
    } else {
      g.boardSrc.connect(g.boardGain);
    }
  }, [mix.boardCompress, playing]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.boardGain.gain.value = Math.pow(10, (mix.boardGainDb || 0) / 20) * bv;
  }, [mix.boardGainDb, bv, playing]);
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.camGain.gain.value = av;
  }, [av, playing]);

  useEffect(() => {
    const cam = camRef.current;
    if (!cam) return;
    const onMeta = () => setCamDur(cam.duration || 0);
    cam.addEventListener('loadedmetadata', onMeta);
    if (cam.readyState >= 1) onMeta();
    return () => cam.removeEventListener('loadedmetadata', onMeta);
  }, [cameraUrl]);

  const stop = useCallback(() => {
    boardRef.current?.pause();
    camRef.current?.pause();
    setPlaying(false);
  }, []);

  const start = useCallback((fromSec?: number) => {
    const board = boardRef.current;
    const cam = camRef.current;
    if (!board || !cam) return;
    const g = ensureGraph();
    if (g && g.ctx.state === 'suspended') void g.ctx.resume();
    // Element volumes stay at 1 — ALL gain lives in the WebAudio graph.
    board.volume = 1;
    cam.volume = 1;
    const t = Math.min(Math.max(fromSec ?? posSec, rangeStartSec), Number.isFinite(rangeEndSec) ? rangeEndSec - 0.5 : Infinity);
    cam.currentTime = Math.max(0, t);
    board.currentTime = Math.max(0, t + effOffsetRef.current / 1000);
    void cam.play().catch(() => {});
    void board.play().catch(() => {});
    setPlaying(true);
  }, [posSec, ensureGraph, rangeStartSec, rangeEndSec]);

  // While playing: track camera position + keep the board in sync with the
  // CURRENT offset (re-seek only on real drift or a nudge, not every tick).
  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      const board = boardRef.current;
      const cam = camRef.current;
      if (!board || !cam) return;
      if (cam.paused) { setPlaying(false); return; }
      // The part ends at the range end: stop there, like the mix will.
      if (Number.isFinite(rangeEndSec) && cam.currentTime >= rangeEndSec) { board.pause(); cam.pause(); setPlaying(false); setPosSec(rangeEndSec); return; }
      setPosSec(cam.currentTime);
      const target = cam.currentTime + effOffsetRef.current / 1000;
      if (Math.abs(board.currentTime - target) > 0.08) {
        board.currentTime = target;
      }
    }, 400);
    return () => clearInterval(iv);
  }, [playing, rangeEndSec]);

  const nudge = (ms: number) => setDeltaMs((d) => Math.round((d + ms) * 10) / 10);

  const fmt = (ms: number) => `${ms < 0 ? '-' : '+'}${Math.abs(ms)} ms`;
  const fmtOffset = (ms: number) => {
    const s = Math.abs(ms) / 1000;
    const m = Math.floor(s / 60);
    return `${ms < 0 ? '-' : ''}${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
  };

  const apply = async () => {
    if (!onApplyOffset) return;
    setApplying(true);
    try {
      await onApplyOffset(offsetMs + deltaMs);
      toast({ title: 'Offset aplicado', description: `Nuevo offset: ${fmtOffset(offsetMs + deltaMs)}` });
      setDeltaMs(0);
      onApplied?.();
    } catch (err) {
      toast({ title: 'No se pudo aplicar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Headphones className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Comprobar de oído (mezcla real)</span>
        <span className="text-[10px] text-muted-foreground">
          {chainLabel ??
            `suena con ganancia ${mix.boardGainDb > 0 ? `+${mix.boardGainDb}` : mix.boardGainDb} dB${mix.boardCompress ? ' + compresor' : ''} y los volúmenes de abajo — lo que oyes ≈ lo que mezcla`}
        </span>
      </div>

      {/* Transport + position over the camera (overlap) time */}
      <div className="flex items-center gap-2">
        <Button
          size="sm" variant="outline" className="h-7 w-7 p-0"
          onClick={() => (playing ? stop() : start())}
          title={playing ? 'Pausar' : 'Reproducir la mezcla (mesa procesada + cámara)'}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <input
          type="range" min={rangeStartSec} max={Math.max(rangeStartSec + 1, Number.isFinite(rangeEndSec) ? rangeEndSec : camDur)} step={0.1}
          value={Math.min(Math.max(posSec, rangeStartSec), Number.isFinite(rangeEndSec) ? rangeEndSec : (camDur || posSec))}
          onChange={(e) => {
            const v = Number(e.target.value);
            setPosSec(v);
            if (playing) start(v);
          }}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          title="Posición (tiempo de cámara)"
        />
        <span className="text-right font-mono text-[10px] text-muted-foreground" title={rangeMs ? 'Tiempo de cámara · solo se reproduce el tramo del vídeo que edita esta parte' : 'Tiempo de cámara'}>
          {fmtOffset(posSec * 1000)} / {fmtOffset((Number.isFinite(rangeEndSec) ? rangeEndSec : camDur) * 1000)}
          {rangeMs && <span className="ml-1 text-amber-300/80">tramo {fmtOffset(rangeStartSec * 1000)}–{fmtOffset(rangeEndSecRaw * 1000)}</span>}
        </span>
      </div>

      {/* Live offset nudge */}
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <span className="text-muted-foreground">Ajuste fino:</span>
        {[-50, -10, 10, 50].map((ms) => (
          <button
            key={ms}
            className="rounded border border-border px-1.5 py-0.5 font-mono hover:bg-muted"
            onClick={() => nudge(ms)}
            title={`Desplazar la mesa ${fmt(ms)}`}
          >
            {fmt(ms)}
          </button>
        ))}
        <span className={`font-mono ${deltaMs !== 0 ? 'text-amber-300' : 'text-muted-foreground'}`}>
          Δ {fmt(deltaMs)} → offset {fmtOffset(effOffsetMs)}
        </span>
        {deltaMs !== 0 && onApplyOffset && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={apply} disabled={applying}>
            {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Usar este offset'}
          </Button>
        )}
      </div>

      {/* REAL mix volumes — edits are committed to the part on release, so
          "Mezclar y muxar" uses exactly what you tuned here. */}
      <div className="flex flex-wrap items-center gap-3 text-[10px]">
        <span className="flex items-center gap-1 text-muted-foreground">
          Vol. mesa
          <input
            type="range" min={0} max={2} step={0.05} value={bv}
            onChange={(e) => { const v = Number(e.target.value); setBv(v); onMixLive?.({ boardVolume: v }); }}
            onPointerUp={() => onMixChange?.({ boardVolume: bv })}
            className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          />
          <span className="w-8 font-mono text-foreground">{bv.toFixed(2)}</span>
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          Vol. cámara (ambiente)
          <input
            type="range" min={0} max={1.5} step={0.05} value={av}
            onChange={(e) => { const v = Number(e.target.value); setAv(v); onMixLive?.({ ambientVolume: v }); }}
            onPointerUp={() => onMixChange?.({ ambientVolume: av })}
            className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          />
          <span className="w-8 font-mono text-foreground">{av.toFixed(2)}</span>
        </span>
        <span className="text-muted-foreground italic">
          eco = cámara alta · sube mesa / baja cámara hasta que la voz quede limpia
        </span>
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={boardRef} src={boardUrl} preload="none" crossOrigin="anonymous" />
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={camRef} src={cameraUrl} preload="none" crossOrigin="anonymous" />
    </div>
  );
}
