'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Link2, Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { EXPORT_PRESETS } from '@/config/export-presets';
import {
  formatBytes,
  formatDurationMs,
  type ConcatCandidate,
  type ConcatCandidateGroup,
} from '@/lib/concat-exports';

/**
 * "Unir exports": pick finished YouTube exports of ANY project on this
 * machine, order them, and render one file to upload. The join is a new
 * export of the current project (it lands in its render queue below).
 */
interface Props {
  projectId: string;
  /** Called after the job starts, so the page refetches the render queue. */
  onStarted: () => void;
}

function keyOf(c: Pick<ConcatCandidate, 'projectId' | 'exportId'>): string {
  return `${c.projectId}:${c.exportId}`;
}

function presetName(id: string): string {
  return EXPORT_PRESETS.find((p) => p.id === id)?.name ?? id;
}

export function ConcatExportsCard({ projectId, onStarted }: Props) {
  const { toast } = useToast();
  const [groups, setGroups] = useState<ConcatCandidateGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ConcatCandidate[]>([]);
  const [label, setLabel] = useState('');
  const [starting, setStarting] = useState(false);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/export/concat`);
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = (await res.json()) as { groups: ConcatCandidateGroup[] };
      setGroups(data.groups);
      // The current project starts open; others collapsed.
      setOpenProjects((prev) => ({ [projectId]: true, ...prev }));
      // Drop selected pieces whose file disappeared meanwhile.
      const available = new Set(data.groups.flatMap((g) => g.exports.map(keyOf)));
      setSelected((sel) => sel.filter((c) => available.has(keyOf(c))));
    } catch (err) {
      toast({ title: 'No se pudo leer la lista de exports', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedKeys = useMemo(() => new Set(selected.map(keyOf)), [selected]);
  const totalMs = selected.reduce((s, c) => s + c.durationMs, 0);
  const totalBytes = selected.reduce((s, c) => s + c.sizeBytes, 0);
  const sameFormat = selected.length > 0 && selected.every((c) => c.formatKey === selected[0].formatKey);

  const toggle = (c: ConcatCandidate) => {
    setSelected((sel) => (sel.some((s) => keyOf(s) === keyOf(c)) ? sel.filter((s) => keyOf(s) !== keyOf(c)) : [...sel, c]));
  };
  const move = (index: number, dir: -1 | 1) => {
    setSelected((sel) => {
      const j = index + dir;
      if (j < 0 || j >= sel.length) return sel;
      const next = [...sel];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  };

  const start = async () => {
    if (selected.length < 2) return;
    setStarting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/export/concat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: selected.map((c) => ({ projectId: c.projectId, exportId: c.exportId })),
          label: label.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `Error ${res.status}`);
      toast({
        title: `Uniendo ${selected.length} vídeos`,
        description: sameFormat
          ? 'Mismo formato: se unen sin recodificar (segundos). Aparece en la cola de render.'
          : 'Formatos distintos: se recodifica al tamaño del primero. Aparece en la cola de render.',
      });
      setSelected([]);
      setLabel('');
      onStarted();
    } catch (err) {
      toast({ title: 'No se pudo iniciar la unión', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setStarting(false);
    }
  };

  const candidateCount = groups?.reduce((n, g) => n + g.exports.length, 0) ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            Unir exports en un solo vídeo
          </CardTitle>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => void load()} disabled={loading} title="Volver a leer los exports de todos los proyectos">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Actualizar
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Elige exports de YouTube ya terminados, de este proyecto o de otros, y el orden en que se pegan. Si todos tienen el mismo formato se unen sin recodificar; si no, se recodifican al tamaño del primero.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Pieces available, by project ── */}
        <div className="space-y-1">
          {groups === null && <p className="text-xs text-muted-foreground">Leyendo exports…</p>}
          {groups !== null && candidateCount === 0 && (
            <p className="text-xs text-muted-foreground">Ningún proyecto tiene exports de YouTube terminados todavía.</p>
          )}
          {groups?.map((g) => {
            const open = openProjects[g.projectId] ?? false;
            const chosen = g.exports.filter((c) => selectedKeys.has(keyOf(c))).length;
            return (
              <div key={g.projectId} className="rounded-md border border-border">
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-muted/50"
                  onClick={() => setOpenProjects((o) => ({ ...o, [g.projectId]: !open }))}
                >
                  <span className="font-medium truncate">
                    {g.projectName}
                    {g.projectId === projectId && <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">(este proyecto)</span>}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {g.exports.length} export{g.exports.length !== 1 ? 's' : ''}{chosen > 0 ? ` · ${chosen} elegido${chosen !== 1 ? 's' : ''}` : ''} {open ? '▾' : '▸'}
                  </span>
                </button>
                {open && (
                  <div className="border-t border-border divide-y divide-border">
                    {g.exports.map((c) => {
                      const k = keyOf(c);
                      const on = selectedKeys.has(k);
                      const pos = selected.findIndex((s) => keyOf(s) === k);
                      return (
                        <label key={k} className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer ${on ? 'bg-primary/10' : 'hover:bg-muted/40'}`}>
                          <input type="checkbox" className="h-3.5 w-3.5 rounded" checked={on} onChange={() => toggle(c)} />
                          <div className="flex-1 min-w-0">
                            <div className="truncate font-medium">
                              {on && <span className="mr-1.5 inline-block rounded bg-primary px-1 text-[10px] text-primary-foreground">{pos + 1}º</span>}
                              {c.label ?? presetName(c.presetId)}
                              <span className="ml-1.5 text-muted-foreground font-normal">{c.fileName}</span>
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {formatDurationMs(c.durationMs)} · {c.width}x{c.height} · {formatBytes(c.sizeBytes)}
                              {c.completedAt ? ` · ${new Date(c.completedAt).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Order + go ── */}
        {selected.length > 0 && (
          <div className="rounded-md border border-border p-3 space-y-2">
            <div className="text-xs font-medium">Orden de pegado</div>
            <ol className="space-y-1">
              {selected.map((c, i) => (
                <li key={keyOf(c)} className="flex items-center gap-2 text-xs rounded bg-secondary px-2 py-1.5">
                  <span className="w-5 text-muted-foreground tabular-nums">{i + 1}.</span>
                  <div className="flex-1 min-w-0 truncate">
                    <span className="font-medium">{c.projectName}</span>
                    <span className="text-muted-foreground"> · {c.label ?? presetName(c.presetId)} · {formatDurationMs(c.durationMs)}</span>
                  </div>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => move(i, -1)} disabled={i === 0} title="Subir"><ArrowUp className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => move(i, 1)} disabled={i === selected.length - 1} title="Bajar"><ArrowDown className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-400" onClick={() => toggle(c)} title="Quitar"><X className="h-3 w-3" /></Button>
                </li>
              ))}
            </ol>
            <div className="text-[10px] text-muted-foreground">
              Total {formatDurationMs(totalMs)} · {formatBytes(totalBytes)}
              {selected.length >= 2 && (
                sameFormat
                  ? <span className="ml-2 text-emerald-400">mismo formato: unión sin recodificar</span>
                  : <span className="ml-2 text-amber-400">formatos distintos: se recodificará a {selected[0].width}x{selected[0].height} (tarda como un export)</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={`Nombre (opcional) — p. ej. «Unión de ${selected.length} vídeos»`}
                className="flex-1 h-8 rounded-md border border-border bg-background px-2 text-xs"
              />
              <Button size="sm" className="text-xs gap-1" onClick={() => void start()} disabled={selected.length < 2 || starting}>
                {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
                Generar vídeo único
              </Button>
            </div>
            {selected.length < 2 && <p className="text-[10px] text-muted-foreground">Elige al menos dos exports.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
