'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useReelStore } from '@/stores/reel-store';
import {
  useOverlayTemplates,
  buildTemplateItems,
  applyTemplate,
  isOverlayClip,
  reelTimelineDurationMs,
} from '@/lib/overlay-templates';
import type { CompositionClip, OverlayTemplate } from '@/types/project';
import { BookmarkPlus, Layers, Library, Trash, Type, Image as ImageIcon, Loader2, AlignHorizontalSpaceBetween } from 'lucide-react';

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
  // Anchored mode: items from the first half of the SOURCE reel land at the
  // start of THIS reel; items from the second half land at its end. Toggled
  // by the checkbox in the picker; the per-row anchor button forces it on.
  const [anchorMode, setAnchorMode] = useState(false);

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
      await saveTemplate(name.trim(), 'set', items, {
        sourceDurationMs: reelTimelineDurationMs(reel.composition.clips),
        sourceFirstStartMs: Math.min(...overlays.map((c) => c.timelineStartMs)),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleApply = async (tpl: OverlayTemplate, anchored: boolean) => {
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
        anchorEnds: anchored,
        targetDurationMs: reelTimelineDurationMs(fresh.composition.clips),
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
          <label
            className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] text-muted-foreground cursor-pointer select-none border-b border-border/60 mb-1"
            title="Lo que estaba al principio del reel original se coloca al principio de este reel; lo que estaba al final, al final de este reel. Sin marcar: la plantilla entera se inserta en el playhead."
          >
            <input
              type="checkbox"
              checked={anchorMode}
              onChange={(e) => setAnchorMode(e.target.checked)}
              className="h-3 w-3 accent-primary"
            />
            <AlignHorizontalSpaceBetween className="h-2.5 w-2.5" />
            Anclar a inicio/fin del reel
          </label>
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
                onApply={() => handleApply(tpl, anchorMode)}
                onApplyAnchored={() => handleApply(tpl, true)}
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
  onApplyAnchored,
  onDelete,
}: {
  tpl: OverlayTemplate;
  busy: boolean;
  onApply: () => void;
  onApplyAnchored: () => void;
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
        onClick={onApplyAnchored}
        disabled={busy}
        className="p-1 text-muted-foreground hover:text-orange-300 disabled:opacity-50"
        title="Aplicar anclado: lo del inicio del reel original va al inicio de este reel, lo del final va al final"
      >
        <AlignHorizontalSpaceBetween className="h-3 w-3" />
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

/* ───── Per-clip "apply template to THIS overlay" dropdown ────── */

/**
 * Applies a saved text template's content + style + position to an already-
 * selected text overlay clip (vs the bar's "apply" which inserts new clips at
 * the playhead). Uses the first text item of the chosen template. Only shown
 * for text clips.
 */
export function ApplyOverlayTemplateButton({ reelId, clip }: { reelId: string; clip: CompositionClip }) {
  const { templates } = useOverlayTemplates();
  const updateClip = useReelStore((s) => s.updateClip);
  const [open, setOpen] = useState(false);

  if (clip.type !== 'text') return null;

  const textTemplates = templates.filter((t) => t.items.some((i) => i.trackKind === 'text'));

  const apply = (tpl: OverlayTemplate) => {
    const item = tpl.items.find((i) => i.trackKind === 'text');
    if (!item) return;
    updateClip(reelId, clip.id, {
      // Keep the clip's own text content unless the template carries one; most
      // of the time the user wants the template's STYLE, so apply style+position
      // and only adopt the template text if the clip is currently empty.
      textContent: (clip.textContent ?? '').trim() ? clip.textContent : (item.textContent ?? ''),
      textStyle: item.textStyle,
      overlayPosition: item.overlayPosition ?? clip.overlayPosition,
    });
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded"
        title="Aplicar el estilo de una plantilla a este overlay"
      >
        <Library className="h-2.5 w-2.5" />
        Aplicar
      </button>
      {open && (
        <div className="absolute z-50 mt-1 top-full right-0 w-60 max-h-64 overflow-y-auto rounded border border-border bg-popover shadow-lg p-2 space-y-1">
          {textTemplates.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-3">Sin plantillas de texto.</p>
          ) : (
            textTemplates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => apply(tpl)}
                className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted/40 text-left"
              >
                <Type className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                <span className="text-[11px] truncate">{tpl.name}</span>
              </button>
            ))
          )}
        </div>
      )}
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
      // Record the source reel's span so this single overlay can be applied
      // anchored (e.g. a closing card keeps its distance from the reel end).
      const owner = useReelStore.getState().reels.find((r) =>
        r.composition.clips.some((c) => c.id === clip.id)
      );
      await saveTemplate(name.trim(), 'single', items, owner ? {
        sourceDurationMs: reelTimelineDurationMs(owner.composition.clips),
        sourceFirstStartMs: clip.timelineStartMs,
      } : undefined);
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
