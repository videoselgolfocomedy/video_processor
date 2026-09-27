'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X, Loader2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useProjectStore } from '@/stores/project-store';
import { useToast } from '@/hooks/use-toast';
import { applyPendingParts } from '@/lib/remix-ducking';
import {
  partWindows, placeRegions, timelineMsToSourceMs, partWindowAtConcatMs,
  concatMsToWavMs, wavMsToConcatMs, sourceRangeToTimelineSpans, sourceMsToTimelineMs,
  type RegionKind, type PlacedRegion, type PartWindow,
} from '@/lib/audio-region-map';
import type { BoardDuckRegion, CompositionClip } from '@/types/project';
import { ClipWaveform } from '@/components/parts/clip-waveform';
import { buildAmbientPlan, type AmbientPlan } from '@/lib/ambient-plan';
import { describeAmbientChain, partNeedsRemix } from '@/lib/part-chain-description';

/**
 * ONE editor state for the audio regions (mesa attenuations = je-je zones,
 * ambient raises) shared by everything on a timeline that shows them: the
 * bands drawn over the separated stem tracks, the fallback lane when the
 * stems are not separated, and the "Aplicar" bar. The provider sits at the
 * timeline level (Compose's multi-track timeline, the reel timeline) and gets
 * the editor's MAIN VIDEO clips — they carry the cuts, so a band lands under
 * the audio it changes even after editing.
 *
 * Regions live per PART on the part's own wav clock (`audio-region-map` walks
 * the clocks). Edits PATCH the part immediately; the mixed audio only changes
 * on "Aplicar", which is the same re-mix the Sync & Mix panels run.
 */
interface DragState { regionId: string; startMs: number; endMs: number }

/** What a NEW region of a kind is born with (editable in the track header, per project). */
export interface RegionDefaults { db: number; fadeInMs: number; fadeOutMs: number; shape: 'linear' | 'curve' }
const FACTORY_DEFAULTS: Record<RegionKind, RegionDefaults> = {
  board: { db: -30, fadeInMs: 30, fadeOutMs: 30, shape: 'linear' },
  ambient: { db: 6, fadeInMs: 250, fadeOutMs: 400, shape: 'linear' },
  noRaise: { db: 0, fadeInMs: 0, fadeOutMs: 0, shape: 'linear' },
  autoRaise: { db: 0, fadeInMs: 0, fadeOutMs: 0, shape: 'linear' },
  keepOpen: { db: 0, fadeInMs: 0, fadeOutMs: 0, shape: 'linear' },
  autoGate: { db: 0, fadeInMs: 0, fadeOutMs: 0, shape: 'linear' },
};
// autoRaise/autoGate are read-only (the engine's own decisions) — never saved through this map.
const FIELD_OF: Record<RegionKind, 'boardDuckRegions' | 'ambientBoostRegions' | 'ambientNoRaiseRegions' | 'boardKeepOpenRegions'> = {
  board: 'boardDuckRegions', ambient: 'ambientBoostRegions', noRaise: 'ambientNoRaiseRegions', autoRaise: 'ambientBoostRegions',
  keepOpen: 'boardKeepOpenRegions', autoGate: 'boardDuckRegions',
};
const KIND_LABEL: Record<RegionKind, { added: string; removed: string }> = {
  board: { added: 'Zona de mesa añadida', removed: 'Zona de mesa borrada' },
  ambient: { added: 'Zona de ambiente añadida', removed: 'Zona de ambiente borrada' },
  noRaise: { added: 'Zona sin subida añadida', removed: 'Zona sin subida borrada' },
  autoRaise: { added: 'Subida automática', removed: 'Subida automática anulada' },
  keepOpen: { added: 'Zona de mesa abierta añadida', removed: 'Zona de mesa abierta borrada' },
  autoGate: { added: 'Cierre automático', removed: 'Cierre automático anulado' },
};
export const REGION_DB_MIN = -40, REGION_DB_MAX = 24, REGION_FADE_MAX = 5000;

interface Ctx {
  projectId: string;
  wins: PartWindow[];
  placed: PlacedRegion[];
  videoClips: CompositionClip[];
  sel: { kind: RegionKind; partId: string; regionId: string } | null;
  /** The selected region, placed (null when nothing is selected). */
  selected: PlacedRegion | null;
  select: (p: PlacedRegion | null) => void;
  remove: (p: PlacedRegion) => Promise<void>;
  /** Change a region's own values (dB, fades, ramp shape). */
  update: (p: PlacedRegion, patch: Partial<BoardDuckRegion>) => Promise<void>;
  defaults: Record<RegionKind, RegionDefaults>;
  setDefaults: (kind: RegionKind, patch: Partial<RegionDefaults>) => void;
  add: (kind: RegionKind) => Promise<void>;
  /** Create a region spanning a TIMELINE range (drawn with the pencil). */
  addRange: (kind: RegionKind, timelineStartMs: number, timelineEndMs: number) => Promise<void>;
  beginDrag: (e: React.PointerEvent, p: PlacedRegion, mode: 'move' | 'start' | 'end') => void;
  drag: DragState | null;
  toPx: (timelineMs: number) => number;
  fromPx: (px: number) => number;
  /** Which kind the pencil is drawing on the stem tracks (null = off). */
  drawKind: RegionKind | null;
  setDrawKind: (kind: RegionKind | null) => void;
  /** What a new zone on the AMBIENT track means: a manual raise/cut, or a block of the automatic raise. */
  ambientNewKind: 'ambient' | 'noRaise';
  boardNewKind: 'board' | 'keepOpen';
  /** Turn an automatic raise into an editable manual zone — optionally with a
   *  new level or a new span. See materializeAutoRaise. */
  materializeAutoRaise: (p: PlacedRegion, opts?: { absoluteDb?: number; startMs?: number; endMs?: number }) => Promise<void>;
  setBoardNewKind: (k: 'board' | 'keepOpen') => void;
  setAmbientNewKind: (k: 'ambient' | 'noRaise') => void;
  zoomLevel: number;
  viewportWidthPx: number;
  onSeek?: (timelineMs: number) => void;
  dirtyParts: Set<string>;
  busy: string | null;
  /** "Calculando las subidas automáticas…" while the auto-raises route runs for a part. */
  autoMsg: string | null;
  /** The FORECAST of a part's ambient gain while its edits are unapplied (null = nothing pending: draw the files). */
  ambientPlanFor: (partId: string) => AmbientPlan | null;
  /** Same, looked up from a stem clip's file name (`part_<id8>_amb_proc.wav`). */
  ambientPlanForFile: (fileName: string) => AmbientPlan | null;
  applyAll: () => Promise<void>;
  stemTracksPresent: boolean;
}

const AudioRegionsCtx = createContext<Ctx | null>(null);
export function useAudioRegions(): Ctx | null { return useContext(AudioRegionsCtx); }

const DEFAULT_NEW_MS = 800;

