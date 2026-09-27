'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

const MIN_PCT = 20;
const MAX_PCT = 80;

/**
 * The two halves of an editing screen (Compose, the reel timeline phase):
 * `top` = subtitles | preview | properties, `bottom` = the whole timeline.
 * A thin bar between them can be dragged to trade space (double-click resets
 * to 50 %); the ratio persists per `storageKey` in localStorage so each
 * editor remembers the user's preference.
 */
export function EditorSplit({
  storageKey,
  defaultTopPct = 50,
  top,
  bottom,
}: {
  storageKey: string;
  defaultTopPct?: number;
  top: ReactNode;
  bottom: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [topPct, setTopPct] = useState(defaultTopPct);
  const latest = useRef(defaultTopPct);
  latest.current = topPct;

  // Read the stored ratio after mount (not in the initializer) so the server
  // and client render the same first frame.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(storageKey);
      const n = v == null ? NaN : parseFloat(v);
      if (Number.isFinite(n) && n >= MIN_PCT && n <= MAX_PCT) setTopPct(n);
    } catch { /* storage unavailable */ }
  }, [storageKey]);

  const persist = useCallback((pct: number) => {
    try { window.localStorage.setItem(storageKey, String(Math.round(pct * 10) / 10)); } catch { /* ignore */ }
  }, [storageKey]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const root = rootRef.current;
    if (!root || e.button !== 0) return;
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      if (rect.height <= 0) return;
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setTopPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persist(latest.current);
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [persist]);

  const reset = useCallback(() => {
    setTopPct(defaultTopPct);
    persist(defaultTopPct);
  }, [defaultTopPct, persist]);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-1 flex-col">
      <div className="min-h-0 overflow-hidden" style={{ height: `${topPct}%` }}>
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(topPct)}
        aria-valuemin={MIN_PCT}
        aria-valuemax={MAX_PCT}
        title="Arrastra para repartir el espacio (doble clic: mitad y mitad)"
        className="group relative h-1.5 flex-shrink-0 cursor-row-resize bg-border hover:bg-primary/60"
        onPointerDown={onPointerDown}
        onDoubleClick={reset}
      >
        <div className="absolute left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2 rounded bg-muted-foreground/50 group-hover:bg-primary" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {bottom}
      </div>
    </div>
  );
}
