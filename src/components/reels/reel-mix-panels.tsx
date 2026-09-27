'use client';

import { useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useReelStore } from '@/stores/reel-store';
import { useProjectStore } from '@/stores/project-store';
import { BoardDuckingPanel } from '@/components/audio/board-ducking-panel';
import { PartsMixPanels } from '@/components/parts/parts-mix-panels';
import { remixWithDucking, parseMixParams } from '@/lib/remix-ducking';
import { useToast } from '@/hooks/use-toast';

/**
 * The two in-editor MIX tweak panels for reels — board (mesa) ducking of
 * je-je/eehh fillers, and ambient (audience/laughs) boost with fades. Shared
 * by BOTH reel phases: the setup view's right panel AND the timeline view's
 * right column, so the tools are reachable wherever the user is editing.
 * Single-pair projects only (they need sync.selectedAudioPath, the mix wav).
 *
 * Mappings (see CLAUDE.md §8):
 *  - mesa:    board_time  = reel_source + Δ (muxedAudioOffset) + max(0, alignment+manualAdjust)
 *  - ambiente: ambient_time = mix_time  = reel_source + Δ (ambient drives the mix, no trim)
 */
export function ReelMixPanels({ reelId }: { reelId: string }) {
  const params = useParams();
  const projectId = params?.id as string;
  const { toast } = useToast();
  const currentProject = useProjectStore((s) => s.currentProject);
  const fetchProject = useProjectStore((s) => s.fetchProject);
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const reelPhase = useReelStore((s) => s.phase);
  const applyStemTracks = useReelStore((s) => s.applyStemTracks);
  const removeStemTracks = useReelStore((s) => s.removeStemTracks);
  const reelStemsActive = !!reel?.composition.tracks.some((t) => t.id === 'ra_mesa' || t.id === 'ra_amb');

  const boardSource = currentProject?.sources.find((s) => s.role === 'board');
  const selectedAudioName = currentProject?.sync.selectedAudioPath;
  const duckReady = !!(boardSource && selectedAudioName && currentProject);

  // Reel playhead → SOURCE (muxed) time, handling both phases.
  const getReelSourceMs = useCallback((): number | null => {
    if (!currentProject || !reel) return null;
    const rs = useReelStore.getState();
    const t = rs.currentTimeMs;
    if (rs.phase === 'timeline') {
      const rv1 = reel.composition.clips
        .filter((c) => c.trackId === 'rv1')
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
      const cur = rv1.find((c) => t >= c.timelineStartMs && t < c.timelineEndMs) ?? rv1[0];
      return cur ? cur.sourceInMs + (t - cur.timelineStartMs) : (reel.sourceStartMs ?? reel.startMs) + t;
    }
    return (reel.sourceStartMs ?? reel.startMs) + t;
  }, [currentProject, reel]);

  const getReelBoardMs = useCallback((): number | null => {
    if (!currentProject) return null;
    const sourceMs = getReelSourceMs();
    if (sourceMs == null) return null;
    const delta = currentProject.sync.muxedVideoPath ? (currentProject.sync.muxedAudioOffsetMs ?? 0) : 0;
    const manualAdjust = selectedAudioName ? (parseMixParams(selectedAudioName)?.manualAdjustMs ?? 0) : 0;
    const off = Math.max(0, (currentProject.audio.alignmentOffsetMs ?? 0) + manualAdjust);
    return Math.max(0, sourceMs + delta + off);
  }, [currentProject, selectedAudioName, getReelSourceMs]);

  // Ambient BOOST: ambient time == mix time (no board-trim offset).
  const ambientFileName = (() => {
    if (!currentProject) return undefined;
    const src = (selectedAudioName ? parseMixParams(selectedAudioName)?.ambientSource : undefined) ?? 'subtracted';
    let p: string | undefined;
    if (src === 'raw') {
      const cam = currentProject.sources.find((s) => s.role === 'camera' && s.type === 'video');
      p = currentProject.audio.extractedTracks.find((t) => t.sourceFileId === cam?.id)?.path;
    } else if (src === 'cleaned') {
      p = currentProject.audio.cameraAmbientPath;
    } else {
      p = currentProject.audio.ambientPath;
    }
    return p?.split('/').pop();
  })();
  const boostReady = !!(ambientFileName && selectedAudioName && currentProject);
  const getReelAmbientMs = useCallback((): number | null => {
    if (!currentProject) return null;
    const sourceMs = getReelSourceMs();
    if (sourceMs == null) return null;
    const delta = currentProject.sync.muxedVideoPath ? (currentProject.sync.muxedAudioOffsetMs ?? 0) : 0;
    return Math.max(0, sourceMs + delta);
  }, [currentProject, getReelSourceMs]);

  const saveRegions = useCallback(
    (field: 'boardDuckRegions' | 'ambientBoostRegions') =>
      async (regions: unknown) => {
        try {
          const proj = useProjectStore.getState().currentProject;
          if (!proj) throw new Error('Proyecto no cargado');
          const res = await fetch(`/api/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: { ...proj.audio, [field]: regions } }),
          });
          if (!res.ok) throw new Error(`Error ${res.status}`);
          await fetchProject(projectId);
          return true;
        } catch (err) {
          toast({ title: 'No se pudo guardar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
          return false;
        }
      },
    [projectId, fetchProject, toast]
  );

  const applyRemix = useCallback(
    (workingTitle: string, doneTitle: string, doneDesc: string) =>
      async () => {
        toast({ title: workingTitle, description: 'Volviendo a mezclar…' });
        const proj = useProjectStore.getState().currentProject;
        if (!proj) return;
        const r = await remixWithDucking(projectId, proj);
        if (r.ok) {
          await fetchProject(projectId);
          toast({ title: doneTitle, description: doneDesc });
        } else {
          toast({ title: 'No se pudo re-mezclar', description: r.error, variant: 'destructive' });
        }
      },
    [projectId, fetchProject, toast]
  );

  if (!currentProject || !reel) return null;

  // PARTS projects: no selected mix wav (audio baked per part in the concat
  // muxed) — the tools work per part instead. getReelAmbientMs is also the
  // CONCAT time (parts concat sets muxedAudioOffsetMs = 0).
  const isPartsProject = (currentProject.parts?.length ?? 0) > 0 &&
    !selectedAudioName && !!currentProject.sync.muxedVideoPath;
  if (isPartsProject) {
    return (
      <PartsMixPanels
        getEditorConcatMs={getReelAmbientMs}
        stems={{
          active: reelStemsActive,
          apply: (layout, mainFile, mainOff) => applyStemTracks(reelId, layout, mainFile, mainOff),
          remove: () => removeStemTracks(reelId),
          disabledReason: reelPhase !== 'timeline'
            ? 'Entra en la línea de tiempo del reel («Continuar») para separar sus pistas.'
            : undefined,
        }}
      />
    );
  }

  return (
    <>
      {/* Board (mesa) ducking — mark the "je-je"/"eehh" while watching the reel;
          re-mixes so only the mesa drops (ambient intact). */}
      {duckReady && (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            Atenuar mesa (je-je / ehh) en la mezcla
          </summary>
          <div className="p-2">
            <BoardDuckingPanel
              projectId={projectId}
              boardUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(boardSource!.storedName)}`}
              fillersUrl={`/api/projects/${projectId}/audio/file?name=board_fillers.json`}
              envelopeUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(boardSource!.storedName)}`}
              detectUrl={`/api/projects/${projectId}/audio/detect-fillers`}
              initialRegions={currentProject.audio.boardDuckRegions ?? []}
              boardTrimMs={Math.max(0, currentProject.audio.alignmentOffsetMs ?? 0)}
              applyLabel="Aplicar (re-mezclar mesa)"
              applyHint="Baja solo la mesa en las zonas activas; el ambiente queda intacto."
              getEditorBoardMs={getReelBoardMs}
              onSave={saveRegions('boardDuckRegions')}
              onApplied={applyRemix('Re-mezclando mesa…', 'Mezcla actualizada', 'La mesa quedó atenuada; el ambiente intacto.')}
            />
          </div>
        </details>
      )}

      {/* Ambient BOOST — raise the audience/laughs in marked ranges with a
          fade pattern; only the ambient branch of the mix goes up, the mesa
          voice stays clean (no echo, no canned-laughter jump). */}
      {boostReady && (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            Subir ambiente (risas) en la mezcla
          </summary>
          <div className="p-2">
            <BoardDuckingPanel
              mode="boost"
              projectId={projectId}
              boardUrl={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(ambientFileName!)}`}
              fillersUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(ambientFileName!)}`}
              detectUrl={`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(ambientFileName!)}`}
              initialRegions={currentProject.audio.ambientBoostRegions ?? []}
              boardTrimMs={0}
              applyLabel="Aplicar (re-mezclar ambiente)"
              applyHint="Sube solo el ambiente (público) en las zonas, con fade — la voz de mesa queda intacta."
              getEditorBoardMs={getReelAmbientMs}
              onSave={saveRegions('ambientBoostRegions')}
              onApplied={applyRemix('Re-mezclando ambiente…', 'Mezcla actualizada', 'El público sube en tus zonas; la voz sigue limpia.')}
            />
          </div>
        </details>
      )}
    </>
  );
}