export function AudioRegionsProvider({
  projectId, videoClips, scrollOffsetMs, zoomLevel, playheadMs, viewportWidthPx, onSeek, stemTracksPresent, children,
}: {
  projectId: string;
  videoClips: CompositionClip[];
  scrollOffsetMs: number;
  zoomLevel: number;
  playheadMs: number;
  viewportWidthPx: number;
  onSeek?: (timelineMs: number) => void;
  /** The editor has the separated stem tracks: bands are drawn on them and the fallback lane hides. */
  stemTracksPresent: boolean;
  children: ReactNode;
}) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const fetchProject = useProjectStore((s) => s.fetchProject);
  const { toast } = useToast();
  const [sel, setSel] = useState<Ctx['sel']>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const autoRequested = useRef<Set<string>>(new Set());
  const [dirtyParts, setDirtyParts] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drawKind, setDrawKind] = useState<RegionKind | null>(null);
  const [ambientNewKind, setAmbientNewKind] = useState<'ambient' | 'noRaise'>('ambient');
  const [boardNewKind, setBoardNewKind] = useState<'board' | 'keepOpen'>('board');
  const [defaults, setDefaultsState] = useState<Record<RegionKind, RegionDefaults>>(FACTORY_DEFAULTS);
  const defaultsKey = `audio-regions-defaults:${projectId}`;
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(defaultsKey);
      if (!raw) return;
      const v = JSON.parse(raw) as Partial<Record<RegionKind, Partial<RegionDefaults>>>;
      setDefaultsState({
        board: { ...FACTORY_DEFAULTS.board, ...(v.board ?? {}) },
        ambient: { ...FACTORY_DEFAULTS.ambient, ...(v.ambient ?? {}) },
        noRaise: FACTORY_DEFAULTS.noRaise,
        autoRaise: FACTORY_DEFAULTS.autoRaise,
        keepOpen: FACTORY_DEFAULTS.keepOpen,
        autoGate: FACTORY_DEFAULTS.autoGate,
      });
    } catch { /* keep factory defaults */ }
  }, [defaultsKey]);
  const setDefaults = useCallback((kind: RegionKind, patch: Partial<RegionDefaults>) => {
    setDefaultsState((prev) => {
      const next = { ...prev, [kind]: { ...prev[kind], ...patch } };
      try { window.localStorage.setItem(defaultsKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [defaultsKey]);
  const dragRef = useRef<{ id: string; kind: RegionKind; partId: string; mode: 'move' | 'start' | 'end'; x0: number; s0: number; e0: number; last: DragState } | null>(null);

  const wins = useMemo(() => partWindows(currentProject ?? { parts: [] }), [currentProject]);
  const placed = useMemo(() => placeRegions(wins, videoClips), [wins, videoClips]);
  // The drag commits from a window listener: it needs today's boxes without
  // rebuilding the handler on every render.
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const toPx = useCallback((ms: number) => (ms - scrollOffsetMs) * zoomLevel, [scrollOffsetMs, zoomLevel]);
  const fromPx = useCallback((px: number) => px / zoomLevel + scrollOffsetMs, [scrollOffsetMs, zoomLevel]);

  const regionsOf = useCallback((partId: string, kind: RegionKind): BoardDuckRegion[] => {
    const w = wins.find((x) => x.part.id === partId);
    if (!w) return [];
    return w.part[FIELD_OF[kind]] ?? [];
  }, [wins]);

  /** One PATCH for several region fields at once — materializing an automatic
   *  raise writes the veto AND the manual band, and two sequential saves would
   *  make the second one read a stale `wins`. */
  const saveFields = useCallback(async (partId: string, body: Record<string, BoardDuckRegion[]>) => {
    const res = await fetch(`/api/projects/${projectId}/parts/${partId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { toast({ title: 'No se pudo guardar', variant: 'destructive' }); return false; }
    await fetchProject(projectId);
    setDirtyParts((prev) => new Set(prev).add(partId));
    return true;
  }, [projectId, fetchProject, toast]);

  const save = useCallback((partId: string, kind: RegionKind, regions: BoardDuckRegion[]) =>
    saveFields(partId, { [FIELD_OF[kind]]: regions }), [saveFields]);

  const select = useCallback((p: PlacedRegion | null) => {
    setSel(p ? { kind: p.kind, partId: p.partId, regionId: p.region.id } : null);
  }, []);
  const selected = useMemo(() => (sel ? placed.find((p) => p.region.id === sel.regionId) ?? null : null), [sel, placed]);

  const update = useCallback(async (p: PlacedRegion, patch: Partial<BoardDuckRegion>) => {
    if (p.kind === 'autoRaise' || p.kind === 'autoGate') return;
    const next = regionsOf(p.partId, p.kind).map((r) => (r.id === p.region.id ? { ...r, ...patch } : r));
    await save(p.partId, p.kind, next);
  }, [regionsOf, save]);

  /**
   * Make an automatic raise the user's own. The engine rebuilds its list on
   * every mix, so a per-box override cannot be stored: instead the box becomes
   * a manual zone with the SAME span and the SAME level — a zone's dB is the
   * level over the original ambient and it replaces the curve inside its span
   * (lib/ambient-bands), so nothing changes audibly until the user edits it —
   * and the engine's raise is retired by a veto over its span that the zone
   * OWNS: never drawn, deleted together with the zone (delete the zone and the
   * automatic raise is back). One PATCH for both fields.
   */
  const materializeAutoRaise = useCallback(async (
    p: PlacedRegion,
    opts?: { absoluteDb?: number; startMs?: number; endMs?: number },
  ) => {
    if (p.kind !== 'autoRaise') return;
    const absolute = opts?.absoluteDb ?? p.db;
    const s0 = opts?.startMs ?? p.region.startMs;
    const e0 = opts?.endMs ?? p.region.endMs;
    const start = Math.round(Math.min(s0, e0));
    const end = Math.round(Math.max(s0, e0));
    const d = defaults.ambient;
    const band: BoardDuckRegion = {
      id: uuidv4(),
      startMs: Math.max(0, start),
      endMs: Math.max(start + 100, end),
      attenuationDb: Math.round(absolute * 10) / 10,
      source: 'manual',
      enabled: true,
      fadeInMs: d.fadeInMs,
      fadeOutMs: d.fadeOutMs,
      fadeShape: d.shape,
    };
    // The veto covers the ENGINE's span, not the new one: what it retires is
    // the automatic decision, wherever the user then drags its copy.
    const veto: BoardDuckRegion = {
      id: uuidv4(),
      startMs: p.region.startMs,
      endMs: p.region.endMs,
      attenuationDb: 0,
      source: 'manual',
      enabled: true,
      ownerId: band.id,
    };
    const ok = await saveFields(p.partId, {
      ambientNoRaiseRegions: [...regionsOf(p.partId, 'noRaise'), veto].sort((x, y) => x.startMs - y.startMs),
      ambientBoostRegions: [...regionsOf(p.partId, 'ambient'), band].sort((x, y) => x.startMs - y.startMs),
    });
    if (ok) {
      setSel({ kind: 'ambient', partId: p.partId, regionId: band.id });
      toast({
        title: `Ahora es una zona tuya: ${absolute > 0 ? '+' : ''}${absolute} dB`,
        description: 'Arrastra sus bordes, cambia dB o rampas. Bórrala y vuelve la subida automática. Pulsa «Aplicar» para oírlo.',
      });
    }
  }, [defaults, regionsOf, saveFields, toast]);

  const remove = useCallback(async (p: PlacedRegion) => {
    if (p.kind === 'autoRaise') {
      // Retiring the engine's raise: a "no raise" veto over the same span, kept
      // as a faint outline (not a user zone) so it can be restored. The next
      // mix keeps the voice level there.
      const existing = regionsOf(p.partId, 'noRaise');
      const veto: BoardDuckRegion = { id: uuidv4(), startMs: p.region.startMs, endMs: p.region.endMs, attenuationDb: 0, source: 'manual', enabled: true, retiresAuto: true };
      if (await save(p.partId, 'noRaise', [...existing, veto].sort((a, b) => a.startMs - b.startMs))) {
        setSel(null);
        toast({ title: 'Subida automática anulada', description: 'Ahí el ambiente se queda al nivel con voz. Queda un contorno tenue: selecciónalo y ✕ si quieres recuperarla. Pulsa «Aplicar» para oírlo.' });
      }
      return;
    }
    if (p.kind === 'ambient') {
      // A zone that took over an automatic raise owns that raise's veto: the
      // two go together, so the engine's decision comes back with one delete.
      const owned = regionsOf(p.partId, 'noRaise').filter((r) => r.ownerId === p.region.id);
      const ok = await saveFields(p.partId, {
        ambientBoostRegions: regionsOf(p.partId, 'ambient').filter((r) => r.id !== p.region.id),
        ...(owned.length > 0 ? { ambientNoRaiseRegions: regionsOf(p.partId, 'noRaise').filter((r) => r.ownerId !== p.region.id) } : {}),
      });
      if (ok) {
        setSel(null);
        toast({
          title: KIND_LABEL.ambient.removed,
          description: owned.length > 0 ? 'Vuelve la subida automática que sustituía. Pulsa «Aplicar» para que el audio cambie.' : 'Pulsa «Aplicar» para que el audio cambie.',
        });
      }
      return;
    }
    if (p.kind === 'noRaise' && p.region.retiresAuto) {
      const next = regionsOf(p.partId, 'noRaise').filter((r) => r.id !== p.region.id);
      if (await save(p.partId, 'noRaise', next)) {
        setSel(null);
        toast({ title: 'Subida automática recuperada', description: 'El motor vuelve a subir el ambiente ahí. Pulsa «Aplicar» para oírlo.' });
      }
      return;
    }
    if (p.kind === 'autoGate') {
      // Vetoing the gate: a "keep open" zone over the same span — the green
      // band takes the box's place and the next mix leaves the mesa untouched
      // there (the word that "sonaba alejándose" keeps its level).
      const existing = regionsOf(p.partId, 'keepOpen');
      const veto: BoardDuckRegion = { id: uuidv4(), startMs: p.region.startMs, endMs: p.region.endMs, attenuationDb: 0, source: 'manual', enabled: true };
      if (await save(p.partId, 'keepOpen', [...existing, veto].sort((a, b) => a.startMs - b.startMs))) {
        setSel({ kind: 'keepOpen', partId: p.partId, regionId: veto.id });
        toast({ title: 'Cierre de puerta anulado', description: 'Ahí la mesa queda abierta; borra la zona verde para recuperarlo. Pulsa «Aplicar» para oírlo.' });
      }
      return;
    }
    const next = regionsOf(p.partId, p.kind).filter((r) => r.id !== p.region.id);
    if (await save(p.partId, p.kind, next)) {
      setSel(null);
      toast({ title: KIND_LABEL[p.kind].removed, description: 'Pulsa «Aplicar» para que el audio cambie.' });
    }
  }, [regionsOf, save, saveFields, toast]);

  const addRange = useCallback(async (kind: RegionKind, tlStartMs: number, tlEndMs: number) => {
    const t0 = Math.min(tlStartMs, tlEndMs), t1 = Math.max(tlStartMs, tlEndMs);
    const concatA = timelineMsToSourceMs(videoClips, t0);
    if (concatA == null) { toast({ title: 'Ahí hay un hueco', description: 'Marca sobre un clip de vídeo.', variant: 'destructive' }); return; }
    const w = partWindowAtConcatMs(wins, concatA);
    if (!w) { toast({ title: 'Ahí no hay ninguna parte mezclada', variant: 'destructive' }); return; }
    // The end: on the same part if the range crosses a cut, else clamp to the part.
    const concatBRaw = timelineMsToSourceMs(videoClips, Math.max(t0, t1 - 1));
    const partEnd = w.concatStartMs + w.durationMs;
    const concatB = concatBRaw != null && partWindowAtConcatMs(wins, concatBRaw) === w
      ? concatBRaw + 1
      : Math.min(partEnd, concatA + (t1 - t0));
    const existing = regionsOf(w.part.id, kind);
    const start = Math.max(0, concatMsToWavMs(w, kind, concatA));
    const end = Math.max(start + 100, concatMsToWavMs(w, kind, concatB));
    const d = defaults[kind];
    const region: BoardDuckRegion = kind === 'noRaise' || kind === 'keepOpen'
      ? { id: uuidv4(), startMs: Math.round(start), endMs: Math.round(end), attenuationDb: 0, source: 'manual', enabled: true }
      : {
        id: uuidv4(),
        startMs: Math.round(start),
        endMs: Math.round(end),
        attenuationDb: d.db,
        source: 'manual',
        enabled: true,
        fadeInMs: d.fadeInMs,
        fadeOutMs: d.fadeOutMs,
        fadeShape: d.shape,
      };
    if (await save(w.part.id, kind, [...existing, region].sort((a, b) => a.startMs - b.startMs))) {
      setSel({ kind, partId: w.part.id, regionId: region.id });
      toast({
        title: KIND_LABEL[kind].added,
        description: kind === 'noRaise'
          ? 'Ahí el ambiente no subirá solo. Pulsa «Aplicar».'
          : kind === 'keepOpen'
          ? 'Ahí la puerta de mesa no cerrará. Pulsa «Aplicar».'
          : 'Arrastra los bordes para ajustarla y pulsa «Aplicar».',
      });
    }
  }, [videoClips, wins, regionsOf, save, toast, defaults]);

  // On each stem track, "new" means whatever that track's selector says:
  // subida/sin subir on the ambient, atenuar/mantener abierta on the mesa.
  const add = useCallback((kind: RegionKind) => {
    const k = kind === 'ambient' ? ambientNewKind : kind === 'board' ? boardNewKind : kind;
    return addRange(k, playheadMs, playheadMs + DEFAULT_NEW_MS);
  }, [addRange, playheadMs, ambientNewKind, boardNewKind]);

  // Drag = window-level listeners for the duration of the gesture, so the
  // band keeps following the pointer when it leaves the track.
  const beginDrag = useCallback((e: React.PointerEvent, p: PlacedRegion, mode: 'move' | 'start' | 'end') => {
    // Only stop propagation: preventDefault() on pointerdown would suppress
    // the compatibility click, and the ribbon's click is what seeks the playhead.
    e.stopPropagation();
    setSel({ kind: p.kind, partId: p.partId, regionId: p.region.id });
    // A gate closure is vetoed, never moved, and a retired raise's outline is
    // only there to be restored. An automatic RAISE can be dragged: the
    // gesture commits by making it a manual zone (see materializeAutoRaise).
    if (p.kind === 'autoGate' || (p.kind === 'noRaise' && p.region.retiresAuto)) return;
    const init: DragState = { regionId: p.region.id, startMs: p.region.startMs, endMs: p.region.endMs };
    dragRef.current = { id: p.region.id, kind: p.kind, partId: p.partId, mode, x0: e.clientX, s0: p.region.startMs, e0: p.region.endMs, last: init };
    setDrag(init);
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dMs = (ev.clientX - d.x0) / zoomLevel;
      let s = d.s0, en = d.e0;
      if (d.mode === 'move') { s = d.s0 + dMs; en = d.e0 + dMs; }
      else if (d.mode === 'start') s = Math.min(d.e0 - 100, d.s0 + dMs);
      else en = Math.max(d.s0 + 100, d.e0 + dMs);
      const next: DragState = { regionId: d.id, startMs: Math.max(0, Math.round(s)), endMs: Math.max(100, Math.round(en)) };
      d.last = next;
      setDrag(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      const { last } = d;
      if (last.startMs === d.s0 && last.endMs === d.e0) return;
      if (d.kind === 'autoRaise') {
        const auto = placedRef.current.find((x) => x.region.id === d.id);
        if (auto) void materializeAutoRaise(auto, { startMs: last.startMs, endMs: last.endMs });
        return;
      }
      const next = regionsOf(d.partId, d.kind).map((r) => (r.id === d.id ? { ...r, startMs: last.startMs, endMs: last.endMs } : r));
      void save(d.partId, d.kind, next);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [zoomLevel, regionsOf, save, materializeAutoRaise]);

  // Everything the join will demand, not just what THIS session edited: a zone
  // drawn before a reload lives on as a part at 'aligned' with `dirtyParts`
  // empty, and the join refuses while any part is unmixed (see
  // applyPendingParts). One join at the end, not one per part.
  // Pending = edited in this session, PLUS whatever the server already counts
  // as stale (a zone drawn before a reload lives on only as status 'aligned').
  // Without the union the apply bar never came back after a reload and the
  // join kept failing with «Partes sin procesar» on that part.
  const pendingParts = useMemo(() => {
    const set = new Set(dirtyParts);
    for (const w of wins) if (partNeedsRemix(w.part)) set.add(w.part.id);
    return set;
  }, [dirtyParts, wins]);

  const applyAll = useCallback(async () => {
    if (pendingParts.size === 0) return;
    const parts = currentProject?.parts ?? [];
    setBusy('Re-mezclando…');
    const r = await applyPendingParts(projectId, parts, Array.from(pendingParts), (m) => setBusy(m));
    if (!r.ok) { toast({ title: 'No se pudo aplicar', description: r.error, variant: 'destructive' }); setBusy(null); return; }
    await fetchProject(projectId);
    setDirtyParts(new Set());
    setBusy(null);
    toast({ title: 'Audio actualizado', description: 'La mezcla ya lleva tus cambios.' });
  }, [pendingParts, currentProject?.parts, projectId, fetchProject, toast]);

  // Parts mixed before the engine persisted its raises: compute them once
  // (same analysis as the mix, ~3 s, no re-mix) so their boxes can show.
  useEffect(() => {
    for (const w of wins) {
      const part = w.part;
      if (!part.mixedAt) continue;
      // The same run decides both lists, so ask for it when EITHER is missing.
      const needRaises = !!part.ambientDuckOnVoice && part.ambientAutoRaises === undefined;
      const needGates = !!part.boardSpeechLevel && !!part.boardGate && part.boardAutoGates === undefined;
      if (!needRaises && !needGates) continue;
      if (autoRequested.current.has(part.id)) continue;
      autoRequested.current.add(part.id);
      setAutoMsg(needGates && !needRaises
        ? `Calculando la puerta de mesa de ${part.name}…`
        : `Calculando las subidas automáticas${needGates ? ' y la puerta de mesa' : ''} de ${part.name}…`);
      void fetch(`/api/projects/${projectId}/parts/${part.id}/auto-raises`, { method: 'POST' })
        .then(async (r) => { if (r.ok) await fetchProject(projectId); })
        .catch(() => { /* the boxes just stay absent */ })
        .finally(() => setAutoMsg(null));
    }
  }, [wins, projectId, fetchProject]);

  // Forecasts: one per part whose ambient edits are not in the mix yet — the
  // apply bar is showing for it, or its chain description no longer matches
  // what was mixed (e.g. after a reload). Nothing pending → null, and the
  // lane draws the real files.
  const plans = useMemo(() => {
    const m = new Map<string, AmbientPlan>();
    for (const w of wins) {
      const pending = pendingParts.has(w.part.id) ||
        (!!w.part.mixChainApplied && describeAmbientChain(w.part) !== w.part.mixChainApplied.ambient);
      if (pending) m.set(w.part.id, buildAmbientPlan(w.part, w.ambientTrimMs));
    }
    return m;
  }, [wins, pendingParts]);
  const ambientPlanFor = useCallback((partId: string) => plans.get(partId) ?? null, [plans]);
  const ambientPlanForFile = useCallback((fileName: string) => {
    const m = /^part_([0-9a-f]{8})_amb_proc\.wav$/i.exec(fileName);
    if (!m) return null;
    const w = wins.find((x) => x.part.id.slice(0, 8).toLowerCase() === m[1].toLowerCase());
    return w ? plans.get(w.part.id) ?? null : null;
  }, [plans, wins]);

  // Drop a stale selection when its region disappears (deleted elsewhere).
  useEffect(() => {
    if (sel && !placed.some((p) => p.region.id === sel.regionId)) setSel(null);
  }, [placed, sel]);

  const value = useMemo<Ctx>(() => ({
    projectId, wins, placed, videoClips, sel, selected, select, remove, update, defaults, setDefaults, add, addRange, beginDrag, drag,
    toPx, fromPx, drawKind, setDrawKind, ambientNewKind, setAmbientNewKind, boardNewKind, setBoardNewKind, zoomLevel, viewportWidthPx, onSeek, dirtyParts: pendingParts, busy, autoMsg, applyAll, stemTracksPresent, materializeAutoRaise,
    ambientPlanFor, ambientPlanForFile,
  }), [projectId, wins, placed, videoClips, sel, selected, select, remove, update, defaults, setDefaults, add, addRange, beginDrag, drag, toPx, fromPx, drawKind, ambientNewKind, boardNewKind, zoomLevel, viewportWidthPx, onSeek, pendingParts, busy, autoMsg, applyAll, stemTracksPresent, materializeAutoRaise, ambientPlanFor, ambientPlanForFile]);

  return <AudioRegionsCtx.Provider value={value}>{children}</AudioRegionsCtx.Provider>;
}

const STYLE: Record<RegionKind, { tint: string; edge: string; ribbon: string; text: string; fill: string; stroke: string }> = {
  board: { tint: 'bg-red-500/20', edge: 'border-red-300/80', ribbon: 'bg-red-600/85', text: 'text-red-100', fill: 'rgba(239,68,68,0.28)', stroke: 'rgba(252,165,165,0.9)' },
  ambient: { tint: 'bg-sky-400/15', edge: 'border-sky-200/80', ribbon: 'bg-sky-600/85', text: 'text-sky-50', fill: 'rgba(56,189,248,0.28)', stroke: 'rgba(186,230,253,0.95)' },
  noRaise: { tint: 'bg-rose-500/25', edge: 'border-rose-300/80', ribbon: 'bg-rose-700/90', text: 'text-rose-50', fill: 'rgba(244,63,94,0.30)', stroke: 'rgba(253,164,175,0.9)' },
  autoRaise: { tint: 'bg-transparent', edge: 'border-sky-200/60', ribbon: 'bg-sky-900/85', text: 'text-sky-100', fill: 'rgba(125,211,252,0.07)', stroke: 'rgba(186,230,253,0.8)' },
  keepOpen: { tint: 'bg-emerald-500/25', edge: 'border-emerald-300/80', ribbon: 'bg-emerald-700/90', text: 'text-emerald-50', fill: 'rgba(16,185,129,0.30)', stroke: 'rgba(110,231,183,0.9)' },
  // Near-transparent: the gate closes between virtually every phrase, so a
  // solid tint would bury the mesa waveform under hundreds of boxes.
  autoGate: { tint: 'bg-transparent', edge: 'border-amber-200/60', ribbon: 'bg-amber-900/70', text: 'text-amber-100', fill: 'rgba(251,191,36,0.06)', stroke: 'rgba(253,230,138,0.75)' },
};
// A retired automatic raise (✕ on its box): not a zone of the user's, so no
// red band — a faint dashed outline that says "here the engine would have
// raised" and can be selected to bring the raise back.
const GHOST_STYLE: (typeof STYLE)['noRaise'] = { tint: 'bg-transparent', edge: 'border-rose-300/40', ribbon: 'bg-transparent', text: 'text-rose-200/70', fill: 'rgba(0,0,0,0)', stroke: 'rgba(253,164,175,0.45)' };

/**
 * The bands of ONE kind, as an absolute overlay inside a `relative` track
 * body. Only the top ribbon and the two edge handles take the pointer — the
 * rest passes through, so the stem clip underneath stays clickable (volume,
 * cutting). Ambient raises are drawn as the CURVE they really are: a ramp of
 * `fadeInMs`, the plateau, a ramp of `fadeOutMs`.
 */
export function RegionBands({ kind }: { kind: RegionKind }) {
  const ctx = useAudioRegions();
  if (!ctx) return null;
  const { placed, sel, select, remove, beginDrag, drag, toPx, zoomLevel, viewportWidthPx, onSeek, wins, videoClips } = ctx;

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {placed.filter((p) => p.kind === kind).map((p) => {
        const w = wins.find((x) => x.part.id === p.partId);
        if (!w) return null;
        const ghost = kind === 'noRaise' && !!p.region.retiresAuto;
        const st = ghost ? GHOST_STYLE : STYLE[kind];
        const live = drag && drag.regionId === p.region.id ? drag : null;
        const startWav = live ? Math.min(live.startMs, live.endMs) : Math.min(p.region.startMs, p.region.endMs);
        const endWav = live ? Math.max(live.startMs, live.endMs) : Math.max(p.region.startMs, p.region.endMs);
        const fadeIn = p.region.fadeInMs ?? 0;
        const fadeOut = p.region.fadeOutMs ?? 0;
        const up = p.db >= 0;
        const curved = p.region.fadeShape === 'curve';
        const extA = wavMsToConcatMs(w, kind, startWav - fadeIn);
        const extB = wavMsToConcatMs(w, kind, endWav + fadeOut);
        const plA = wavMsToConcatMs(w, kind, startWav);
        const plB = wavMsToConcatMs(w, kind, endWav);
        const spans = sourceRangeToTimelineSpans(videoClips, extA, extB);
        const selected = sel?.regionId === p.region.id;
        const readOnly = kind === 'autoRaise' || kind === 'autoGate' || ghost;
        // Levels are dB over the ORIGINAL ambient for boxes and zones alike;
        // the swing the ear notices is from the level WITH voice, so the box
        // spells that out too ("+4" over a −8 duck is a 12 dB step).
        const duckDb = w.part.ambientDuckOnVoice ? Math.max(1, Math.min(60, w.part.ambientVoiceDuckDb ?? 8)) : 0;
        const label = ghost ? 'anulada'
          : kind === 'noRaise' ? 'sin subida'
          : kind === 'keepOpen' ? 'mesa abierta'
          : kind === 'autoGate' ? `puerta ${p.db} dB`
          : kind === 'autoRaise' ? `+${p.db} dB auto`
          : `${p.db > 0 ? '+' : ''}${p.db} dB`;
        return spans.map((sp, i) => {
          const left = toPx(sp.startMs);
          const width = Math.max(2, (sp.endMs - sp.startMs) * zoomLevel);
          if (left + width < -100 || left > viewportWidthPx + 100) return null;
          // Plateau inside this span (timeline px, relative to the span).
          const tA = sourceMsToTimelineMs(videoClips, plA), tB = sourceMsToTimelineMs(videoClips, plB);
          const pa = Math.max(0, ((tA ?? sp.startMs) - sp.startMs) * zoomLevel);
          const pb = Math.min(width, ((tB ?? sp.endMs) - sp.startMs) * zoomLevel);
          const rampIn = Math.max(0, Math.min(width, pa)), rampOut = Math.max(0, width - Math.max(pb, pa));
          return (
            <div
              key={`${p.region.id}-${i}`}
              className={`absolute top-0 bottom-0 ${st.tint} ${selected ? 'ring-2 ring-white/80' : ''}`}
              style={{ left, width }}
              title={kind === 'autoRaise'
                ? `Subida automática del motor: +${p.db} dB sobre el ambiente original${duckDb > 0 ? ` (${p.db + duckDb} dB por encima del nivel con voz, −${duckDb})` : ''} · arrastra sus bordes o la cinta para hacerla tuya y ajustarla · ✕ o Supr para anularla · ${p.partName}`
                : kind === 'autoGate'
                ? `Cierre automático de la puerta de mesa (${p.db} dB, según los ajustes actuales) · ✕ o Supr para mantenerla abierta · ${p.partName}`
                : kind === 'keepOpen'
                ? `Aquí la puerta de mesa NO cierra (el cierre automático queda anulado) · ${p.partName}`
                : ghost
                ? `Subida automática anulada: el ambiente se queda al nivel con voz · selecciónala y ✕ (o Supr) para recuperarla · ${p.partName}`
                : kind === 'noRaise'
                ? `Aquí el ambiente NO sube solo (la subida automática queda anulada) · ${p.partName}`
                : kind === 'ambient'
                ? `Ambiente ${label} sobre el original — sustituye a lo automático en su tramo${duckDb > 0 ? ` (con voz el ambiente va a −${duckDb})` : ''} · rampas ${fadeIn}/${fadeOut} ms ${curved ? 'curva' : 'lineal'} · ${p.partName}`
                : `Mesa ${label} · rampas ${fadeIn}/${fadeOut} ms ${curved ? 'curva' : 'lineal'} · ${p.partName}${p.region.source !== 'manual' ? ` · ${p.region.source}` : ''}`}
            >
              {/* Gain-over-time silhouette: rises from the bottom (raise) or drops from the top (attenuation). */}
              <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${Math.max(1, width)} 100`} preserveAspectRatio="none" aria-hidden>
                <polygon points={gainPolygon(width, rampIn, rampOut, up, curved, p.db)} fill={st.fill} stroke={st.stroke} strokeWidth="1.5" strokeDasharray={readOnly ? '4 3' : undefined} vectorEffect="non-scaling-stroke" />
              </svg>
              {/* Ribbon: the interactive strip (select, move, delete, label). */}
              <div
                role="button"
                tabIndex={0}
                className={`pointer-events-auto absolute left-0 right-0 top-0 flex h-[15px] ${kind === 'autoGate' && width < 8 ? 'opacity-0' : ''} ${kind === 'autoGate' || ghost ? 'cursor-pointer' : 'cursor-grab'} items-center justify-between gap-1 px-1 ${st.ribbon} ${st.text} text-[9px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-white/80`}
                onPointerDown={(e) => beginDrag(e, p, 'move')}
                onClick={(e) => { e.stopPropagation(); select(p); onSeek?.(sp.startMs); }}
                onKeyDown={(e) => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); void remove(p); } }}
              >
                <span className="truncate">{width > 44 ? label : ''}</span>
                {selected && width > 30 && (
                  <button
                    type="button"
                    className="rounded bg-black/40 p-[1px] hover:bg-black/70"
                    title={kind === 'autoRaise' ? 'Anular esta subida automática (Supr)'
                  : kind === 'autoGate' ? 'Mantener la mesa abierta aquí (Supr)'
                  : ghost ? 'Recuperar la subida automática (Supr)'
                  : 'Borrar este cambio (Supr)'}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); void remove(p); }}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
              {/* Plateau edges: resize. */}
              {width > 20 && kind !== 'autoGate' && !ghost && (
                <>
                  <div className="pointer-events-auto absolute top-0 bottom-0 w-2 cursor-ew-resize" style={{ left: Math.max(0, pa - 4) }} title="Arrastra para cambiar el inicio" onPointerDown={(e) => beginDrag(e, p, 'start')} />
                  <div className="pointer-events-auto absolute top-0 bottom-0 w-2 cursor-ew-resize" style={{ left: Math.min(width - 4, pb - 4) }} title="Arrastra para cambiar el final" onPointerDown={(e) => beginDrag(e, p, 'end')} />
                </>
              )}
            </div>
          );
        });
      })}
    </div>
  );
}

