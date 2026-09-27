'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useProjectStore } from '@/stores/project-store';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PartCard } from '@/components/parts/part-card';
import { PartsConcatCard } from '@/components/parts/parts-concat-card';
import type { PartsConcatState, ProjectPart } from '@/types/project';
import { FolderInput, History, Loader2, Plus, Wand2 } from 'lucide-react';

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';

interface PartsFlowProps {
  /** Page heading (the flow is mounted both at /sync and /parts). */
  title?: string;
  description?: string;
  /** When set, show a link to the legacy single-pair mixer page. */
  legacyHref?: string;
}

/**
 * The parts pipeline flow (add parts → align → mix/mux per part → join).
 * This is THE Sync & Mix experience — mounted at /project/[id]/sync (menu
 * entry) and kept at /project/[id]/parts as an alias for old links. A single
 * camera+board pair is simply a one-part project: joining one part clones the
 * part video instantly.
 */
export function PartsFlow({ title, description, legacyHref }: PartsFlowProps) {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject } = useProjectStore();
  const { toast } = useToast();

  const [parts, setParts] = useState<ProjectPart[]>([]);
  const [concat, setConcat] = useState<PartsConcatState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);

  // '' = not selected yet; effect below picks a sensible default.
  const [addVideoId, setAddVideoId] = useState('');
  // null = uninitialized (default pending); '' = explicit "sin audio de mesa".
  const [addBoardId, setAddBoardId] = useState<string | null>(null);

  // GET on mount also reconciles orphaned jobs after server restarts.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/parts`);
      if (res.ok) {
        const data = await res.json();
        setParts(data.parts ?? []);
        setConcat(data.concat ?? null);
      }
    } catch {
      // network error — keep last known state
    }
    setLoaded(true);
    void fetchProject(projectId);
  }, [projectId, fetchProject]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sources = useMemo(
    () => currentProject?.sources ?? [],
    [currentProject?.sources]
  );

  const videoSources = useMemo(
    () =>
      sources
        .filter((s) => s.type === 'video')
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
    [sources]
  );
  const audioSources = useMemo(
    () =>
      sources
        .filter((s) => s.type === 'audio')
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
    [sources]
  );

  const usedVideoIds = useMemo(
    () => new Set(parts.map((p) => p.videoSourceId)),
    [parts]
  );
  const usedBoardIds = useMemo(
    () =>
      new Set(
        parts
          .map((p) => p.boardSourceId)
          .filter((id): id is string => Boolean(id))
      ),
    [parts]
  );

  const unusedVideos = useMemo(
    () => videoSources.filter((v) => !usedVideoIds.has(v.id)),
    [videoSources, usedVideoIds]
  );
  const unusedAudios = useMemo(
    () => audioSources.filter((a) => !usedBoardIds.has(a.id)),
    [audioSources, usedBoardIds]
  );

  // Default selections for the add-part card: prefer unused sources.
  useEffect(() => {
    if (videoSources.length === 0) return;
    setAddVideoId((prev) => {
      if (prev && videoSources.some((v) => v.id === prev)) return prev;
      const unused = videoSources.find((v) => !usedVideoIds.has(v.id));
      return (unused ?? videoSources[0]).id;
    });
  }, [videoSources, usedVideoIds]);

  useEffect(() => {
    if (addBoardId !== null) return;
    if (audioSources.length === 0) return;
    const unused = audioSources.find((a) => !usedBoardIds.has(a.id));
    setAddBoardId(unused ? unused.id : '');
  }, [addBoardId, audioSources, usedBoardIds]);

  const sortedParts = useMemo(
    () => [...parts].sort((a, b) => a.order - b.order),
    [parts]
  );

  const anyPartProcessing = parts.some((p) => p.status === 'processing');
  const concatRunning = concat?.status === 'running';
  const anyProcessing = anyPartProcessing || concatRunning;

  const createPart = useCallback(
    async (videoSourceId: string, boardSourceId?: string) => {
      const res = await fetch(`/api/projects/${projectId}/parts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoSourceId,
          ...(boardSourceId ? { boardSourceId } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || `Error ${res.status}`
        );
      }
    },
    [projectId]
  );

  const handleAddPart = useCallback(async () => {
    if (!addVideoId) return;
    setAdding(true);
    try {
      await createPart(addVideoId, addBoardId || undefined);
      // Reset selections so the defaults advance to the next unused sources.
      setAddVideoId('');
      setAddBoardId(null);
      await refresh();
    } catch (err) {
      toast({
        title: 'No se pudo añadir la parte',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setAdding(false);
    }
  }, [addVideoId, addBoardId, createPart, refresh, toast]);

  const handleAutoCreate = useCallback(async () => {
    if (unusedVideos.length === 0) return;
    setAutoCreating(true);
    let created = 0;
    try {
      for (let i = 0; i < unusedVideos.length; i++) {
        await createPart(unusedVideos[i].id, unusedAudios[i]?.id);
        created++;
      }
      toast({
        title: `${created} parte${created === 1 ? '' : 's'} creada${created === 1 ? '' : 's'}`,
      });
    } catch (err) {
      toast({
        title: 'Auto-crear partes falló',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
    setAddVideoId('');
    setAddBoardId(null);
    await refresh();
    setAutoCreating(false);
  }, [unusedVideos, unusedAudios, createPart, refresh, toast]);

  const handleMove = useCallback(
    async (partId: string, direction: -1 | 1) => {
      const ordered = [...parts]
        .sort((a, b) => a.order - b.order)
        .map((p) => p.id);
      const idx = ordered.indexOf(partId);
      const target = idx + direction;
      if (idx < 0 || target < 0 || target >= ordered.length) return;
      [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];
      try {
        const res = await fetch(`/api/projects/${projectId}/parts/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: ordered }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            (data as { error?: string }).error || `Error ${res.status}`
          );
        }
      } catch (err) {
        toast({
          title: 'No se pudo reordenar',
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        });
      }
      await refresh();
    },
    [parts, projectId, refresh, toast]
  );

  if (!currentProject) return null;

  const hasExistingMux = Boolean(currentProject.sync?.muxedVideoPath);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">
          {title ?? 'Partes — varios vídeos + audios de mesa'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {description ??
            'Cada parte es un trozo de vídeo con su audio de mesa. Se procesan en paralelo (alinear → mezclar → mux) y al final se unen en un único vídeo en el orden definido, listo para transcribir.'}
        </p>
        {legacyHref && (
          <p className="mt-1 text-xs text-muted-foreground">
            <Link
              href={legacyHref}
              className="inline-flex items-center gap-1 underline hover:text-foreground"
            >
              <History className="h-3 w-3" />
              Flujo clásico (legacy): mezclador de un solo par con los audios de
              Audio-prep
            </Link>
          </p>
        )}
      </div>

      {/* Empty state: no video sources */}
      {videoSources.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            <p className="mb-3">
              Sube primero los vídeos y audios de mesa en Importar.
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/project/${projectId}/import`}>
                <FolderInput className="mr-2 h-4 w-4" />
                Ir a Importar
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Add part */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Añadir parte
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Vídeo
                  </label>
                  <select
                    className={SELECT_CLASS}
                    value={addVideoId}
                    onChange={(e) => setAddVideoId(e.target.value)}
                  >
                    {videoSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.originalName}
                        {usedVideoIds.has(s.id) ? ' (ya usada)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Audio de mesa
                  </label>
                  <select
                    className={SELECT_CLASS}
                    value={addBoardId ?? ''}
                    onChange={(e) => setAddBoardId(e.target.value)}
                  >
                    <option value="">— sin audio de mesa —</option>
                    {audioSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.originalName}
                        {usedBoardIds.has(s.id) ? ' (ya usada)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={handleAddPart}
                  disabled={adding || autoCreating || !addVideoId}
                >
                  {adding ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Añadir parte
                </Button>
                {unusedVideos.length > 0 && (
                  <Button
                    variant="outline"
                    onClick={handleAutoCreate}
                    disabled={adding || autoCreating}
                    title="Empareja los vídeos sin usar con los audios de mesa sin usar, por orden de subida"
                  >
                    {autoCreating ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Wand2 className="mr-2 h-4 w-4" />
                    )}
                    Auto-crear partes ({unusedVideos.length})
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Parts list */}
          {loaded && sortedParts.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Aún no hay partes. Añade la primera con los selectores de
                arriba.
              </CardContent>
            </Card>
          )}
          <div className="space-y-3">
            {sortedParts.map((part, index) => (
              <PartCard
                key={part.id}
                part={part}
                projectId={projectId}
                sources={sources}
                index={index}
                total={sortedParts.length}
                anyProcessing={anyProcessing}
                onRefresh={refresh}
                onMove={handleMove}
              />
            ))}
          </div>

          {/* Join */}
          {sortedParts.length > 0 && (
            <PartsConcatCard
              parts={sortedParts}
              concat={concat}
              projectId={projectId}
              hasExistingMux={hasExistingMux}
              onRefresh={refresh}
            />
          )}
        </>
      )}
    </div>
  );
}
