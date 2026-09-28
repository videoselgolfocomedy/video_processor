'use client';

import { useCallback, useMemo, useState } from 'react';
import { partTrims, partUsedRanges } from '@/lib/part-trims';
import { useParams } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { BoardDuckingPanel } from '@/components/audio/board-ducking-panel';
import { applyPendingParts } from '@/lib/remix-ducking';
import { useToast } from '@/hooks/use-toast';
import type { BoardDuckRegion, ProjectPart } from '@/types/project';
import type { StemSegment } from '@/lib/audio-stems';

/** Host-provided binding for "mesa y ambiente como pistas separadas" — the
 *  Compose store or the current reel's store actions. */
export interface StemTracksBinding {
  /** The editor already has the stem tracks (main audio muted). */
  active: boolean;
  apply: (layout: StemSegment[], mainAudioFileName?: string, mainAudioOffsetMs?: number) => void;
  remove: () => void;
  /** When set, the action is unavailable and this explains why. */
  disabledReason?: string;
}

/**
 * Mesa ducking + ambient boost for PARTS projects, embedded in the Compose and
 * Reels editors. The concat muxed's audio is baked per part, so the tools work
 * per PART: pick a part (or jump via "Ir al playhead", which auto-selects the
 * part under the editor's playhead), mark regions on that part's board/camera
 * wav, and Apply re-mixes THAT part and re-concats the muxed.
 *
 * Time mapping: editor playhead → concat time (caller-provided) → part-local
 * time (concat minus the sum of previous parts' durations) →
 *   board wav time   = local + max(0, part offset)      (board atrim)
 *   camera wav time  = local + max(0, -part offset)     (ambient atrim)
 */
interface PartsMixPanelsProps {
  /** Editor playhead → time in the CONCAT muxed timeline (ms), or null. */
  getEditorConcatMs: () => number | null;
  stems?: StemTracksBinding;
}