/**
 * Silhouette of a region's gain over time in a 0..100 viewBox: base line at
 * the bottom (a raise) or the top (an attenuation), ramps as long as the
 * fades — straight, or S-shaped (smoothstep, the same curve FFmpeg applies).
 */
function gainPolygon(width: number, rampIn: number, rampOut: number, up: boolean, curved: boolean, db: number): string {
  const base = up ? 100 : 0;
  // Height follows the dB: a +4 automatic raise is a low step, a +20 manual
  // one nearly fills the lane, a 0 dB veto is a shallow lid.
  const reach = Math.min(96, 96 * (0.3 + Math.abs(db) / 30));
  const top = up ? 100 - reach : reach;
  const plateauEnd = Math.max(rampIn, width - rampOut);
  const pts: string[] = [`0,${base}`];
  const ramp = (x0: number, x1: number, y0: number, y1: number) => {
    if (!curved || x1 - x0 < 1) { pts.push(`${x1.toFixed(1)},${y1}`); return; }
    for (let k = 1; k <= 8; k++) {
      const u = k / 8;
      const sm = u * u * (3 - 2 * u);
      pts.push(`${(x0 + (x1 - x0) * u).toFixed(1)},${(y0 + (y1 - y0) * sm).toFixed(1)}`);
    }
  };
  ramp(0, rampIn, base, top);
  pts.push(`${plateauEnd.toFixed(1)},${top}`);
  ramp(plateauEnd, width, top, base);
  return pts.join(' ');
}

