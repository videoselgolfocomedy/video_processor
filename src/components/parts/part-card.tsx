'use client';

import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { partTrims, partUsedRanges } from '@/lib/part-trims';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import { AlignmentView } from '@/components/audio/alignment-view';
import { AlignmentEarCheck } from '@/components/audio/alignment-ear-check';
import { BoardDuckingPanel } from '@/components/audio/board-ducking-panel';
import { TrackRow } from '@/components/parts/track-row';
import { LevelerCurve } from '@/components/parts/leveler-curve';
import { AmbientDuckDiagram } from '@/components/parts/ambient-duck-diagram';
import { MixStackView } from '@/components/parts/mix-stack-view';
import { describeBoardChain, describeAmbientChain, describeMixChain } from '@/lib/part-chain-description';
import type { LevelStats } from '@/lib/level-stats';
import type { ProjectPart, SourceFile } from '@/types/project';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';

const STAGE_LABELS: Record<NonNullable<ProjectPart['stage']>, string> = {
  extract: 'Extrayendo audio',
  align: 'Alineando',
  mix: 'Mezclando',
  mux: 'Generando vídeo',
};

export function formatDurationMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** ms → "m:ss.d" with sign, for the offset display. */
function formatOffsetMs(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms) / 1000;
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${sign}${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Parse "mm:ss", "h:mm:ss" or plain seconds into ms. Empty string → null
 *  (clears the value); unparseable → 'invalid'. */
function parseWindowInput(str: string): number | null | 'invalid' {
  const t = str.trim();
  if (!t) return null;
  const parts = t.split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return 'invalid';
  let sec = 0;
  for (const n of parts.map(Number)) {
    if (n < 0) return 'invalid';
    sec = sec * 60 + n;
  }
  return Math.round(sec * 1000);
}

const SELECT_CLASS =
  'h-8 w-full rounded-md border border-input bg-background px-2 text-xs';

/** "de [mm:ss] a [mm:ss]" for a source range; both fields commit on blur,
 *  one empty field clears the range. */
function RangeRow({ label, color, value, fileDurMs, disabled, hint, onChange, onInvalid }: {
  label: string;
  color: string;
  value: { startMs: number; endMs: number } | undefined;
  fileDurMs?: number;
  disabled: boolean;
  hint: string;
  onChange: (r: { startMs: number; endMs: number } | null) => void;
  onInvalid: () => void;
}) {
  const [startStr, setStartStr] = useState(value ? formatOffsetMs(value.startMs) : '');
  const [endStr, setEndStr] = useState(value ? formatOffsetMs(value.endMs) : '');
  useEffect(() => {
    setStartStr(value ? formatOffsetMs(value.startMs) : '');
    setEndStr(value ? formatOffsetMs(value.endMs) : '');
  }, [value?.startMs, value?.endMs]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (s: string, e: string) => {
    const a = parseWindowInput(s), b = parseWindowInput(e);
    if (a === 'invalid' || b === 'invalid') { onInvalid(); return; }
    if (a == null || b == null) { if (value) onChange(null); return; }
    if (b <= a + 1000) { onInvalid(); return; }
    if (value && value.startMs === a && value.endMs === b) return;
    onChange({ startMs: a, endMs: b });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`${color}`}>{label}</span>
      <Input placeholder="mm:ss" value={startStr} onChange={(e) => setStartStr(e.target.value)} onBlur={() => commit(startStr, endStr)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} disabled={disabled} className="h-7 w-24 font-mono text-xs" />
      <span className="text-muted-foreground">a</span>
      <Input placeholder="mm:ss" value={endStr} onChange={(e) => setEndStr(e.target.value)} onBlur={() => commit(startStr, endStr)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} disabled={disabled} className="h-7 w-24 font-mono text-xs" />
      {fileDurMs != null && <span className="text-[10px] text-muted-foreground">(dura {formatOffsetMs(fileDurMs).replace(/\.\d$/, '')})</span>}
      <span className="text-[10px] italic text-muted-foreground">{hint}</span>
    </div>
  );
}

interface PartCardProps {
  part: ProjectPart;
  projectId: string;
  sources: SourceFile[];
  index: number;
  total: number;
  anyProcessing: boolean;
  onRefresh: () => void;
  onMove: (partId: string, direction: -1 | 1) => void;
}

export function PartCard({
  part,
  projectId,
  sources,
  index,
  total,
  anyProcessing,
  onRefresh,
  onMove,
}: PartCardProps) {
  const { toast } = useToast();
  const isProcessing = part.status === 'processing';

  // --- Inline editable name --------------------------------------------
  const [nameDraft, setNameDraft] = useState(part.name);
  useEffect(() => setNameDraft(part.name), [part.name]);

  // --- Volume drafts (string so the input can be temporarily empty) -----
  const [boardVolStr, setBoardVolStr] = useState(String(part.boardVolume ?? 1));
  const [ambientVolStr, setAmbientVolStr] = useState(
    String(part.ambientVolume ?? 0.7)
  );
  const [gainStr, setGainStr] = useState(String(part.boardGainDb ?? 0));
  useEffect(() => setBoardVolStr(String(part.boardVolume ?? 1)), [part.boardVolume]);
  useEffect(
    () => setAmbientVolStr(String(part.ambientVolume ?? 0.7)),
    [part.ambientVolume]
  );
  useEffect(() => setGainStr(String(part.boardGainDb ?? 0)), [part.boardGainDb]);

  // --- Leveler/ducking number drafts — commit on blur, not per keystroke.
  // These 4 fields go through `patchAndRefresh` (PATCH + a full parts/project
  // reload), unlike the volume/gain drafts above (plain PATCH, no reload) —
  // wiring them straight to server state with an onChange-fires-every-key
  // handler meant every keystroke rewrote project.json AND re-fetched +
  // re-rendered the whole page (the "difícil de editar" / "todo pesado"
  // complaint). Same local-draft + blur-commit pattern as crop keyframes.
  const [ceilingStr, setCeilingStr] = useState(String(part.boardLevelCeilingDb ?? -3));
  const [kneeStr, setKneeStr] = useState(part.boardLevelKneeDb != null ? String(part.boardLevelKneeDb) : '');
  const [silenceStr, setSilenceStr] = useState(part.boardLevelSilenceDepthDb != null ? String(part.boardLevelSilenceDepthDb) : '');
  useEffect(() => setSilenceStr(part.boardLevelSilenceDepthDb != null ? String(part.boardLevelSilenceDepthDb) : ''), [part.boardLevelSilenceDepthDb]);
  const [duckDbStr, setDuckDbStr] = useState(String(part.ambientVoiceDuckDb ?? 8));
  const [releaseMsStr, setReleaseMsStr] = useState(String(part.ambientVoiceReleaseMs ?? 400));
  const [anticipateMsStr, setAnticipateMsStr] = useState(String(part.ambientVoiceAnticipateMs ?? 200));
  useEffect(() => setCeilingStr(String(part.boardLevelCeilingDb ?? -3)), [part.boardLevelCeilingDb]);
  useEffect(() => setDuckDbStr(String(part.ambientVoiceDuckDb ?? 8)), [part.ambientVoiceDuckDb]);
  useEffect(() => setReleaseMsStr(String(part.ambientVoiceReleaseMs ?? 400)), [part.ambientVoiceReleaseMs]);
  useEffect(() => setAnticipateMsStr(String(part.ambientVoiceAnticipateMs ?? 200)), [part.ambientVoiceAnticipateMs]);
  const [attackMsStr, setAttackMsStr] = useState(String(part.ambientVoiceAttackMs ?? 15));
  const [holdMsStr, setHoldMsStr] = useState(String(part.ambientVoiceHoldMs ?? 600));
  const [gapBoostStr, setGapBoostStr] = useState(String(part.ambientGapBoostDb ?? 0));
  const [preRiseStr, setPreRiseStr] = useState(String(part.ambientPreRiseMs ?? 150));
  const [gateStr, setGateStr] = useState(String(part.ambientGateDb ?? 6));
  useEffect(() => setAttackMsStr(String(part.ambientVoiceAttackMs ?? 15)), [part.ambientVoiceAttackMs]);
  useEffect(() => setHoldMsStr(String(part.ambientVoiceHoldMs ?? 600)), [part.ambientVoiceHoldMs]);
  useEffect(() => setGapBoostStr(String(part.ambientGapBoostDb ?? 0)), [part.ambientGapBoostDb]);
  useEffect(() => setPreRiseStr(String(part.ambientPreRiseMs ?? 150)), [part.ambientPreRiseMs]);
  useEffect(() => setGateStr(String(part.ambientGateDb ?? 6)), [part.ambientGateDb]);

  // Measured levels of the RAW board (from its TrackRow) — placed on the
  // leveler curve so the user reads "típica −38 → −20" directly.
  const [boardRawStats, setBoardRawStats] = useState<LevelStats | null>(null);
  const onBoardRawStats = useCallback((s: LevelStats | null) => setBoardRawStats(s), []);


  // --- SSE progress (per-row subscription, only while processing) -------
  const [sseProgress, setSseProgress] = useState<number | null>(null);
  const [sseMessage, setSseMessage] = useState('');

  // Stable callbacks: useSSE's effect depends on these — inline arrows would
  // recreate the EventSource every render (documented project pitfall).
  const handleProgress = useCallback((pct: number, msg: string) => {
    setSseProgress(pct);
    setSseMessage(msg);
  }, []);
  const handleComplete = useCallback(() => {
    setSseProgress(null);
    setSseMessage('');
    onRefresh();
  }, [onRefresh]);
  const handleError = useCallback(() => {
    setSseProgress(null);
    setSseMessage('');
    onRefresh();
  }, [onRefresh]);

  useSSE({
    jobId: isProcessing && part.jobId ? part.jobId : null,
    onProgress: handleProgress,
    onComplete: handleComplete,
    onError: handleError,
  });

  // --- API helpers -------------------------------------------------------
  const patchPart = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/parts/${part.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            (data as { error?: string }).error || `Error ${res.status}`
          );
        }
        return true;
      } catch (err) {
        toast({
          title: 'No se pudo actualizar la parte',
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        });
        return false;
      }
    },
    [projectId, part.id, toast]
  );

  const commitName = useCallback(async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === part.name) {
      setNameDraft(part.name);
      return;
    }
    const ok = await patchPart({ name: trimmed });
    if (ok) onRefresh();
    else setNameDraft(part.name);
  }, [nameDraft, part.name, patchPart, onRefresh]);

  const handleVideoChange = useCallback(
    async (sourceId: string) => {
      if (!sourceId || sourceId === part.videoSourceId) return;
      if (await patchPart({ videoSourceId: sourceId })) onRefresh();
    },
    [part.videoSourceId, patchPart, onRefresh]
  );

  const handleBoardChange = useCallback(
    async (sourceId: string) => {
      if (sourceId === (part.boardSourceId ?? '')) return;
      if (await patchPart({ boardSourceId: sourceId === '' ? null : sourceId }))
        onRefresh();
    },
    [part.boardSourceId, patchPart, onRefresh]
  );

  const handleGainChange = useCallback(
    (raw: string) => {
      setGainStr(raw);
      const v = Number(raw);
      if (raw !== '' && Number.isFinite(v)) {
        void patchPart({ boardGainDb: v });
      }
    },
    [patchPart]
  );

  const handleCompressChange = useCallback(
    (checked: boolean) => {
      void patchPart({ boardCompress: checked }).then((ok) => {
        if (ok) onRefresh();
      });
    },
    [patchPart, onRefresh]
  );

  // Single-part audio-only re-mix: the part video is already muxed for the
  // current offset, so "Mezclar y muxar" will only regenerate the audio
  // (seconds) instead of rewriting the 25+ GB video. Mirrors the fast-path
  // condition in runPartPipeline.
  const audioOnlyRemix =
    total === 1 && part.status === 'done' &&
    part.muxedForOffsetMs != null && part.muxedForOffsetMs === part.alignmentOffsetMs;

  const patchAndRefresh = useCallback(
    (fields: Record<string, unknown>) => {
      void patchPart(fields).then((ok) => { if (ok) onRefresh(); });
    },
    [patchPart, onRefresh]
  );

  // Commit a leveler/ducking draft on blur: clamp, skip the round-trip if
  // unchanged, and always resync the draft to the (possibly clamped) server
  // value afterwards so an out-of-range typed value snaps back visibly.
  const commitDraftNumber = useCallback(
    (field: string, raw: string, min: number, max: number, current: number, setDraft: (s: string) => void) => {
      const v = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(v)) { setDraft(String(current)); return; }
      const clamped = Math.min(max, Math.max(min, v));
      if (clamped === current) { setDraft(String(current)); return; }
      patchAndRefresh({ [field]: clamped });
    },
    [patchAndRefresh]
  );
  const commitOnEnter = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  }, []);

  // Settings preview: renders ~30 s of the REAL chain into part_*_prev_*.wav
  // without committing a full remix. When present, the "Procesada" rows show
  // these files instead of the last full mix's stems.
  const [preview, setPreview] = useState<{
    startSec: number; durSec: number; stamp: number;
    /** Chain descriptions snapshotted when the preview was generated. */
    chain: { board: string; ambient: string; mix: string };
  } | null>(null);

  // What the CURRENT settings would apply vs what the current mix applied —
  // "⚠ ajustes cambiados" everywhere the user might otherwise think the
  // player already reflects them.
  const chainNow = {
    board: describeBoardChain(part),
    ambient: describeAmbientChain(part),
    mix: describeMixChain(part),
  };
  const mixSettingsChanged = !!part.mixChainApplied && (
    part.mixChainApplied.board !== chainNow.board ||
    part.mixChainApplied.ambient !== chainNow.ambient ||
    part.mixChainApplied.mix !== chainNow.mix
  );
  const videoAudioStale = !!part.mixedAt && !!part.muxedAt && part.mixedAt > part.muxedAt;
  const fmtClock = (iso?: string) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const settingsWarning = mixSettingsChanged
    ? 'los ajustes actuales NO son los de esta mezcla — pulsa «Re-mezclar» (o «Probar 30 s») para oírlos'
    : undefined;
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewStartStr, setPreviewStartStr] = useState('');
  const runPreview = useCallback(async () => {
    const parsed = previewStartStr.trim() === '' ? null : parseWindowInput(previewStartStr);
    if (parsed === 'invalid') {
      toast({ title: 'Inicio no válido', description: 'Usa mm:ss o segundos', variant: 'destructive' });
      return;
    }
    const startSec = parsed != null ? parsed / 1000 : Math.round((part.muxedDurationMs ?? 60000) / 2000);
    setPreviewBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/parts/${part.id}/mix-preview?startSec=${startSec}&durSec=30`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error((d as { error?: string }).error || `Error ${res.status}`);
      setPreview({
        startSec, durSec: 30, stamp: Date.now(),
        chain: { board: describeBoardChain(part), ambient: describeAmbientChain(part), mix: describeMixChain(part) },
      });
    } catch (err) {
      toast({ title: 'Vista previa fallida', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setPreviewBusy(false);
    }
  }, [previewStartStr, part, projectId, toast]);

  // Manual-offset applier for the embedded AlignmentView: PATCH this part's
  // record (the server also rewrites the part's alignment JSON). Must throw
  // on failure — AlignmentView shows the toast.
  const applyOffsetViaPart = useCallback(
    async (offsetMs: number) => {
      const res = await fetch(`/api/projects/${projectId}/parts/${part.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alignmentOffsetMs: offsetMs }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `Error ${res.status}`);
      }
    },
    [projectId, part.id]
  );

  const startProcess = useCallback(
    async (mode: 'align' | 'mix' | 'full', opts?: { forceMux?: boolean }) => {
      const bv = Number(boardVolStr);
      const av = Number(ambientVolStr);
      const g = Number(gainStr);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/parts/${part.id}/process`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode,
              ...(opts?.forceMux ? { forceMux: true } : {}),
              boardVolume: Number.isFinite(bv) && bv >= 0 ? bv : 1,
              ambientVolume: Number.isFinite(av) && av >= 0 ? av : 0.7,
              boardGainDb: Number.isFinite(g) ? g : 0,
            }),
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            (data as { error?: string }).error || `Error ${res.status}`
          );
        }
        setSseProgress(0);
        setSseMessage('');
        // A full (re)mix supersedes any 30 s settings preview — clear it so
        // the "Procesada"/"Mezcla" rows show the NEW full result when it
        // lands, instead of staying stuck on the old preview window.
        if (mode !== 'align') setPreview(null);
        onRefresh();
      } catch (err) {
        toast({
          title: 'No se pudo iniciar el procesado',
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        });
      }
    },
    [part.id, boardVolStr, ambientVolStr, gainStr, projectId, onRefresh, toast]
  );

  const handleAlign = useCallback(() => {
    if (
      (part.status === 'aligned' || part.status === 'done') &&
      !window.confirm(`¿Realinear "${part.name}"? Se recalculará el offset por correlación.`)
    ) {
      return;
    }
    void startProcess('align');
  }, [part.status, part.name, startProcess]);

  const handleMix = useCallback(() => {
    if (
      part.status === 'done' &&
      !window.confirm(
        `¿Volver a mezclar y generar el vídeo de "${part.name}" con el offset/ganancia/volúmenes actuales?`
      )
    ) {
      return;
    }
    void startProcess('mix');
  }, [part.status, part.name, startProcess]);

  const handleFull = useCallback(() => {
    if (
      part.status === 'done' &&
      !window.confirm(
        `¿Reprocesar "${part.name}" de cero? Se volverá a alinear, mezclar y generar el vídeo.`
      )
    ) {
      return;
    }
    void startProcess('full');
  }, [part.status, part.name, startProcess]);

  const handleCancel = useCallback(async () => {
    if (!part.jobId) return;
    try {
      await fetch(`/api/jobs/${part.jobId}`, { method: 'DELETE' });
    } catch {
      // ignore — refresh will pick up the real state
    }
    onRefresh();
  }, [part.jobId, onRefresh]);

  const handleDelete = useCallback(async () => {
    if (!window.confirm(`¿Eliminar "${part.name}"? Esta acción no se puede deshacer.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/parts/${part.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || `Error ${res.status}`
        );
      }
    } catch (err) {
      toast({
        title: 'No se pudo eliminar la parte',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
    onRefresh();
  }, [part.name, part.id, projectId, onRefresh, toast]);

  // --- Derived data ------------------------------------------------------
  const videoSources = sources.filter((s) => s.type === 'video');
  const audioSources = sources.filter((s) => s.type === 'audio');
  const videoSource = sources.find((s) => s.id === part.videoSourceId);
  const boardSource = part.boardSourceId
    ? sources.find((s) => s.id === part.boardSourceId)
    : undefined;
  const hasBoard = !!part.boardSourceId;

  const progressValue = sseProgress ?? part.progress ?? 0;
  const stageLabel =
    sseMessage ||
    (part.stage ? STAGE_LABELS[part.stage] : 'Procesando…');
  const dubiousOffset =
    part.alignmentPeakToNoise !== undefined && part.alignmentPeakToNoise < 2;

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        {/* Row 1: order, name, reorder arrows, status chip, actions */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-none rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            #{index + 1}
          </span>
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setNameDraft(part.name);
                e.currentTarget.blur();
              }
            }}
            disabled={isProcessing}
            className="h-8 w-40 flex-none text-sm"
            title="Nombre de la parte (Enter para guardar)"
          />
          <div className="flex flex-none items-center">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={anyProcessing || index === 0}
              onClick={() => onMove(part.id, -1)}
              title="Subir en el orden"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={anyProcessing || index === total - 1}
              onClick={() => onMove(part.id, 1)}
              title="Bajar en el orden"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>

          {/* Status chip */}
          <div className="min-w-0 flex-1">
            {part.status === 'idle' && (
              <span className="rounded bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                Pendiente
              </span>
            )}
            {isProcessing && (
              <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {stageLabel}
              </span>
            )}
            {part.status === 'aligned' && (
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-sky-400">
                <span className="inline-flex items-center gap-1">
                  <CheckCircle className="h-3.5 w-3.5" />
                  Alineada — falta mezclar y muxar
                </span>
                {part.alignmentOffsetMs !== undefined && (
                  <span className="text-muted-foreground">
                    offset {formatOffsetMs(part.alignmentOffsetMs)}
                  </span>
                )}
                {dubiousOffset && (
                  <span className="inline-flex items-center gap-1 text-amber-500">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    offset dudoso
                  </span>
                )}
              </span>
            )}
            {part.status === 'done' && (
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-green-500">
                <span className="inline-flex items-center gap-1">
                  <CheckCircle className="h-3.5 w-3.5" />
                  Procesada
                </span>
                {part.muxedDurationMs !== undefined && (
                  <span className="text-muted-foreground">
                    {formatDurationMs(part.muxedDurationMs)}
                  </span>
                )}
                {part.alignmentOffsetMs !== undefined && (
                  <span className="text-muted-foreground">
                    offset {formatOffsetMs(part.alignmentOffsetMs)}
                  </span>
                )}
                {dubiousOffset && (
                  <span className="inline-flex items-center gap-1 text-amber-500">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    offset dudoso
                  </span>
                )}
              </span>
            )}
            {part.status === 'error' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                Error
              </span>
            )}
          </div>

          {/* Actions — staged: Alinear → (revisar offset/ganancia) → Mezclar y muxar */}
          <div className="flex flex-none items-center gap-1">
            {hasBoard ? (
              <>
                {(part.status === 'idle' || part.status === 'error') && (
                  <Button size="sm" className="h-8" onClick={handleAlign}>
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                    Alinear
                  </Button>
                )}
                {(part.status === 'aligned' || part.status === 'done') && (
                  <Button
                    size="sm"
                    variant={part.status === 'aligned' ? 'default' : 'outline'}
                    className="h-8"
                    onClick={handleMix}
                    title={audioOnlyRemix
                      ? 'Procesa la parte entera con los ajustes actuales y escribe la mezcla vigente (segundos). El vídeo de la parte no se reescribe.'
                      : 'Dos pasos seguidos: (1) MEZCLA mesa + ambiente de toda la parte con los ajustes actuales → mezcla vigente (wav); (2) MUXA: reescribe el vídeo de la parte con esa mezcla dentro (copia el vídeo entero: minutos).'}
                  >
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                    {audioOnlyRemix ? 'Re-mezclar (solo audio)' : 'Mezclar y muxar'}
                  </Button>
                )}
                {(part.status === 'aligned' || part.status === 'done') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-muted-foreground"
                    onClick={handleAlign}
                    title="Volver a calcular el offset por correlación"
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    Realinear
                  </Button>
                )}
              </>
            ) : (
              <>
                {(part.status === 'idle' || part.status === 'error') && (
                  <Button size="sm" className="h-8" onClick={handleFull}>
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                    Procesar
                  </Button>
                )}
                {part.status === 'done' && (
                  <Button size="sm" variant="outline" className="h-8" onClick={handleFull}>
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    Reprocesar
                  </Button>
                )}
              </>
            )}
            {isProcessing && (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={handleCancel}
              >
                <Square className="mr-1.5 h-3.5 w-3.5" />
                Cancelar
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive"
              disabled={isProcessing}
              onClick={handleDelete}
              title="Eliminar parte"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* ── Paso 1 · Fuentes ─────────────────────────────────────────── */}
        <div className="flex items-center gap-2">
          <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">1</span>
          <span className="text-xs font-medium">Fuentes</span>
          <span className="text-[10px] text-muted-foreground">el vídeo del tramo y el audio de mesa de la noche</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Vídeo
            </label>
            {isProcessing ? (
              <p className="truncate text-xs">
                {videoSource?.originalName || 'desconocido'}
              </p>
            ) : (
              <select
                className={SELECT_CLASS}
                value={part.videoSourceId}
                onChange={(e) => void handleVideoChange(e.target.value)}
              >
                {videoSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.originalName}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Audio de mesa
            </label>
            {isProcessing ? (
              <p className="truncate text-xs">
                {boardSource?.originalName || '— sin audio de mesa —'}
              </p>
            ) : (
              <select
                className={SELECT_CLASS}
                value={part.boardSourceId ?? ''}
                onChange={(e) => void handleBoardChange(e.target.value)}
              >
                <option value="">— sin audio de mesa —</option>
                {audioSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.originalName}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* ── Paso 2 · Alinear ─────────────────────────────────────────── */}
        {hasBoard && (
          <div className="flex items-center gap-2 border-t border-border pt-2">
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">2</span>
            <span className="text-xs font-medium">Alinear</span>
            <span className="text-[10px] text-muted-foreground">
              di qué tramo del vídeo editas y dónde cae en la mesa, pulsa «Alinear»/«Realinear» y revisa el offset en el dibujo
            </span>
          </div>
        )}
        {/* Editing ranges. VIDEO: the stretch this part covers — mix, mux and
            every downstream clock start/stop there. MESA: where that stretch is
            expected, so the aligner correlates only the two excerpts (a 30-min
            piece against a 2-hour dinner used to lock onto a look-alike moment).
            The old "offset window" row is gone: it bounded the offset, which
            read as "these are the tracks", and a window set from the WRONG
            mental model forced a wrong offset (18-sep). */}
        {hasBoard && (
          <RangeRow
            label="Vídeo: editar de"
            color="text-blue-300"
            value={part.videoRangeMs}
            fileDurMs={videoSource?.duration ? videoSource.duration * 1000 : undefined}
            disabled={isProcessing}
            hint={part.videoRangeMs
              ? `la parte será solo ese tramo (${formatOffsetMs(part.videoRangeMs.endMs - part.videoRangeMs.startMs)}); cambiarlo pide re-mezclar`
              : 'vacío = el vídeo entero'}
            onChange={(r) => void patchPart({ videoRangeMs: r })}
            onInvalid={() => toast({ title: 'Valor no válido', description: 'Usa mm:ss (o h:mm:ss); el fin debe ir después del inicio', variant: 'destructive' })}
          />
        )}
        {hasBoard && (
          <RangeRow
            label="Mesa: ese tramo cae entre"
            color="text-green-300"
            value={part.boardRangeMs}
            fileDurMs={boardSource?.duration ? boardSource.duration * 1000 : undefined}
            disabled={isProcessing}
            hint={part.boardRangeMs
              ? 'la alineación se busca solo ahí (±1 min) — pulsa Realinear'
              : 'vacío = se busca en toda la mesa (con un tramo corto puede enganchar un momento parecido)'}
            onChange={(r) => void patchPart({ boardRangeMs: r })}
            onInvalid={() => toast({ title: 'Valor no válido', description: 'Usa mm:ss (o h:mm:ss); el fin debe ir después del inicio', variant: 'destructive' })}
          />
        )}


        {/* Row 3: alignment review (after align) — the SAME visual view as
            audio-prep (before/after envelope waveforms + manual offset),
            reading this part's own alignment JSON. Open by default right
            after aligning so the offset can be verified before mixing. */}
        {hasBoard && part.alignmentOffsetMs !== undefined && !isProcessing && (
          <details open={part.status === 'aligned'} className="rounded-md border border-border">
            <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              Alineación — offset{' '}
              <span className="font-mono text-foreground">{formatOffsetMs(part.alignmentOffsetMs)}</span>{' '}
              ({part.alignmentOffsetMs >= 0 ? 'mesa empieza antes' : 'cámara empieza antes'})
            </summary>
            <div className="space-y-2 p-2">
              <AlignmentView
                projectId={projectId}
                dataFileName={`part_${part.id.slice(0, 8)}_alignment.json`}
                applyOffset={applyOffsetViaPart}
                onOffsetChanged={onRefresh}
              />
            </div>
          </details>
        )}

        {/* ── Paso 3 · Mezclar y muxar ─────────────────────────────────── */}
        {hasBoard && part.alignmentOffsetMs !== undefined && (
          <div className="flex items-center gap-2 border-t border-border pt-2">
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">3</span>
            <span className="text-xs font-medium">Mezclar</span>
            <span className="text-[10px] text-muted-foreground">
              ajusta <strong>Mesa</strong> y <strong>Ambiente</strong> abajo (sus filas ORIGINAL suenan tal cual se grabó) y
              elige cómo oír el resultado:
            </span>
          </div>
        )}
        {hasBoard && part.alignmentOffsetMs !== undefined && (
          <div className="grid gap-1 rounded-md border border-border bg-secondary/30 p-2 text-[10px] leading-snug text-muted-foreground sm:grid-cols-3">
            <div>
              <span className="font-semibold text-foreground">Vista previa (30 s)</span> — pasa solo esos 30 s por la cadena
              completa y los pone en las filas PROCESADA. Segundos. <strong>No cambia nada</strong>: ni la mezcla vigente, ni el
              vídeo, ni lo que oyen Compose/Reels. Sirve para probar ajustes antes de comprometerlos.
            </div>
            <div>
              <span className="font-semibold text-foreground">Re-mezclar (solo audio)</span> — procesa la parte ENTERA con
              los ajustes actuales y escribe la <strong>mezcla vigente</strong> (wav). Segundos. Es lo que oyen Compose,
              Reels, la transcripción y el export. El vídeo de la parte <strong>no se reescribe</strong> (su audio embebido se
              queda antiguo; da igual, nadie lo usa salvo el reproductor VÍDEO de abajo).
            </div>
            <div>
              <span className="font-semibold text-foreground">Mezclar y muxar</span> — lo mismo que Re-mezclar Y además
              reescribe el <strong>vídeo de la parte</strong> con esa mezcla dentro (copia el vídeo entero: minutos y GB).
              Hace falta la primera vez, al cambiar el offset o el tramo de vídeo, y al querer el mp4 de la parte con el audio nuevo.
            </div>
          </div>
        )}

        {/* ── Cadena de mezcla: cada pista se procesa por separado y se suman
            en la Mezcla. Un solo lugar por valor (nada duplicado): la voz se
            configura en Mesa, el ambiente en Ambiente, los volúmenes SOLO en
            la Mezcla (sliders del comprobador de oído). Las formas de onda
            comparten escala absoluta, así que cruda vs procesada muestra
            exactamente la ganancia aplicada. */}
        {hasBoard && part.alignmentOffsetMs !== undefined && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-2 text-xs">
            <span className="font-medium">Probar los ajustes sin remezclar:</span>
            <span className="text-[10px] text-muted-foreground">30 s desde</span>
            <Input
              placeholder={`mm:ss (auto: ${Math.floor((part.muxedDurationMs ?? 60000) / 120000)}:${String(Math.floor(((part.muxedDurationMs ?? 60000) / 2000) % 60)).padStart(2, '0')})`}
              value={previewStartStr}
              onChange={(e) => setPreviewStartStr(e.target.value)}
              disabled={previewBusy || isProcessing}
              className="h-7 w-28 text-xs"
            />
            <Button size="sm" className="h-7" onClick={() => void runPreview()} disabled={previewBusy || isProcessing}
              title="Procesa SOLO esta ventana de 30 s con la misma cadena que la mezcla y la muestra en las filas PROCESADA. No toca la mezcla vigente ni el vídeo.">
              {previewBusy ? 'Generando…' : preview ? 'Regenerar vista previa (30 s)' : 'Generar vista previa (30 s)'}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              solo para escuchar: no cambia la mezcla vigente ni el vídeo · «Regenerar» = volver a calcular esos 30 s con los ajustes de ahora
            </span>
          </div>
        )}

        {hasBoard && part.alignmentOffsetMs !== undefined && (
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {/* ── Mesa (voz) ── */}
            <div className="space-y-2 rounded-md border border-border p-2">
              <span className="text-xs font-medium text-emerald-400">Mesa (voz)</span>
              <p className="text-[10px] leading-tight text-muted-foreground">
                Orden real de la cadena: <strong>1 · filtro previo</strong> (baja las risas de micro y
                rellenos en la pista cruda) → <strong>2 · nivelado</strong> de la voz → limitador → volumen.
                El filtro va antes para que el nivelador no suba los je-je como si fueran frases flojas.
                Además, <strong>una zona marcada cuenta como HUECO para el ambiente</strong>: si el cómico habla
                por encima de una risa y marcas ese trozo, la risa ya puede subir ahí (antes solo ocurría si la
                atenuación era tan honda que el tramo caía por debajo del umbral de voz).
              </p>

              {/* ── 1 · Filtro previo: je-je / rellenos ── */}
              {!isProcessing && (
                <details className="rounded-md border border-amber-500/30" open={(part.boardDuckRegions?.length ?? 0) > 0}>
                  <summary className="cursor-pointer select-none px-2 py-1.5 text-xs hover:text-foreground">
                    <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">1</span>
                    <span className="ml-1.5 font-medium">Filtro previo — risas de micro (je-je) y rellenos</span>
                    {part.boardDuckRegions && part.boardDuckRegions.some((r) => r.enabled) && (
                      <span className="ml-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">
                        {part.boardDuckRegions.filter((r) => r.enabled).length} activa(s)
                      </span>
                    )}
                    {part.boardDuckRegions && part.boardDuckRegions.some((r) => r.source !== 'manual' && !r.enabled) && (
                      <span className="ml-1.5 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {part.boardDuckRegions.filter((r) => r.source !== 'manual' && !r.enabled).length} por revisar
                      </span>
                    )}
                  </summary>
                  <div className="p-2">
                    <BoardDuckingPanel
                      projectId={projectId}
                      boardUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(`part_${part.id.slice(0, 8)}_board.wav`)}`}
                      fillersUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(`part_${part.id.slice(0, 8)}_fillers.json`)}`}
                      envelopeUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(`part_${part.id.slice(0, 8)}_board.wav`)}`}
                      detectUrl={`/api/projects/${projectId}/parts/${part.id}/detect-fillers`}
                      initialRegions={part.boardDuckRegions ?? []}
                      boardTrimMs={partUsedRanges(part).board.startMs}
                      usedEndMs={partUsedRanges(part).board.endMs}
                      durationMsFallback={part.muxedDurationMs}
                      disabled={isProcessing}
                      applyLabel="Aplicar y re-mezclar"
                      applyHint={audioOnlyRemix
                        ? 'Re-mezcla solo el audio (segundos) — el vídeo no se reescribe.'
                        : total === 1
                          ? 'Re-mezcla esta parte; el vídeo final se regenera solo.'
                          : 'Tras re-mezclar, pulsa "Unir partes" para rehacer el vídeo final.'}
                      onSave={async (regions) => {
                        try {
                          const res = await fetch(`/api/projects/${projectId}/parts/${part.id}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ boardDuckRegions: regions }),
                          });
                          if (!res.ok) {
                            const d = await res.json().catch(() => ({}));
                            throw new Error((d as { error?: string }).error || `Error ${res.status}`);
                          }
                          onRefresh();
                          return true;
                        } catch (err) {
                          toast({ title: 'No se pudo guardar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
                          return false;
                        }
                      }}
                      onApplied={() => void startProcess('mix')}
                    />
                  </div>
                </details>
              )}

              {/* ── 2 · Nivelar ── */}
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">2</span>
                <span className="text-xs font-medium">Nivelar la voz</span>
              </div>
              <div className="space-y-1.5 text-xs">
                <label className="flex items-center gap-1.5" title="Mide la sonoridad de la mesa y ancla una curva: la frase más fuerte llega al Techo y las flojas suben MÁS, conservando parte de la diferencia de volumen (según la Compresión). Ignora la ganancia manual y el compresor.">
                  <input
                    type="radio" name={`mesa-mode-${part.id}`}
                    checked={part.boardSpeechLevel ?? false}
                    onChange={() => patchAndRefresh({ boardSpeechLevel: true })}
                    disabled={isProcessing}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  Nivelar voz automáticamente <span className="text-[10px] text-muted-foreground">(recomendado)</span>
                </label>
                {(part.boardSpeechLevel ?? false) && (
                  <label className="ml-5 flex items-center gap-2 text-[10px] text-muted-foreground" title="Baja la mesa 24 dB en los huecos donde cae a su ruido de sala (antes del nivelador), y dibuja cada cierre como caja en la pista de mesa. Desactivada por defecto: lo que hace la mezcla es atenuar el AMBIENTE mientras hay voz, no silenciar la mesa.">
                    <input
                      type="checkbox"
                      checked={part.boardGate ?? false}
                      onChange={(e) => patchAndRefresh({ boardGate: e.target.checked })}
                      disabled={isProcessing}
                    />
                    Puerta de mesa (−24 dB cuando la mesa calla) — {part.boardGate ? 'activa: genera cajas «puerta» en la pista de mesa' : 'desactivada: sin cajas de puerta; el ambiente se atenúa con la voz igual'}
                  </label>
                )}
                {(part.boardSpeechLevel ?? false) && (
                  <div className="ml-5 flex flex-wrap items-center gap-2">
                    <label className="text-[10px] text-muted-foreground" title="Cuánto se acercan las frases flojas a las fuertes: 2:1 = las diferencias de volumen se reducen a la mitad (se siguen apreciando). Las flojas reciben más subida que las fuertes.">
                      Compresión
                    </label>
                    <select
                      className="h-7 rounded border border-border bg-background px-1 text-xs outline-none"
                      value={String(part.boardLevelRatio ?? 2)}
                      onChange={(e) => patchAndRefresh({ boardLevelRatio: Number(e.target.value) })}
                      disabled={isProcessing}
                    >
                      <option value="1.5">1.5:1 (suave)</option>
                      <option value="2">2:1 (natural)</option>
                      <option value="3">3:1 (fuerte)</option>
                      <option value="4">4:1 (locutor)</option>
                    </select>
                    <label className="text-[10px] text-muted-foreground" title="Dónde queda la frase MÁS fuerte (0 dB = saturación). −3 deja margen y evita el sonido aplastado.">
                      Techo
                    </label>
                    <Input
                      type="number" step={1} min={-12} max={-1}
                      value={ceilingStr}
                      onChange={(e) => setCeilingStr(e.target.value)}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={commitOnEnter}
                      onBlur={() => commitDraftNumber('boardLevelCeilingDb', ceilingStr, -12, -1, part.boardLevelCeilingDb ?? -3, setCeilingStr)}
                      disabled={isProcessing}
                      className="h-7 w-16 text-xs"
                    />
                    <span className="text-[10px] text-muted-foreground">dB</span>
                    <label className="text-[10px] text-muted-foreground" title="Nivel de entrada por debajo del cual la voz se deja como está (el codo de «no tocar»). Por defecto ruido de sala + 4 dB: una palabra que se apaga hasta ahí conserva toda la subida; la sala misma sube un tercio y 2 dB por debajo de ella nada. Súbelo si la sala se oye demasiado en las pausas; bájalo si a las palabras flojas «se les va la voz».">
                      Suelo de voz
                    </label>
                    <Input
                      type="number" step={1} min={-80} max={-20}
                      value={kneeStr}
                      placeholder={part.boardNoiseFloorDb != null ? String(Math.round(part.boardNoiseFloorDb + 4)) : 'auto'}
                      onChange={(e) => setKneeStr(e.target.value)}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={commitOnEnter}
                      onBlur={() => {
                        const t = kneeStr.trim();
                        if (!t) { if (part.boardLevelKneeDb != null) patchAndRefresh({ boardLevelKneeDb: null }); return; }
                        commitDraftNumber('boardLevelKneeDb', kneeStr, -80, -20, part.boardLevelKneeDb ?? Math.round((part.boardNoiseFloorDb ?? -58) + 4), setKneeStr);
                      }}
                      disabled={isProcessing}
                      className="h-7 w-16 text-xs"
                    />
                    <span className="text-[10px] text-muted-foreground">dB{part.boardLevelKneeDb == null && part.boardNoiseFloorDb != null ? ` (auto: sala ${part.boardNoiseFloorDb.toFixed(0)} + 4)` : ''}</span>
                    <label className="text-[10px] text-muted-foreground" title="Codo suavizado: en las pausas la mesa NO vuelve a su nivel crudo (eso sonaba a «mute» tras una voz subida +40 dB); se queda este número de dB por debajo de la subida de la voz, así queda un fondo de sala continuo. Menos dB = más fondo (y más soplido); más dB = pausas más limpias. 60 = como antes (corte total). Con la puerta de mesa activa no se aplica.">
                      Fondo en silencios
                    </label>
                    <Input
                      type="number" step={1} min={6} max={60}
                      value={silenceStr}
                      placeholder="18"
                      onChange={(e) => setSilenceStr(e.target.value)}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={commitOnEnter}
                      onBlur={() => {
                        const t = silenceStr.trim();
                        if (!t) { if (part.boardLevelSilenceDepthDb != null) patchAndRefresh({ boardLevelSilenceDepthDb: null }); return; }
                        commitDraftNumber('boardLevelSilenceDepthDb', silenceStr, 6, 60, part.boardLevelSilenceDepthDb ?? 18, setSilenceStr);
                      }}
                      disabled={isProcessing || !!part.boardGate}
                      className="h-7 w-16 text-xs"
                    />
                    <span className="text-[10px] text-muted-foreground">dB bajo la voz{part.boardGate ? ' (no se aplica con la puerta)' : part.boardLevelSilenceDepthDb == null ? ' (auto: 18)' : ''}</span>
                    {(() => {
                      const R = part.boardLevelRatio ?? 2;
                      const C = part.boardLevelCeilingDb ?? -3;
                      return (
                        <p className="w-full text-[10px] leading-tight text-muted-foreground">
                          Con <strong>{R}:1</strong>: la frase más fuerte queda en <strong>{C} dB</strong> y una
                          frase que era 10 dB más floja queda a <strong>{(10 / R).toFixed(1).replace(/\.0$/, '')} dB</strong> de
                          ella (las diferencias se dividen entre {R}). Las flojas reciben MÁS subida que las
                          fuertes. Más ratio = voz más pareja tipo locutor; menos = entrega más natural.
                        </p>
                      );
                    })()}
                    <div className="w-full">
                      <p className="mb-0.5 text-[10px] text-muted-foreground">
                        Curva exacta que aplica la mezcla (entrada → salida) con tus niveles medidos:
                        {part.boardLoudDb != null
                          ? <> voz fuerte medida <strong>en esta parte</strong> <strong>{part.boardLoudDb.toFixed(1)} dB</strong> → techo{part.boardNoiseFloorDb != null ? <>, ruido de sala <strong>{part.boardNoiseFloorDb.toFixed(0)} dB</strong> (el codo de «no tocar» queda justo encima)</> : null}. Toda la voz por encima del codo sube; la floja más que la fuerte.{part.boardLUFS != null ? <span className="text-muted-foreground/60"> (sonoridad integrada {part.boardLUFS.toFixed(1)} LUFS, no se usa: los golpes y gritos la inflan)</span> : null}</>
                          : part.boardLUFS != null
                          ? <> sonoridad de la mesa <strong>en esta parte</strong> <strong>{part.boardLUFS.toFixed(1)} LUFS</strong>{part.boardNoiseFloorDb != null ? <>, ruido de sala <strong>{part.boardNoiseFloorDb.toFixed(0)} dB</strong></> : null}; voz más fuerte ≈ {(part.boardLUFS + 18).toFixed(0)} dB → techo (medida antigua — genera una vista previa para anclar a la voz real).</>
                          : ' (se ancla a la voz fuerte de la ventana de la parte, medida al previsualizar o mezclar).'}
                      </p>
                      <LevelerCurve
                        meanLUFS={part.boardLoudDb != null ? part.boardLoudDb - 18 : part.boardLUFS}
                        ratio={part.boardLevelRatio ?? 2}
                        ceilingDb={part.boardLevelCeilingDb ?? -3}
                        noiseFloorDb={part.boardNoiseFloorDb}
                        kneeDb={part.boardLevelKneeDb}
                        silenceDepthDb={part.boardLevelSilenceDepthDb}
                        gated={!!part.boardSpeechLevel && !!part.boardGate}
                        raw={boardRawStats}
                      />
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-1.5" title="Cadena clásica: ganancia fija + compresor de dinámica">
                  <input
                    type="radio" name={`mesa-mode-${part.id}`}
                    checked={!(part.boardSpeechLevel ?? false)}
                    onChange={() => patchAndRefresh({ boardSpeechLevel: false })}
                    disabled={isProcessing}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  Manual
                </label>
                {!(part.boardSpeechLevel ?? false) && (
                  <div className="ml-5 flex items-center gap-3">
                    <span className="flex items-center gap-2">
                      <label className="text-[10px] text-muted-foreground">Ganancia</label>
                      <Input
                        type="number" step={1}
                        value={gainStr}
                        onChange={(e) => handleGainChange(e.target.value)}
                        disabled={isProcessing}
                        className="h-7 w-16 text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">dB</span>
                    </span>
                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={part.boardCompress ?? true}
                        onChange={(e) => handleCompressChange(e.target.checked)}
                        disabled={isProcessing}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      Comprimir dinámica
                    </label>
                  </div>
                )}
              </div>

              <TrackRow
                projectId={projectId}
                kind="original"
                label="Mesa tal cual se grabó"
                sublabel="sin filtro je-je, sin nivelar, sin volumen — es la entrada de todo lo de arriba"
                fileName={`part_${part.id.slice(0, 8)}_board.wav`}
                color="#94a3b8"
                refreshKey={`${part.status}`}
                onStats={onBoardRawStats}
              />
              <TrackRow
                projectId={projectId}
                kind={preview ? 'preview' : 'processed'}
                label={preview
                  ? `Mesa procesada — ventana desde ${Math.floor(preview.startSec / 60)}:${String(Math.floor(preview.startSec % 60)).padStart(2, '0')}`
                  : 'Mesa procesada — lo que entra a la mezcla'}
                sublabel="filtro je-je + nivelado/ganancia + limitador ya aplicados (sin el volumen de mezcla)"
                producedAt={preview ? new Date(preview.stamp).toISOString() : part.mixedAt}
                fileName={preview ? `part_${part.id.slice(0, 8)}_prev_board.wav` : `part_${part.id.slice(0, 8)}_board_proc.wav`}
                color="#34d399"
                refreshKey={`${preview?.stamp ?? 0}-${part.progress ?? 0}-${part.status}`}
                missingHint="genera una vista previa o pulsa «Re-mezclar»"
                chainLabel={preview ? preview.chain.board : (part.mixChainApplied?.board ?? chainNow.board)}
                warning={preview ? undefined : settingsWarning}
                behind={{
                  fileName: `part_${part.id.slice(0, 8)}_board.wav`,
                  offsetSec: partTrims(part).boardTrimMs / 1000 + (preview?.startSec ?? 0),
                }}
              />
            </div>

            {/* ── Ambiente (cámara) ── */}
            <div className="space-y-2 rounded-md border border-border p-2">
              <span className="text-xs font-medium text-sky-400">Ambiente (cámara)</span>
              <div className="space-y-1.5 text-xs">
                <label className="flex items-center gap-1.5" title="Mientras suena la voz de mesa, el ambiente baja (elimina el eco de sala de la voz); en cada hueco vuelve con un fade para que risas y público se oigan más altos.">
                  <input
                    type="checkbox"
                    checked={part.ambientDuckOnVoice ?? false}
                    onChange={(e) => patchAndRefresh({ ambientDuckOnVoice: e.target.checked })}
                    disabled={isProcessing}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  Bajar ambiente mientras hay voz
                </label>
                {(part.ambientDuckOnVoice ?? false) && (
                  <div className="ml-5 space-y-1.5">
                    {/* Levels: how far down under the voice, how far UP in the gaps. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-[10px] text-muted-foreground" title="Cuánto baja el ambiente mientras hay voz de mesa (respecto al original). Mata el eco de sala de la voz en la cámara.">Con voz</label>
                      <span className="text-[10px] text-muted-foreground">−</span>
                      <Input
                        type="number" step={1} min={1} max={60}
                        value={duckDbStr}
                        onChange={(e) => setDuckDbStr(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={commitOnEnter}
                        onBlur={() => commitDraftNumber('ambientVoiceDuckDb', duckDbStr, 1, 60, part.ambientVoiceDuckDb ?? 8, setDuckDbStr)}
                        disabled={isProcessing}
                        className="h-7 w-16 text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">dB</span>
                      <label className="ml-2 text-[10px] text-muted-foreground" title="Cuánto SUBE el ambiente en los huecos entre frases (respecto al original): las risas y el público suben, sin que el eco de la voz suba con ellos. 0 = deja los huecos como estaban.">· en los huecos</label>
                      <span className="text-[10px] text-muted-foreground">+</span>
                      <Input
                        type="number" step={1} min={0} max={12}
                        value={gapBoostStr}
                        onChange={(e) => setGapBoostStr(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={commitOnEnter}
                        onBlur={() => commitDraftNumber('ambientGapBoostDb', gapBoostStr, 0, 12, part.ambientGapBoostDb ?? 0, setGapBoostStr)}
                        disabled={isProcessing}
                        className="h-7 w-16 text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">dB</span>
                      <label className="ml-2 text-[10px] text-muted-foreground" title="PUERTA DE PÚBLICO: la pausa se juzga ENTERA — si el público suena (risas, murmullo) por encima de estos dB sobre el ruido de sala de la grabación, el ambiente sube durante TODA la pausa; si está callada, no sube nada. Medido en una grabación real de 27 min: 0 dB = suben las 228 pausas (8,3/min) · 3 dB = 180 (6,6/min) · 6 dB = 131 (4,8/min) · 9 dB = 86 (3,1/min) · 12 dB = 32 (1,2/min).">· solo si el público supera</label>
                      <Input
                        type="number" step={1} min={0} max={30}
                        value={gateStr}
                        onChange={(e) => setGateStr(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={commitOnEnter}
                        onBlur={() => commitDraftNumber('ambientGateDb', gateStr, 0, 30, part.ambientGateDb ?? 6, setGateStr)}
                        disabled={isProcessing}
                        className="h-7 w-16 text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">dB sobre su ruido de sala</span>
                    </div>
                    {/* Timing: anticipation → attack → hold → release. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-[10px] text-muted-foreground" title="El ambiente se ADELANTA a la voz: empieza a bajar unos ms antes de que entre la frase (sin eco en el arranque) y empieza a subir antes de que acabe — así el fade queda pegado a la voz aunque el hueco entre frases sea corto. 0 = sin anticipación (reactivo puro).">anticipa</label>
                      <Input
                        type="number" step={50} min={0} max={1000}
                        value={anticipateMsStr}
                        onChange={(e) => setAnticipateMsStr(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={commitOnEnter}
                        onBlur={() => commitDraftNumber('ambientVoiceAnticipateMs', anticipateMsStr, 0, 1000, part.ambientVoiceAnticipateMs ?? 200, setAnticipateMsStr)}
                        disabled={isProcessing}
                        className="h-7 w-20 text-xs"
                      />
                      <label className="text-[10px] text-muted-foreground" title="Fade-out del ambiente: ms que tarda en llegar a −X dB una vez detecta la voz. Corto (15) = corte seco sin eco; largo = entrada más suave.">· ataque</label>
                      <Input
                        type="number" step={5} min={5} max={500}
                        value={attackMsStr}
                        onChange={(e) => setAttackMsStr(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={commitOnEnter}
                        onBlur={() => commitDraftNumber('ambientVoiceAttackMs', attackMsStr, 5, 500, part.ambientVoiceAttackMs ?? 15, setAttackMsStr)}
                        disabled={isProcessing}
                        className="h-7 w-20 text-xs"
                      />
                      <label className="text-[10px] text-muted-foreground" title="PAUSA MÍNIMA para que el ambiente suba: tras callar la voz sigue bajado este tiempo y solo si la pausa dura más empieza a volver. Los huecos entre palabras (100–400 ms) NO suben el ambiente; una pausa larga tras una frase o un je-je atenuado sí. 500–800 ms suele ir bien.">· pausa mínima</label>
                      <Input
                        type="number" step={50} min={0} max={2000}
                        value={holdMsStr}
                        onChange={(e) => setHoldMsStr(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={commitOnEnter}
                        onBlur={() => commitDraftNumber('ambientVoiceHoldMs', holdMsStr, 0, 2000, part.ambientVoiceHoldMs ?? 600, setHoldMsStr)}
                        disabled={isProcessing}
                        className="h-7 w-20 text-xs"
                      />
                      <label className="text-[10px] text-muted-foreground" title="Fade-in de vuelta (recovery): ms que tarda el ambiente en volver a su nivel de hueco cuando termina la voz (+ mantenimiento). Es el fade-in de la risa.">· vuelve en</label>
                      <Input
                        type="number" step={50} min={50} max={3000}
                        value={releaseMsStr}
                        onChange={(e) => setReleaseMsStr(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={commitOnEnter}
                        onBlur={() => commitDraftNumber('ambientVoiceReleaseMs', releaseMsStr, 50, 3000, part.ambientVoiceReleaseMs ?? 400, setReleaseMsStr)}
                        disabled={isProcessing}
                        className="h-7 w-20 text-xs"
                      />
                      <label className="text-[10px] text-muted-foreground" title="La subida hacia la risa ARRANCA este tiempo ANTES de que la voz acabe (no espera al silencio), así la risa ya viene subiendo bajo las últimas palabras y no entra de golpe. Solo se adelanta cuando de verdad hay risa después; si la pausa es callada no sube nada.">· sube la risa</label>
                      <Input
                        type="number" step={50} min={0} max={1000}
                        value={preRiseStr}
                        onChange={(e) => setPreRiseStr(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={commitOnEnter}
                        onBlur={() => commitDraftNumber('ambientPreRiseMs', preRiseStr, 0, 1000, part.ambientPreRiseMs ?? 150, setPreRiseStr)}
                        disabled={isProcessing}
                        className="h-7 w-20 text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">ms antes de acabar la voz</span>
                      <button
                        type="button"
                        onClick={() => patchAndRefresh({ ambientVoiceAnticipateMs: 100, ambientVoiceAttackMs: 20, ambientVoiceHoldMs: 800, ambientVoiceReleaseMs: 400, ambientPreRiseMs: 250, ambientGateDb: 6 })}
                        disabled={isProcessing}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                        title="anticipa 100 · ataque 20 · pausa mínima 800 · vuelve 400 · sube la risa 250 ms antes · puerta 6 dB — medido sobre una grabación real: ~5 subidas/min (con 200 ms eran 17/min, de ahí el bombeo)"
                      >
                        valores recomendados
                      </button>
                    </div>
                    <AmbientDuckDiagram
                      depthDb={part.ambientVoiceDuckDb ?? 8}
                      gapBoostDb={part.ambientGapBoostDb ?? 0}
                      attackMs={part.ambientVoiceAttackMs ?? 15}
                      holdMs={part.ambientVoiceHoldMs ?? 600}
                      releaseMs={part.ambientVoiceReleaseMs ?? 400}
                      anticipateMs={part.ambientVoiceAnticipateMs ?? 200}
                      preRiseMs={part.ambientPreRiseMs ?? 150}
                    />
                    <p className="text-[10px] leading-tight text-muted-foreground">
                      Lectura: la ganancia del ambiente se calcula ANTES de mezclar mirando toda la grabación (no es un
                      compresor que reacciona tarde). <strong>Qué es «voz»</strong>: se decide comparando los dos micros —
                      la mesa oye al cómico mucho más fuerte que la cámara, y a las risas al revés — así el público que se
                      cuela en el micro de mesa no cuenta como voz y esas pausas quedan libres para subir (antes se miraba
                      solo el nivel de la mesa nivelada, que sube ese público hasta parecer voz).
                      Con voz está a <strong>−{part.ambientVoiceDuckDb ?? 8} dB</strong> y empieza a bajar{' '}
                      <strong>{part.ambientVoiceAnticipateMs ?? 200} ms</strong> antes de cada frase, en <strong>{part.ambientVoiceAttackMs ?? 15} ms</strong>.
                      Los huecos de menos de <strong>{part.ambientVoiceHoldMs ?? 600} ms</strong> (entre palabras) se consideran parte de la frase:
                      ahí NO sube nada. Cada pausa más larga se juzga ENTERA: o sube durante toda ella
                      a <strong>+{part.ambientGapBoostDb ?? 0} dB</strong> (rampa de <strong>{part.ambientVoiceReleaseMs ?? 400} ms</strong>), o
                      no sube nada — nunca a trocitos. Sube <strong>solo si el público suena</strong>{' '}
                      {(part.ambientGateDb ?? 6) > 0
                        ? <>(≥ <strong>{part.ambientGateDb ?? 6} dB</strong> sobre su ruido de sala; si la pausa está callada se queda abajo)</>
                        : <>(puerta desactivada: sube en toda pausa larga)</>}
                      {(part.ambientPreRiseMs ?? 150) > 0 && <>, y esa subida arranca <strong>{part.ambientPreRiseMs ?? 150} ms antes de que la voz acabe</strong> para que la risa no entre de golpe</>}.
                      Aplícalo con «Re-mezclar»; la fila «Procesado» de abajo lo muestra.
                    </p>
                  </div>
                )}
              </div>

              {videoSource && (
                <TrackRow
                  projectId={projectId}
                  kind="original"
                  label="Cámara tal cual se grabó"
                  sublabel="audio de la cámara sin tocar (voz con eco de sala + público) — es la entrada del ducking"
                  fileName={`${videoSource.id}_audio.wav`}
                  color="#94a3b8"
                  refreshKey={`${part.status}`}
                />
              )}
              <TrackRow
                projectId={projectId}
                kind={preview ? 'preview' : 'processed'}
                label={preview
                  ? `Ambiente procesado — ventana desde ${Math.floor(preview.startSec / 60)}:${String(Math.floor(preview.startSec % 60)).padStart(2, '0')}`
                  : 'Ambiente procesado — lo que entra a la mezcla'}
                sublabel="ducking con la voz (y subidas manuales) ya aplicados (sin el volumen de mezcla)"
                producedAt={preview ? new Date(preview.stamp).toISOString() : part.mixedAt}
                fileName={preview ? `part_${part.id.slice(0, 8)}_prev_amb.wav` : `part_${part.id.slice(0, 8)}_amb_proc.wav`}
                color="#38bdf8"
                refreshKey={`${preview?.stamp ?? 0}-${part.progress ?? 0}-${part.status}`}
                missingHint="genera una vista previa o pulsa «Re-mezclar»"
                chainLabel={preview ? preview.chain.ambient : (part.mixChainApplied?.ambient ?? chainNow.ambient)}
                warning={preview ? undefined : settingsWarning}
                behind={videoSource ? {
                  fileName: `${videoSource.id}_audio.wav`,
                  offsetSec: partTrims(part).ambientTrimMs / 1000 + (preview?.startSec ?? 0),
                } : undefined}
              />
            </div>
          </div>
        )}

        {/* ── Mezcla ── */}
        {hasBoard && part.alignmentOffsetMs !== undefined && videoSource && (
          <div className="space-y-2 rounded-md border border-border p-2">
            <span className="text-xs font-medium text-purple-400">Mezcla</span>
            {/* State line: which mix is current, whether the settings moved
                since, and whether the part VIDEO still carries older audio. */}
            <div className="rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-[10px] leading-snug">
              <div>
                <span className="text-muted-foreground">Mezcla vigente: </span>
                {part.mixedAt ? (
                  <>
                    <strong>{fmtClock(part.mixedAt)}</strong>
                    {mixSettingsChanged
                      ? <span className="text-amber-300"> · ⚠ los ajustes han cambiado desde entonces — «Re-mezclar» para aplicarlos</span>
                      : part.mixChainApplied
                        ? <span className="text-emerald-300"> · con los ajustes actuales ✓</span>
                        : null}
                  </>
                ) : part.status === 'done' ? (
                  <span className="text-muted-foreground">
                    de una versión anterior{part.processedAt ? ` (${fmtClock(part.processedAt)})` : ''} — sin registro de sus ajustes; re-mezcla una vez para tenerlo
                  </span>
                ) : <span className="text-muted-foreground">todavía no hay mezcla — pulsa «Mezclar y muxar»</span>}
              </div>
              <div>
                <span className="text-muted-foreground">Vídeo de la parte: </span>
                {part.muxedAt ? (
                  <>
                    <span>muxado <strong>{fmtClock(part.muxedAt)}</strong></span>
                    {videoAudioStale
                      ? <span className="text-amber-300"> · ⚠ su audio es ANTERIOR a la mezcla vigente (un re-mix rápido no reescribe el vídeo)</span>
                      : <span className="text-emerald-300"> · lleva la mezcla vigente ✓</span>}
                  </>
                ) : part.status === 'done' && part.muxedVideoPath ? (
                  <span className="text-muted-foreground">muxado en una versión anterior (sin hora registrada)</span>
                ) : <span className="text-muted-foreground">aún no muxado</span>}
              </div>
              <div className="text-muted-foreground">
                Compose, Reels, transcripción y export usan la <strong>mezcla vigente</strong> (el wav), no el audio del vídeo —
                el vídeo solo necesita re-muxarse si quieres verlo con el audio nuevo.
              </div>
            </div>
            {/* Volúmenes SOLO aquí (los sliders del comprobador) — se guardan
                en la parte, así que «Mezclar y muxar» reproduce lo que oyes. */}
            {!isProcessing && (
              <AlignmentEarCheck
                boardUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(`part_${part.id.slice(0, 8)}_board.wav`)}`}
                cameraUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(`${videoSource.id}_audio.wav`)}`}
                offsetMs={part.alignmentOffsetMs}
                rangeMs={part.videoRangeMs}
                mix={{
                  boardGainDb: (part.boardSpeechLevel ?? false) ? 0 : Number(gainStr) || 0,
                  boardCompress: (part.boardSpeechLevel ?? false) ? true : (part.boardCompress ?? true),
                  boardVolume: Number(boardVolStr) || 1,
                  ambientVolume: Number(ambientVolStr) || 0.7,
                }}
                chainLabel={
                  'EN VIVO, aproximación del navegador — SUENA: mesa y cámara ORIGINALES + los volúmenes de estos sliders' +
                  ((part.boardSpeechLevel ?? false) ? ' + un compresor que imita el nivelador' : ` + ganancia ${Number(gainStr) || 0} dB${(part.boardCompress ?? true) ? ' + compresor' : ''}`) +
                  '. NO SUENA: filtro je-je, ducking del ambiente ni limitador exacto. Sirve para el offset y los volúmenes; la verdad es la fila MEZCLA REAL de abajo.'}
                onMixLive={(p) => {
                  // Live redraw of the mixer view while dragging; the PATCH
                  // still happens on pointer-up (onMixChange).
                  if (p.boardVolume !== undefined) setBoardVolStr(String(p.boardVolume));
                  if (p.ambientVolume !== undefined) setAmbientVolStr(String(p.ambientVolume));
                }}
                onMixChange={(p) => {
                  if (p.boardVolume !== undefined) {
                    setBoardVolStr(String(p.boardVolume));
                    void patchPart({ boardVolume: p.boardVolume });
                  }
                  if (p.ambientVolume !== undefined) {
                    setAmbientVolStr(String(p.ambientVolume));
                    void patchPart({ ambientVolume: p.ambientVolume });
                  }
                }}
                onApplyOffset={applyOffsetViaPart}
                onApplied={onRefresh}
              />
            )}
            {/* The mixer drawn: both stems with their volume applied and the
                resulting mix underneath — moving the sliders above redraws it. */}
            <MixStackView
              projectId={projectId}
              boardFile={preview ? `part_${part.id.slice(0, 8)}_prev_board.wav` : `part_${part.id.slice(0, 8)}_board_proc.wav`}
              ambientFile={preview ? `part_${part.id.slice(0, 8)}_prev_amb.wav` : `part_${part.id.slice(0, 8)}_amb_proc.wav`}
              mixFile={preview ? `part_${part.id.slice(0, 8)}_prev_mix.wav` : `part_${part.id.slice(0, 8)}_mix.wav`}
              boardVolume={Number(boardVolStr) || 1}
              ambientVolume={Number(ambientVolStr) || 0.7}
              mixedWithBoardVolume={part.boardVolume}
              mixedWithAmbientVolume={part.ambientVolume}
              refreshKey={`${preview?.stamp ?? 0}-${part.progress ?? 0}-${part.status}`}
            />
            <TrackRow
              projectId={projectId}
              kind={preview ? 'preview' : 'mix'}
              label={preview
                ? `Mezcla — ventana desde ${Math.floor(preview.startSec / 60)}:${String(Math.floor(preview.startSec % 60)).padStart(2, '0')} (idéntica a lo que se mezclará)`
                : 'Mezcla vigente — la que usan Compose, Reels, transcripción y export'}
              sublabel="mesa procesada × vol. mesa + ambiente procesado × vol. ambiente → limitador. FFmpeg real, no aproximación."
              producedAt={preview ? new Date(preview.stamp).toISOString() : part.mixedAt}
              fileName={preview ? `part_${part.id.slice(0, 8)}_prev_mix.wav` : `part_${part.id.slice(0, 8)}_mix.wav`}
              color="#c084fc"
              refreshKey={`${preview?.stamp ?? 0}-${part.progress ?? 0}-${part.status}`}
              missingHint="genera una vista previa o pulsa «Mezclar y muxar»"
              chainLabel={preview
                ? `${preview.chain.mix} · mesa: ${preview.chain.board} · ambiente: ${preview.chain.ambient}`
                : part.mixChainApplied
                  ? `${part.mixChainApplied.mix} · mesa: ${part.mixChainApplied.board} · ambiente: ${part.mixChainApplied.ambient}`
                  : `${chainNow.mix} · mesa: ${chainNow.board} · ambiente: ${chainNow.ambient}`}
              warning={preview ? undefined : settingsWarning}
              height={88}
            />
            {/* Audition the PART's own muxed video (mix + video) right here —
                no need to "Unir partes" (that only rebuilds the final
                concatenated video for downstream steps). */}
            {part.status === 'done' && (
              <details className="rounded-md border border-border">
                <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                  <span className="mr-1.5 rounded bg-slate-500/25 px-1 py-px text-[9px] font-semibold tracking-wide text-slate-300">VÍDEO</span>
                  Vídeo de esta parte
                  {part.muxedAt && <span className="ml-1 text-[10px] text-muted-foreground/70">· audio muxado a las {fmtClock(part.muxedAt)}</span>}
                  {videoAudioStale && <span className="ml-1 text-[10px] text-amber-300">· ⚠ audio anterior a la mezcla vigente</span>}
                </summary>
                <div className="space-y-2 p-2">
                  {/* The mux action is ALWAYS available here — a part mixed
                      before mixedAt/muxedAt existed can't know whether it is
                      stale, and the user may simply want the file rewritten. */}
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    <span>
                      {videoAudioStale
                        ? `Este vídeo lleva el audio de las ${fmtClock(part.muxedAt)}; la mezcla vigente es de las ${fmtClock(part.mixedAt)}.`
                        : part.muxedAt
                          ? 'Este vídeo ya lleva la mezcla vigente; volver a muxarlo solo reescribe el fichero con el mismo audio.'
                          : 'Vídeo de una versión anterior: no consta con qué mezcla se muxó.'}
                    </span>
                    <Button size="sm" variant={videoAudioStale ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => void startProcess('mix', { forceMux: true })} disabled={isProcessing}>
                      {videoAudioStale ? 'Muxar el vídeo con la mezcla vigente' : 'Re-mezclar y muxar el vídeo'} (reescribe el fichero)
                    </Button>
                  </div>
                  <video
                    controls
                    preload="none"
                    className="max-h-72 w-full rounded bg-black"
                    src={`/api/projects/${projectId}/export/download?file=${encodeURIComponent(`part_${part.id.slice(0, 8)}_muxed.mp4`)}&inline=1&v=${part.muxedAt ?? ''}-${part.status}`}
                  />
                </div>
              </details>
            )}
            {(part.status === 'aligned' || part.status === 'done') && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" className="h-8" onClick={handleMix} disabled={isProcessing}
                  title={audioOnlyRemix
                    ? 'Procesa la parte entera con los ajustes actuales y escribe la mezcla vigente (segundos). El vídeo no se reescribe.'
                    : 'Mezcla toda la parte con los ajustes actuales y después reescribe el vídeo de la parte con esa mezcla (minutos).'}>
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {audioOnlyRemix
                    ? 'Re-mezclar con estos ajustes (solo audio, rápido)'
                    : `Mezclar y muxar ${part.status === 'done' ? '(re-mezclar con estos ajustes)' : ''}`}
                </Button>
                {audioOnlyRemix && (
                  <Button size="sm" variant="outline" className="h-8" onClick={() => void startProcess('mix', { forceMux: true })} disabled={isProcessing} title="Mezcla el audio Y reescribe el vídeo de la parte con esa mezcla (tarda: copia el vídeo entero)">
                    Mezclar y muxar el vídeo
                  </Button>
                )}
              </div>
            )}
            {audioOnlyRemix && (
              <p className="text-[10px] leading-tight text-muted-foreground">
                Re-mezclar regenera solo el audio (segundos): actualiza la <strong>mezcla vigente</strong> de
                arriba, que es lo que usan Compose, Reels, transcripción y export. El vídeo de la parte no se
                reescribe — si quieres verlo con el audio nuevo, usa «Muxar el vídeo» dentro de VÍDEO.
                Si cambias el offset se vuelve a muxar solo.
              </p>
            )}
            <p className="text-[10px] leading-tight text-muted-foreground">
              ¿Quieres retocar mesa y ambiente por separado al montar? En <strong>Compose</strong> y en{' '}
              <strong>Reels</strong>, en el panel de mezcla por partes, «Separar en pistas (mesa + ambiente)»
              lleva estos dos stems procesados como pistas independientes (con esta mezcla a ×1) y silencia
              la mezcla — sin volver a mezclar aquí.
            </p>
          </div>
        )}

        {/* Progress bar while processing */}
        {isProcessing && (
          <div>
            <Progress value={progressValue} className="h-1.5" />
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{stageLabel}</span>
              <span>{Math.round(progressValue)}%</span>
            </div>
          </div>
        )}

        {/* Error detail */}
        {part.status === 'error' && part.error && (
          <p className="text-xs text-destructive">{part.error}</p>
        )}

      </CardContent>
    </Card>
  );
}
