'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Check, History, RotateCcw, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useComposeStore } from '@/stores/compose-store';
import { useToast } from '@/hooks/use-toast';
import type { ComposeVersion } from '@/types/project';

/**
 * Versions of the Compose montage: save the current one under a name, see
 * which ones exist (with their length and what they hold) and load an older
 * one back into Compose — e.g. a cut that was never exported to YouTube but
 * is worth a reel. Every action is written to disk before it reports success:
 * a version that only lived in memory was lost by leaving the page (29 Sep).
 */

interface Props {
  /** Persists the whole composition (incl. versions). Resolves false on failure. */
  onSave: () => Promise<boolean> | void;
  saving: boolean;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Length of a version's montage = end of its last video clip on v1. */
function versionLengthMs(v: Pick<ComposeVersion, 'clips'>): number {
  return v.clips.reduce((max, c) => (c.trackId === 'v1' ? Math.max(max, c.timelineEndMs) : max), 0);
}

/** Cuts + subtitles + style equal → the montage on screen IS this version. */
function sameAsVersion(v: ComposeVersion, s: { clips: unknown; subtitleSegments: unknown; subtitleStyle: unknown }): boolean {
  return JSON.stringify(v.clips) === JSON.stringify(s.clips)
    && JSON.stringify(v.subtitleSegments) === JSON.stringify(s.subtitleSegments)
    && JSON.stringify(v.subtitleStyle) === JSON.stringify(s.subtitleStyle);
}

export function ComposeVersionsMenu({ onSave, saving }: Props) {
  const versions = useComposeStore((s) => s.versions);
  const clips = useComposeStore((s) => s.clips);
  const subtitleSegments = useComposeStore((s) => s.subtitleSegments);
  const subtitleStyle = useComposeStore((s) => s.subtitleStyle);
  const saveVersion = useComposeStore((s) => s.saveVersion);
  const restoreVersion = useComposeStore((s) => s.restoreVersion);
  const deleteVersion = useComposeStore((s) => s.deleteVersion);
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Which saved version (if any) matches what's on screen right now.
  const currentMatchId = useMemo(
    () => versions.find((v) => sameAsVersion(v, { clips, subtitleSegments, subtitleStyle }))?.id ?? null,
    [versions, clips, subtitleSegments, subtitleStyle],
  );
  const currentLengthMs = versionLengthMs({ clips });

  // Close on outside click — checked against the WHOLE menu (button + list),
  // so clicking inside the list does not close it.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [open]);

  /** Save to disk and tell the user plainly whether it landed. */
  const persist = async (okTitle: string, okDescription: string): Promise<boolean> => {
    const ok = (await onSave()) !== false;
    if (ok) {
      toast({ title: okTitle, description: okDescription });
    } else {
      toast({
        title: 'NO se ha guardado en disco',
        description: 'El cambio sigue en pantalla. Pulsa Save (Ctrl+S) hasta que quede guardado antes de salir de Compose.',
        variant: 'destructive',
      });
    }
    return ok;
  };

  const handleSaveAsVersion = async () => {
    const label = window.prompt(
      'Nombre de la versión (guarda los cortes, subtítulos y estilo actuales; en Reels podrás detectar bits sobre ella):',
      `v${versions.length + 1}`,
    );
    if (!label || !label.trim()) return;
    setBusy('save');
    try {
      saveVersion(label.trim());
      await persist(
        `Versión «${label.trim()}» guardada en disco`,
        `${fmtDuration(currentLengthMs)} de montaje · ${clips.length} clips · ${subtitleSegments.length} subtítulos. Ahora hay ${versions.length + 1} versión(es).`,
      );
    } finally {
      setBusy(null);
    }
  };

  const handleLoad = async (v: ComposeVersion) => {
    if (v.id === currentMatchId) {
      toast({ title: `«${v.label}» ya es el montaje actual` });
      return;
    }
    // The montage on screen is not saved as any version: offer to keep it
    // before it gets replaced (undo would also bring it back, but only
    // until the page is left).
    if (currentMatchId === null && (clips.length > 0 || subtitleSegments.length > 0)) {
      const keep = window.confirm(
        `El montaje actual (${fmtDuration(currentLengthMs)}) no está guardado como versión.\n\n` +
        `Aceptar: guardarlo como versión antes de cargar «${v.label}».\n` +
        `Cancelar: cargar «${v.label}» sin guardarlo (se puede deshacer con Ctrl+Z mientras no salgas de Compose).`,
      );
      if (keep) {
        const label = window.prompt('Nombre para el montaje actual:', `v${versions.length + 1}`);
        if (!label || !label.trim()) return;
        saveVersion(label.trim());
      }
    } else if (!window.confirm(`¿Cargar «${v.label}» (${fmtDuration(versionLengthMs(v))}) en Compose?`)) {
      return;
    }
    setBusy(v.id);
    try {
      restoreVersion(v.id);
      setOpen(false);
      await persist(
        `«${v.label}» cargada en Compose`,
        'Guardada como montaje actual. Para hacer un reel con ella: Reels → detector de bits → «Compose (actual)» o «Versión: ' + v.label + '».',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (v: ComposeVersion) => {
    if (!window.confirm(`¿Borrar la versión «${v.label}»? Los reels creados desde ella conservan sus cortes.`)) return;
    setBusy(v.id);
    try {
      deleteVersion(v.id);
      await persist(`Versión «${v.label}» borrada`, `Quedan ${versions.length - 1} versión(es).`);
    } finally {
      setBusy(null);
    }
  };

  const disabled = saving || busy !== null;

  return (
    <div className="relative flex items-center" ref={wrapRef}>
      <Button
        variant="ghost" size="sm"
        className="h-7 w-7 p-0 text-emerald-400 hover:text-emerald-300"
        onClick={handleSaveAsVersion}
        disabled={disabled}
        title="Guardar el montaje actual como versión con nombre (se escribe en disco al momento)"
      >
        {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bookmark className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost" size="sm"
        className="h-7 px-1.5 text-[10px] gap-1"
        onClick={() => setOpen((o) => !o)}
        title="Versiones guardadas de este montaje: ver, cargar o borrar"
      >
        <History className="h-3.5 w-3.5" />
        <span>Versiones{versions.length > 0 ? ` · ${versions.length}` : ''}</span>
      </Button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded-md shadow-lg z-50 min-w-[340px] max-w-[420px]">
          <div className="px-3 py-2 border-b border-border text-[11px] text-muted-foreground">
            {versions.length === 0 ? (
              <>No hay versiones guardadas. El marcador <Bookmark className="inline h-3 w-3 text-emerald-400" /> guarda el montaje actual con un nombre.</>
            ) : currentMatchId ? (
              <>El montaje actual es la versión <span className="text-foreground font-medium">«{versions.find((v) => v.id === currentMatchId)?.label}»</span>.</>
            ) : (
              <>El montaje actual ({fmtDuration(currentLengthMs)}) no coincide con ninguna versión guardada.</>
            )}
          </div>

          {versions.length > 0 && (
            <div className="max-h-[320px] overflow-y-auto py-1">
              {[...versions].reverse().map((v) => {
                const isCurrent = v.id === currentMatchId;
                return (
                  <div
                    key={v.id}
                    className={`flex items-center gap-2 px-3 py-1.5 text-xs ${isCurrent ? 'bg-emerald-950/40' : 'hover:bg-muted'}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate flex items-center gap-1.5">
                        {isCurrent && <Check className="h-3 w-3 text-emerald-400 flex-shrink-0" />}
                        {v.label}
                        {isCurrent && <span className="text-[10px] text-emerald-400 font-normal">actual</span>}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {fmtDuration(versionLengthMs(v))} de montaje · {v.clips.length} clips · {v.subtitleSegments.length} subtítulos · {fmtDate(v.createdAt)}
                      </div>
                    </div>
                    <Button
                      variant="outline" size="sm"
                      className="h-6 px-2 text-[10px] gap-1"
                      onClick={(e) => { e.stopPropagation(); void handleLoad(v); }}
                      disabled={disabled || isCurrent}
                      title={isCurrent ? 'Ya es el montaje actual' : 'Cargar esta versión en Compose (sustituye el montaje actual)'}
                    >
                      {busy === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      Cargar
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className="h-6 w-6 p-0 text-red-400 hover:text-red-300"
                      onClick={(e) => { e.stopPropagation(); void handleDelete(v); }}
                      disabled={disabled}
                      title="Borrar esta versión"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="px-3 py-2 border-t border-border text-[10px] text-muted-foreground">
            Para un reel de una versión: Reels → detector de bits → «Versión: nombre». Cargar una versión aquí la convierte en el montaje actual.
          </div>
        </div>
      )}
    </div>
  );
}
