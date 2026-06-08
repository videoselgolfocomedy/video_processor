'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useReelStore } from '@/stores/reel-store';
import {
  useOverlayTemplates,
  buildTemplateItems,
  applyTemplate,
  isOverlayClip,
} from '@/lib/overlay-templates';
import type { CompositionClip, OverlayTemplate } from '@/types/project';
import { BookmarkPlus, Layers, Library, Trash, Type, Image as ImageIcon, Loader2 } from 'lucide-react';

/* ───────────────── Reel-level hub: save set + apply ────────────────── */

export function OverlayTemplatesBar({ reelId }: { reelId: string }) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const currentTimeMs = useReelStore((s) => s.currentTimeMs);
  const addTrack = useReelStore((s) => s.addTrack);
  const addClip = useReelStore((s) => s.addClip);

  const { templates, saveTemplate, deleteTemplate } = useOverlayTemplates();
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (!reel || !projectId) return null;

  const overlayCount = reel.composition.clips.filter(isOverlayClip).length;

  const handleSaveSet = async () => {
    const overlays = reel.composition.clips.filter(isOverlayClip);
    if (overlays.length === 0) {
      window.alert('Este reel no tiene overlays (texto o imágenes) para guardar.');
      return;
    }
    const name = window.prompt(
      `Nombre de la plantilla (${overlays.length} overlay${overlays.length === 1 ? '' : 's'}):`,
      reel.name || 'Mis overlays'
    );
    if (!name?.trim()) return;
    setBusy('save');
    try {
      const items = await buildTemplateItems(overlays, projectId);
      if (items.length === 0) {
        window.alert('No se pudo guardar (fallo copiando imágenes).');
        return;
      }
      await saveTemplate(name.trim(), 'set', items);
    } finally {
      setBusy(null);
    }
  };

  const handleApply = async (tpl: OverlayTemplate) => {
    setBusy(tpl.id);
    try {
      const fresh = useReelStore.getState().reels.find((r) => r.id === reelId);
      if (!fresh) return;
      const n = await applyTemplate(tpl, {
        reelId,
        projectId,
        playheadMs: currentTimeMs,
        reelClips: fresh.composition.clips,
        reelTracks: fresh.composition.tracks,
        addTrack,
        addClip,
      });
      if (n === 0) window.alert('No se insertó ningún overlay (revisa que las imágenes existan).');
      else setShowPicker(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/10">
      <span className="text-[10px] text-muted-foreground mr-1">Overlays:</span>
      <button
        type="button"
        onClick={handleSaveSet}
        disabled={busy === 'save'}
        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded disabled:opacity-50"
        title="Guardar todos los overlays de este reel como una plantilla reutilizable"
      >
        {busy === 'save' ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Layers className="h-2.5 w-2.5" />}
        Guardar reel{overlayCount > 0 ? ` (${overlayCount})` : ''}
      </button>
      <button
        type="button"
        onClick={() => setShowPicker((v) => !v)}
        className={`relative flex items-center gap-1 px-1.5 py-0.5 text-[10px] border rounded ${
          showPicker
            ? 'border-orange-400/60 text-orange-300 bg-orange-500/10'
            : 'border-border text-muted-foreground hover:text-foreground'
        }`}
        title="Aplicar una plantilla de overlays en el playhead"
      >
        <Library className="h-2.5 w-2.5" />
        Plantillas{templates.length > 0 && <span className="opacity-70"> ({templates.length})</span>}
      </button>

      {showPicker && (
        <div className="absolute z-50 mt-1 top-full left-0 w-72 max-h-72 overflow-y-auto rounded border border-border bg-popover shadow-lg p-2 space-y-1">
          {templates.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-3">
              Sin plantillas. Pulsa &ldquo;Guardar reel&rdquo; para crear una con los overlays de este reel.
            </p>
          ) : (
            templates.map((tpl) => (
              <OverlayTemplateRow
                key={tpl.id}
                tpl={tpl}
                busy={busy === tpl.id}
                onApply={() => handleApply(tpl)}
                onDelete={() => {
                  if (window.confirm(`¿Borrar plantilla "${tpl.name}"?`)) deleteTemplate(tpl.id);
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function OverlayTemplateRow({
  tpl,
  busy,
  onApply,
  onDelete,
}: {
  tpl: OverlayTemplate;
  busy: boolean;
  onApply: () => void;
  onDelete: () => void;
}) {
  const textCount = tpl.items.filter((i) => i.trackKind === 'text').length;
  const imgCount = tpl.items.filter((i) => i.trackKind === 'image').length;
  const firstImg = tpl.items.find((i) => i.imageAssetId);

  return (
    <div className="group flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted/40">
      <div className="h-8 w-8 flex-shrink-0 rounded bg-black/40 overflow-hidden flex items-center justify-center">
        {firstImg?.imageAssetId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/settings/overlay-templates/asset?id=${encodeURIComponent(firstImg.imageAssetId)}`}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <Type className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </div>
      <button type="button" onClick={onApply} disabled={busy} className="flex-1 min-w-0 text-left disabled:opacity-50">
        <div className="text-[11px] truncate font-medium flex items-center gap-1">
          {busy && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {tpl.name}
        </div>
        <div className="text-[9px] text-muted-foreground flex items-center gap-2">
          <span className="uppercase tracking-wide">{tpl.kind === 'set' ? 'Set' : 'Single'}</span>
          {textCount > 0 && (
            <span className="flex items-center gap-0.5"><Type className="h-2 w-2" />{textCount}</span>
          )}
          {imgCount > 0 && (
            <span className="flex items-center gap-0.5"><ImageIcon className="h-2 w-2" />{imgCount}</span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100"
        title="Borrar plantilla"
      >
        <Trash className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

/* ────────── Per-clip "save as single template" button ─────────── */

export function SaveOverlayAsTemplateButton({ clip }: { clip: CompositionClip }) {
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const { saveTemplate } = useOverlayTemplates();
  const [busy, setBusy] = useState(false);

  if (!projectId) return null;

  const handleSave = async () => {
    const defaultName =
      clip.type === 'text'
        ? (clip.textContent ?? '').slice(0, 32).trim() || 'Texto'
        : clip.originalName || 'Imagen';
    const name = window.prompt('Nombre de la plantilla:', defaultName);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const items = await buildTemplateItems([clip], projectId);
      if (items.length === 0) {
        window.alert('No se pudo guardar (fallo copiando la imagen).');
        return;
      }
      await saveTemplate(name.trim(), 'single', items);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleSave}
      disabled={busy}
      className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded disabled:opacity-50"
      title="Guardar este overlay como plantilla (global, reutilizable en otros reels y proyectos)"
    >
      {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <BookmarkPlus className="h-2.5 w-2.5" />}
      Plantilla
    </button>
  );
}
