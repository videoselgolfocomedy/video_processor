'use client';

import { useState } from 'react';
import { useComposeStore } from '@/stores/compose-store';
import { useOverlayTemplates, buildTemplateItems } from '@/lib/overlay-templates';
import type { CompositionClip, OverlayTemplate, CompositionTrack } from '@/types/project';
import { BookmarkPlus, Library, Layers, Trash, Type, Loader2 } from 'lucide-react';

/**
 * Compose-side overlay-template controls. Shares the SAME global template
 * library as reels (useOverlayTemplates → settings.json), so a text overlay
 * saved in a reel shows up here and vice versa.
 *
 * Scope: TEXT overlays. Text overlays are fully self-contained (no image asset
 * to copy), so save/apply work project-independently. Image-overlay templates
 * applied here are skipped for now (they need the asset-import path generalised
 * to compose) — noted in the apply result.
 */

const isComposeTextOverlay = (c: CompositionClip) => c.type === 'text';

/* ───────────── Bar: save all text overlays as a set + apply ──────────── */

export function ComposeOverlayTemplatesBar() {
  const clips = useComposeStore((s) => s.clips);
  const tracks = useComposeStore((s) => s.tracks);
  const currentTimeMs = useComposeStore((s) => s.currentTimeMs);
  const addTrack = useComposeStore((s) => s.addTrack);
  const addClip = useComposeStore((s) => s.addClip);

  const { templates, saveTemplate, deleteTemplate } = useOverlayTemplates();
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const textOverlays = clips.filter(isComposeTextOverlay);

  const handleSaveSet = async () => {
    if (textOverlays.length === 0) {
      window.alert('No hay overlays de texto en el compose para guardar.');
      return;
    }
    const name = window.prompt(
      `Nombre de la plantilla (${textOverlays.length} overlay${textOverlays.length === 1 ? '' : 's'} de texto):`,
      'Mis overlays'
    );
    if (!name?.trim()) return;
    setBusy('save');
    try {
      // buildTemplateItems is generic for text (no project asset needed).
      const items = await buildTemplateItems(textOverlays, 'compose');
      if (items.length === 0) {
        window.alert('No se pudo construir la plantilla.');
        return;
      }
      await saveTemplate(name.trim(), 'set', items);
    } finally {
      setBusy(null);
    }
  };

  const handleApply = (tpl: OverlayTemplate) => {
    setBusy(tpl.id);
    try {
      applyTextTemplateToCompose(tpl, {
        playheadMs: currentTimeMs,
        tracks,
        clips,
        addTrack,
        addClip,
      });
      const skipped = tpl.items.filter((i) => i.trackKind !== 'text').length;
      if (skipped > 0) {
        window.alert(`Aplicada. ${skipped} overlay(s) de imagen omitidos (de momento solo texto en compose).`);
      }
      setShowPicker(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={handleSaveSet}
        disabled={busy === 'save'}
        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded disabled:opacity-50"
        title="Guardar todos los overlays de texto del compose como plantilla reutilizable"
      >
        {busy === 'save' ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Layers className="h-2.5 w-2.5" />}
        Guardar overlays{textOverlays.length > 0 ? ` (${textOverlays.length})` : ''}
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowPicker((v) => !v)}
          className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] border rounded ${
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
          <div className="absolute z-50 mt-1 top-full right-0 w-72 max-h-72 overflow-y-auto rounded border border-border bg-popover shadow-lg p-2 space-y-1">
            {templates.length === 0 ? (
              <p className="text-[10px] text-muted-foreground text-center py-3">
                Sin plantillas. Guarda overlays de texto aquí o en reels.
              </p>
            ) : (
              templates.map((tpl) => {
                const textCount = tpl.items.filter((i) => i.trackKind === 'text').length;
                return (
                  <div key={tpl.id} className="group flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted/40">
                    <div className="h-7 w-7 flex-shrink-0 rounded bg-black/40 flex items-center justify-center">
                      <Type className="h-3 w-3 text-muted-foreground" />
                    </div>
                    <button
                      type="button"
                      onClick={() => handleApply(tpl)}
                      disabled={busy === tpl.id}
                      className="flex-1 min-w-0 text-left disabled:opacity-50"
                    >
                      <div className="text-[11px] truncate font-medium flex items-center gap-1">
                        {busy === tpl.id && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                        {tpl.name}
                      </div>
                      <div className="text-[9px] text-muted-foreground">
                        {tpl.kind === 'set' ? 'Set' : 'Single'} · {textCount} texto
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => { if (window.confirm(`¿Borrar plantilla "${tpl.name}"?`)) deleteTemplate(tpl.id); }}
                      className="p-1 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100"
                      title="Borrar plantilla"
                    >
                      <Trash className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────── Per-clip "save text overlay as template" button ─────────── */

export function ComposeSaveOverlayTemplateButton({ clip }: { clip: CompositionClip }) {
  const { saveTemplate } = useOverlayTemplates();
  const [busy, setBusy] = useState(false);

  if (clip.type !== 'text') return null;

  const handleSave = async () => {
    const defaultName = (clip.textContent ?? '').slice(0, 32).trim() || 'Texto';
    const name = window.prompt('Nombre de la plantilla:', defaultName);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const items = await buildTemplateItems([clip], 'compose');
      if (items.length === 0) { window.alert('No se pudo guardar.'); return; }
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
      title="Guardar este overlay de texto como plantilla (global, reutilizable en reels y otros proyectos)"
    >
      {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <BookmarkPlus className="h-2.5 w-2.5" />}
      Plantilla
    </button>
  );
}

/* ───── Per-clip "apply template to THIS overlay" (compose) ────── */

export function ComposeApplyOverlayTemplateButton({ clip }: { clip: CompositionClip }) {
  const { templates } = useOverlayTemplates();
  const updateClip = useComposeStore((s) => s.updateClip);
  const [open, setOpen] = useState(false);

  if (clip.type !== 'text') return null;

  const textTemplates = templates.filter((t) => t.items.some((i) => i.trackKind === 'text'));

  const apply = (tpl: OverlayTemplate) => {
    const item = tpl.items.find((i) => i.trackKind === 'text');
    if (!item) return;
    updateClip(clip.id, {
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

/* ───────────────────── compose text-template apply ─────────────────── */

function applyTextTemplateToCompose(
  template: OverlayTemplate,
  ctx: {
    playheadMs: number;
    tracks: CompositionTrack[];
    clips: CompositionClip[];
    addTrack: (type: CompositionTrack['type'], label: string) => string;
    addClip: (clip: Omit<CompositionClip, 'id'>) => string;
  }
): number {
  const { playheadMs, tracks, clips, addTrack, addClip } = ctx;
  const textItems = template.items.filter((i) => i.trackKind === 'text');
  if (textItems.length === 0) return 0;

  // Lane-pack onto text tracks so two overlays never collide on the same track.
  const lastEndOnTrack = (trackId: string): number => {
    const ends = clips.filter((c) => c.trackId === trackId).map((c) => c.timelineEndMs);
    return ends.length ? Math.max(...ends) : -Infinity;
  };
  const lanes = tracks
    .filter((t) => t.type === 'text')
    .map((t) => ({ trackId: t.id, endMs: lastEndOnTrack(t.id) }));

  const pickLane = (startMs: number): string => {
    const free = lanes.find((l) => l.endMs <= startMs);
    if (free) return free.trackId;
    const trackId = addTrack('text', 'Text Overlay');
    lanes.push({ trackId, endMs: -Infinity });
    return trackId;
  };

  const ordered = [...textItems].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  let inserted = 0;
  for (const item of ordered) {
    const startMs = Math.max(0, playheadMs + item.startOffsetMs);
    const endMs = startMs + Math.max(100, item.durationMs);
    const trackId = pickLane(startMs);
    addClip({
      type: 'text',
      fileName: '',
      originalName: 'Text',
      trackId,
      timelineStartMs: startMs,
      timelineEndMs: endMs,
      sourceInMs: 0,
      sourceOutMs: item.durationMs,
      textContent: item.textContent ?? '',
      textStyle: item.textStyle,
      overlayPosition: item.overlayPosition,
    });
    const lane = lanes.find((l) => l.trackId === trackId);
    if (lane) lane.endMs = endMs;
    inserted++;
  }
  return inserted;
}