function NumBox({ value, min, max, title, className, onCommit }: {
  value: number; min: number; max: number; title: string; className?: string; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = parseFloat(draft);
    if (!Number.isFinite(n)) { setDraft(String(value)); return; }
    const v = Math.min(max, Math.max(min, Math.round(n)));
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      title={title}
      className={`h-[15px] rounded border border-border bg-background px-0.5 text-[9px] tabular-nums text-foreground outline-none focus:border-primary ${className ?? ''}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/**
 * The little form in a Mesa/Ambiente track header: dB, fade-in/out and ramp
 * shape. With a region of that kind SELECTED it edits that region (PATCHed on
 * commit); otherwise it sets what NEW regions of the kind are born with (kept
 * per project in localStorage). Either kind may raise or attenuate.
 */
export function RegionKindControls({ kind }: { kind: RegionKind }) {
  const ctx = useAudioRegions();
  if (!ctx) return null;
  // The header column is 120 px wide (104 px inside its padding), so the type
  // row drops its label into a tooltip and the buttons never wrap their text —
  // a wrapped label inside a 15 px button spills over the rows below.
  // "abrir" only makes sense when some part runs the mesa gate (opt-in).
  const anyGate = ctx.wins.some((w) => !!w.part.boardGate && !!w.part.boardSpeechLevel);
  const typeRow = kind === 'board' && !anyGate ? null : kind === 'board' ? (
    <div className="flex items-center gap-1" title="Qué crea el lápiz / el ＋ en esta pista">
      {(['board', 'keepOpen'] as const).map((k) => (
        <button
          key={k}
          type="button"
          className={`h-[15px] flex-1 truncate whitespace-nowrap rounded border px-1 text-[9px] ${ctx.boardNewKind === k ? (k === 'keepOpen' ? 'border-emerald-400 bg-emerald-500/25 text-emerald-100' : 'border-red-400 bg-red-500/25 text-red-100') : 'border-border bg-background text-muted-foreground hover:border-primary'}`}
          title={k === 'keepOpen' ? 'Zona verde: ahí la puerta de mesa NO cierra (anula el cierre automático que apaga el final de las frases)' : 'Zona roja: atenuación (o amplificación) manual de la mesa con estos dB y rampas'}
          onClick={() => ctx.setBoardNewKind(k)}
        >
          {k === 'keepOpen' ? 'abrir' : 'atenuar'}
        </button>
      ))}
    </div>
  ) : kind === 'ambient' ? (
    <div className="flex items-center gap-1" title="Qué crea el lápiz / el ＋ en esta pista">
      {(['ambient', 'noRaise'] as const).map((k) => (
        <button
          key={k}
          type="button"
          className={`h-[15px] flex-1 truncate whitespace-nowrap rounded border px-1 text-[9px] ${ctx.ambientNewKind === k ? (k === 'noRaise' ? 'border-rose-400 bg-rose-500/25 text-rose-100' : 'border-sky-400 bg-sky-500/25 text-sky-100') : 'border-border bg-background text-muted-foreground hover:border-primary'}`}
          title={k === 'noRaise' ? 'Zona roja: ahí el ambiente NO sube solo (anula la subida automática)' : 'Zona azul: subida (o bajada) manual del ambiente con estos dB y rampas'}
          onClick={() => ctx.setAmbientNewKind(k)}
        >
          {k === 'noRaise' ? 'sin subir' : 'subida'}
        </button>
      ))}
    </div>
  ) : null;
  if (kind === 'board' && ctx.selected?.kind === 'autoGate') {
    return (
      <div className="space-y-px text-[9px] leading-none" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {typeRow}
        <div className="truncate text-amber-200" title="La decidió la puerta de mesa con los ajustes actuales: ahí la mesa baja porque el motor no oyó voz. ✕ o Supr la anula con una zona verde.">puerta auto {ctx.selected.db} dB</div>
        <div className="truncate text-muted-foreground">✕ / Supr = mantener abierta</div>
      </div>
    );
  }
  if (kind === 'board' && ctx.selected?.kind === 'keepOpen') {
    return (
      <div className="space-y-px text-[9px] leading-none" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {typeRow}
        <div className="truncate text-emerald-200" title="Zona seleccionada: la puerta de mesa no cierra ahí. ✕ o Supr para borrarla; arrastra sus bordes para ajustarla.">zona: mesa abierta</div>
      </div>
    );
  }
  if (kind === 'ambient' && ctx.selected?.kind === 'autoRaise') {
    const auto = ctx.selected;
    return (
      <div className="space-y-px text-[9px] leading-none" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {typeRow}
        <div className="flex items-center gap-1">
          <span className="w-7 truncate text-sky-300" title={`Subida decidida por el motor: +${auto.db} dB sobre el ambiente original. Cambia el número (o arrastra sus bordes en la pista) y pasa a ser una zona tuya con ese nivel, editable del todo. ✕ o Supr la anula.`}>auto</span>
          <NumBox value={auto.db} min={REGION_DB_MIN} max={REGION_DB_MAX} className="w-9" title="dB sobre el ambiente original (el motor eligió estos). Otro número = zona tuya con ese nivel" onCommit={(v) => void ctx.materializeAutoRaise(auto, { absoluteDb: v })} />
          <span className="text-muted-foreground">dB</span>
        </div>
        <button
          type="button"
          className="w-full truncate rounded border border-sky-400/60 bg-sky-500/15 px-1 text-[9px] text-sky-100 hover:bg-sky-500/25"
          title="Convierte esta subida automática en una zona tuya: podrás arrastrarla, alargarla y darle otras rampas"
          onClick={() => void ctx.materializeAutoRaise(auto)}
        >
          hacer editable
        </button>
      </div>
    );
  }
  if (kind === 'ambient' && ctx.selected?.kind === 'noRaise') {
    const retired = !!ctx.selected.region.retiresAuto;
    return (
      <div className="space-y-px text-[9px] leading-none" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {typeRow}
        {retired ? (
          <>
            <div className="truncate text-rose-200/80" title="Subida automática anulada con ✕: el ambiente se queda al nivel con voz. ✕ o Supr la recupera.">subida anulada</div>
            <div className="truncate text-muted-foreground">✕ / Supr = recuperarla</div>
          </>
        ) : (
          <div className="truncate text-rose-200" title="Zona seleccionada: la subida automática queda anulada ahí. ✕ o Supr para borrarla; arrastra sus bordes para ajustarla.">zona: sin subida</div>
        )}
      </div>
    );
  }
  const target = ctx.selected && ctx.selected.kind === kind ? ctx.selected : null;
  const d = ctx.defaults[kind];
  const cur: RegionDefaults = target
    ? {
      db: target.region.attenuationDb,
      fadeInMs: target.region.fadeInMs ?? d.fadeInMs,
      fadeOutMs: target.region.fadeOutMs ?? d.fadeOutMs,
      shape: target.region.fadeShape ?? 'linear',
    }
    : d;
  const apply = (patch: Partial<RegionDefaults>) => {
    if (target) {
      void ctx.update(target, {
        ...(patch.db != null ? { attenuationDb: patch.db } : {}),
        ...(patch.fadeInMs != null ? { fadeInMs: patch.fadeInMs } : {}),
        ...(patch.fadeOutMs != null ? { fadeOutMs: patch.fadeOutMs } : {}),
        ...(patch.shape ? { fadeShape: patch.shape } : {}),
      });
    } else {
      ctx.setDefaults(kind, patch);
    }
  };
  const who = target ? 'zona' : 'nuevas';
  const whoTitle = target
    ? 'Editas la zona seleccionada (se guarda al salir del campo; «Aplicar» para oírlo)'
    : 'Valores con los que nacen las zonas nuevas de esta pista (＋, lápiz). Selecciona una zona para editarla.';
  return (
    <div
      className="space-y-px text-[9px] leading-none"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {typeRow}
      <div className="flex items-center gap-1">
        <span className={`w-7 truncate ${target ? 'text-amber-300' : 'text-muted-foreground'}`} title={whoTitle}>{who}</span>
        <NumBox value={cur.db} min={REGION_DB_MIN} max={REGION_DB_MAX} className="w-9" title={kind === 'ambient' ? 'dB sobre el ambiente original: en la zona el ambiente queda a este nivel (sustituye a lo automático), negativo lo baja' : 'dB: negativo atenúa, positivo amplifica'} onCommit={(v) => apply({ db: v })} />
        <span className="text-muted-foreground">dB</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-7 text-muted-foreground" title="Rampas de entrada y salida, en ms (fuera de la zona marcada)">fade</span>
        <NumBox value={cur.fadeInMs} min={0} max={REGION_FADE_MAX} className="w-8" title="Rampa de entrada (ms)" onCommit={(v) => apply({ fadeInMs: v })} />
        <NumBox value={cur.fadeOutMs} min={0} max={REGION_FADE_MAX} className="w-8" title="Rampa de salida (ms)" onCommit={(v) => apply({ fadeOutMs: v })} />
      </div>
      <div className="flex items-center gap-1">
        <span className="w-7 text-muted-foreground">rampa</span>
        <button
          type="button"
          className="h-[15px] rounded border border-border bg-background px-1 text-[9px] hover:border-primary"
          title="Forma de las rampas: lineal (recta) o curva (suave al empezar y al acabar)"
          onClick={() => apply({ shape: cur.shape === 'curve' ? 'linear' : 'curve' })}
        >
          {cur.shape === 'curve' ? 'curva' : 'lineal'}
        </button>
      </div>
    </div>
  );
}

/**
 * The PENCIL: a transparent layer over a stem track (while its pencil is on)
 * or over a fallback lane row (always) where a DRAG draws a new region across
 * the dragged range and a plain CLICK drops the default 800 ms one at that
 * point. It sits under the bands (z-10 vs z-20) so existing bands keep their
 * ribbon/handles, and above the clip so the clip's own move/select never
 * starts from a pencil gesture.
 */
export function RegionDrawLayer({ kind }: { kind: RegionKind }) {
  const ctx = useAudioRegions();
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<{ a: number; b: number } | null>(null);
  const gesture = useRef<{ x0: number; ms0: number; last: number } | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const effKind: RegionKind = !ctx ? kind : kind === 'ambient' ? ctx.ambientNewKind : kind === 'board' ? ctx.boardNewKind : kind;
  const st = STYLE[effKind];

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const c = ctxRef.current;
    const el = ref.current;
    if (!c || !el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const px0 = e.clientX - rect.left;
    gesture.current = { x0: px0, ms0: c.fromPx(px0), last: px0 };
    setLive({ a: px0, b: px0 });
    const onMove = (ev: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const px = ev.clientX - rect.left;
      g.last = px;
      setLive({ a: Math.min(g.x0, px), b: Math.max(g.x0, px) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const g = gesture.current;
      gesture.current = null;
      setLive(null);
      const cc = ctxRef.current;
      if (!g || !cc) return;
      const k: RegionKind = kind === 'ambient' ? cc.ambientNewKind : kind === 'board' ? cc.boardNewKind : kind;
      if (Math.abs(g.last - g.x0) < 4) {
        void cc.addRange(k, g.ms0, g.ms0 + DEFAULT_NEW_MS);
      } else {
        void cc.addRange(k, g.ms0, cc.fromPx(g.last));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [kind]);

  if (!ctx) return null;
  return (
    <div
      ref={ref}
      className="absolute inset-0 z-10 cursor-crosshair"
      title={effKind === 'board' ? 'Arrastra para marcar una zona de mesa (clic = 0,8 s aquí)'
        : effKind === 'keepOpen' ? 'Arrastra para marcar dónde la puerta de mesa NO debe cerrar (clic = 0,8 s aquí)'
        : effKind === 'noRaise' ? 'Arrastra para marcar dónde NO debe subir solo el ambiente (clic = 0,8 s aquí)'
        : 'Arrastra para marcar una subida/bajada de ambiente (clic = 0,8 s aquí)'}
      onPointerDown={onPointerDown}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {live && live.b - live.a >= 1 && (
        <div className={`pointer-events-none absolute top-0 bottom-0 border-x ${st.edge} ${st.tint}`} style={{ left: live.a, width: live.b - live.a }} />
      )}
    </div>
  );
}

const WAVE_COLOR: Record<RegionKind, string> = {
  board: 'rgba(52,211,153,0.95)',
  ambient: 'rgba(56,189,248,0.95)',
  noRaise: 'rgba(56,189,248,0.95)',
  autoRaise: 'rgba(56,189,248,0.95)',
  keepOpen: 'rgba(52,211,153,0.95)',
  autoGate: 'rgba(52,211,153,0.95)',
};

/**
 * The SIGNAL of one kind drawn across the fallback lane, on the timeline's own
 * axis — the same picture the separated stem tracks show, for the projects
 * where the stems are not separated: the ORIGINAL in gray (raw mesa / camera)
 * with the PROCESSED result over it in colour, so an attenuation reads as gray
 * pulses with no colour and a raise as colour above the gray.
 *
 * Clocks: a part's stem file starts `muxedTrimMs` before the muxed video, so
 * for concat time t inside part k the stem time is (t − concatStart_k) + trim_k
 * (same mapping `computeStemLayout` uses); the cuts come from the editor's main
 * video clips, so a stretch the user cut out simply isn't drawn.
 */
export function RegionTrackWaveform({ kind }: { kind: RegionKind }) {
  const ctx = useAudioRegions();
  if (!ctx) return null;
  const { wins, videoClips, toPx, zoomLevel, viewportWidthPx, ambientPlanFor } = ctx;
  return (
    <>
      {wins.map((w) => {
        const id8 = w.part.id.slice(0, 8);
        if (!w.part.boardSourceId) return null;
        const plan = kind === 'ambient' ? ambientPlanFor(w.part.id) : null;
        const procFile = `part_${id8}_${kind === 'board' ? 'board' : 'amb'}_proc.wav`;
        const behind = kind === 'board'
          ? { fileName: `part_${id8}_board.wav`, offsetMs: w.boardTrimMs }
          : (w.part.videoSourceId ? { fileName: `${w.part.videoSourceId}_audio.wav`, offsetMs: w.ambientTrimMs } : null);
        const winA = w.concatStartMs;
        const winB = w.concatStartMs + w.durationMs;
        return videoClips.map((c) => {
          const a = Math.max(winA, c.sourceInMs);
          const b = Math.min(winB, c.sourceOutMs);
          if (b - a < 20) return null;
          const t0 = c.timelineStartMs + (a - c.sourceInMs);
          const left = toPx(t0);
          const width = (b - a) * zoomLevel;
          if (left + width < -200 || left > viewportWidthPx + 200) return null;
          const sIn = (a - w.concatStartMs) + w.muxedTrimMs;
          return (
            <div key={`${w.part.id}-${c.id}`} className="absolute top-0 bottom-0" style={{ left, width }}>
              <ClipWaveform
                fileName={procFile}
                sourceInMs={sIn}
                sourceOutMs={sIn + (b - a)}
                leftPx={left}
                widthPx={width}
                viewportWidthPx={viewportWidthPx}
                color={WAVE_COLOR[kind]}
                behind={behind}
                plan={plan}
              />
            </div>
          );
        });
      })}
    </>
  );
}

/** "Cambios guardados, pulsa Aplicar" — rendered once per timeline, below the tracks. */
export function RegionsApplyBar() {
  const ctx = useAudioRegions();
  if (!ctx || (ctx.dirtyParts.size === 0 && !ctx.busy && !ctx.autoMsg)) return null;
  const dirty = ctx.dirtyParts.size > 0;
  return (
    <div className="sticky bottom-0 z-40 flex items-center gap-2 border-y border-border bg-[#1c1607] px-2 py-1">
      <span className="text-[10px] text-amber-200">{ctx.busy ?? (dirty ? 'Cambios de mesa/ambiente guardados. El audio de la mezcla todavía no los lleva.' : ctx.autoMsg)}</span>
      {ctx.autoMsg && dirty && !ctx.busy && <span className="text-[10px] text-sky-200">{ctx.autoMsg}</span>}
      {dirty && <button
        type="button"
        disabled={!!ctx.busy}
        onClick={() => void ctx.applyAll()}
        className="flex items-center gap-1 rounded border border-primary/60 bg-primary/15 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/25 disabled:opacity-50"
      >
        {ctx.busy && <Loader2 className="h-3 w-3 animate-spin" />}
        Aplicar (re-mezclar audio)
      </button>}
    </div>
  );
}