export function PartsMixPanels({ getEditorConcatMs, stems }: PartsMixPanelsProps) {
  const params = useParams();
  const projectId = params?.id as string;
  const { toast } = useToast();
  const currentProject = useProjectStore((s) => s.currentProject);
  const fetchProject = useProjectStore((s) => s.fetchProject);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  // Lazy-mount the panels: <details> only hides children VISUALLY — a mounted
  // BoardDuckingPanel fetches its envelope/fillers immediately, so without
  // this gate every visit to Compose/Reels downloads ~0.5-1 MB of envelope
  // JSON (and decodes the wavs server-side on cold cache) for accordions the
  // user may never open.
  const [duckOpen, setDuckOpen] = useState(false);
  const [boostOpen, setBoostOpen] = useState(false);

  // Ordered parts that made it into the concat (they have a muxed duration).
  const orderedParts = useMemo(
    () => [...(currentProject?.parts ?? [])]
      .filter((p) => p.muxedDurationMs != null && p.alignmentOffsetMs !== undefined)
      .sort((a, b) => a.order - b.order),
    [currentProject?.parts]
  );
  const partStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const p of orderedParts) {
      starts.push(acc);
      acc += p.muxedDurationMs ?? 0;
    }
    return starts;
  }, [orderedParts]);

  const [selPartId, setSelPartId] = useState<string | null>(null);
  const part = orderedParts.find((p) => p.id === selPartId) ?? orderedParts[0];

  const findPartAt = useCallback((concatMs: number): { part: ProjectPart; localMs: number } | null => {
    for (let i = 0; i < orderedParts.length; i++) {
      const start = partStarts[i];
      const end = start + (orderedParts[i].muxedDurationMs ?? 0);
      if (concatMs >= start && concatMs < end) {
        return { part: orderedParts[i], localMs: concatMs - start };
      }
    }
    return null;
  }, [orderedParts, partStarts]);

  // "Ir al playhead": if the playhead falls in ANOTHER part, switch the
  // selector to it (the panel remounts) and ask for a second click.
  const makeGetMs = useCallback((kind: 'board' | 'ambient') => (): number | null => {
    const concatMs = getEditorConcatMs();
    if (concatMs == null || !part) return null;
    const hit = findPartAt(concatMs);
    if (!hit) return null;
    if (hit.part.id !== part.id) {
      setSelPartId(hit.part.id);
      toast({ title: `Cambiado a ${hit.part.name}`, description: 'El playhead cae en esa parte — pulsa "Ir al playhead" otra vez.' });
      return null;
    }
    const trims = partTrims(hit.part);
    const trim = kind === 'board' ? trims.boardTrimMs : trims.ambientTrimMs;
    return Math.max(0, hit.localMs + (hit.part.muxedAudioTrimMs ?? 0) + trim);
  }, [getEditorConcatMs, part, findPartAt, toast]);

  const saveRegions = useCallback(
    (field: 'boardDuckRegions' | 'ambientBoostRegions') =>
      async (regions: BoardDuckRegion[]) => {
        if (!part) return false;
        try {
          const res = await fetch(`/api/projects/${projectId}/parts/${part.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: regions }),
          });
          if (!res.ok) throw new Error(`Error ${res.status}`);
          await fetchProject(projectId);
          return true;
        } catch (err) {
          toast({ title: 'No se pudo guardar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
          return false;
        }
      },
    [projectId, part, fetchProject, toast]
  );

  // Apply = re-mix THIS part, then re-concat the muxed. Compose/reels clip and
  // subtitle times stay valid (same durations → same concat timeline).
  const applyRemix = useCallback(async () => {
    if (!part) return;
    setBusy(true);
    setBusyMsg('Lanzando re-mezcla…');
    try {
      toast({ title: `Re-mezclando ${part.name}…`, description: 'Solo el audio: el vídeo no se reescribe.' });
      const r = await applyPendingParts(projectId, currentProject?.parts ?? [], [part.id], setBusyMsg);
      if (!r.ok) throw new Error(r.error);
      await fetchProject(projectId);
      toast({
        title: 'Audio actualizado',
        description: r.joined
          ? 'La parte se re-mezcló y el vídeo unido se regeneró.'
          : 'La mezcla ya lleva tus cambios. El vídeo unido conserva su audio anterior; vuelve a unir solo si lo quieres dentro del vídeo.',
      });
    } catch (err) {
      toast({ title: 'No se pudo re-mezclar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setBusy(false);
      setBusyMsg(null);
    }
  }, [projectId, part, currentProject?.parts, fetchProject, toast]);

  // "Separar en pistas": fetch the per-part stem layout (existence checked
  // server-side) and hand it to the host editor's store.
  const [stemsBusy, setStemsBusy] = useState(false);
  const applyStems = useCallback(async () => {
    if (!stems) return;
    setStemsBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/stems`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `Error ${res.status}`);
      const { layout, mainAudioFileName, mainAudioOffsetMs, concatDone } = data as {
        layout: StemSegment[]; mainAudioFileName?: string; mainAudioOffsetMs: number; concatDone: boolean;
      };
      if (!concatDone || layout.length === 0) {
        throw new Error('Mezcla y muxa las partes en Sync & Mix antes de separar las pistas.');
      }
      const missing = layout.filter((seg) => seg.boardFile && !(seg.boardExists && seg.ambientExists));
      if (missing.length > 0) {
        throw new Error(
          `Faltan los stems de ${missing.map((m) => m.partName).join(', ')} — se generan al mezclar: ` +
          'pulsa «Re-mezclar» en Sync & Mix (o «Aplicar» aquí) y vuelve a intentarlo.',
        );
      }
      stems.apply(layout, mainAudioFileName, mainAudioOffsetMs);
      toast({
        title: 'Mesa y ambiente separados',
        description: 'Dos pistas nuevas con los stems procesados; la pista de mezcla queda silenciada. Ajusta el volumen por clip.',
      });
    } catch (err) {
      toast({ title: 'No se pudo separar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setStemsBusy(false);
    }
  }, [projectId, stems, toast]);

  if (!currentProject || orderedParts.length === 0 || !part) return null;

  const prefix = `part_${part.id.slice(0, 8)}`;
  const boardWav = `${prefix}_board.wav`;
  const cameraWav = `${part.videoSourceId}_audio.wav`;
  const hasBoard = !!part.boardSourceId;

  return (
    <>
      {stems && (
        <div className="space-y-1 rounded-md border border-border p-2">
          <p className="text-xs font-medium">Mesa y ambiente como pistas separadas</p>
          {stems.active ? (
            <>
              <p className="text-[10px] leading-snug text-muted-foreground">
                ✓ Activo: <span className="text-emerald-400">Mesa (voz)</span> y{' '}
                <span className="text-sky-400">Ambiente (público)</span> son pistas independientes (los stems
                procesados de cada parte, con la mezcla original a ×1) y la pista de mezcla está{' '}
                <span className="text-red-400">silenciada</span>. Cambia el volumen de cada clip en sus
                propiedades o corta solo una de las dos; el export usa exactamente estas pistas.
              </p>
              <button
                type="button"
                onClick={stems.remove}
                disabled={stemsBusy}
                className="rounded border border-border px-2 py-1 text-[11px] hover:bg-secondary disabled:opacity-50"
              >
                Volver a la mezcla única
              </button>
            </>
          ) : (
            <>
              <p className="text-[10px] leading-snug text-muted-foreground">
                Trae la mesa procesada y el ambiente procesado (con je-je, nivelado y ducking ya aplicados) como
                dos pistas de audio independientes y silencia la mezcla: así puedes subir o bajar cada una por
                tramos aquí mismo, sin volver a mezclar. Si luego re-mezclas, los stems se actualizan solos.
              </p>
              {stems.disabledReason ? (
                <p className="text-[10px] text-amber-300">{stems.disabledReason}</p>
              ) : (
                <button
                  type="button"
                  onClick={applyStems}
                  disabled={stemsBusy || busy}
                  className="rounded border border-primary/60 bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50"
                >
                  {stemsBusy ? 'Preparando…' : 'Separar en pistas (mesa + ambiente)'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Part selector — which part's mix the panels below edit. */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Parte:</span>
        <select
          className="h-7 flex-1 rounded border border-border bg-background px-1 text-xs outline-none"
          value={part.id}
          onChange={(e) => setSelPartId(e.target.value)}
          disabled={busy}
        >
          {orderedParts.map((p, i) => (
            <option key={p.id} value={p.id}>
              #{i + 1} {p.name}{p.status !== 'done' ? (p.muxedDurationMs != null ? ' (re-mezcla pendiente)' : ' (sin mezclar)') : ''}
            </option>
          ))}
        </select>
      </div>

      {busyMsg && (
        <p className="text-[11px] text-primary" aria-live="polite">{busyMsg}</p>
      )}

      {hasBoard && (
        <details
          className="rounded-md border border-border"
          onToggle={(e) => setDuckOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            Atenuar mesa (je-je / ehh) — {part.name}
          </summary>
          {duckOpen && (
          <div className="p-2">
            <BoardDuckingPanel
              key={`duck-${part.id}`}
              projectId={projectId}
              boardUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(boardWav)}`}
              fillersUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(`${prefix}_fillers.json`)}`}
              envelopeUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(boardWav)}`}
              detectUrl={`/api/projects/${projectId}/parts/${part.id}/detect-fillers`}
              initialRegions={part.boardDuckRegions ?? []}
              boardTrimMs={partUsedRanges(part).board.startMs}
              usedEndMs={partUsedRanges(part).board.endMs}
              disabled={busy}
              applyLabel="Aplicar (re-mezclar audio)"
              applyHint="Baja la mesa y regenera solo el audio de esta parte — el vídeo no se reescribe (segundos)."
              getEditorBoardMs={makeGetMs('board')}
              onSave={saveRegions('boardDuckRegions')}
              onApplied={applyRemix}
            />
          </div>
          )}
        </details>
      )}

      <details
        className="rounded-md border border-border"
        onToggle={(e) => setBoostOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
          Subir ambiente (risas) — {part.name}
        </summary>
        {boostOpen && (
        <div className="p-2">
          <BoardDuckingPanel
            key={`boost-${part.id}`}
            mode="boost"
            projectId={projectId}
            boardUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(cameraWav)}`}
            fillersUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(cameraWav)}`}
            detectUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(cameraWav)}`}
            envelopeUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(cameraWav)}`}
            initialRegions={part.ambientBoostRegions ?? []}
            boardTrimMs={partUsedRanges(part).ambient.startMs}
            usedEndMs={partUsedRanges(part).ambient.endMs}
            disabled={busy}
            applyLabel="Aplicar (re-mezclar audio)"
            applyHint="Sube el ambiente (público) de esta parte con fade y regenera solo el audio — la voz de mesa queda intacta y el vídeo no se reescribe."
            getEditorBoardMs={makeGetMs('ambient')}
            onSave={saveRegions('ambientBoostRegions')}
            onApplied={applyRemix}
          />
        </div>
        )}
      </details>
    </>
  );
}
