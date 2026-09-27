'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'subtitle-recent-colors';
const MAX = 8;

/**
 * Remembers the last colors the user applied to subtitles, persisted in
 * localStorage and shared across compose + reels. Returns the list (most
 * recent first) and a `pushColor` to record a newly-used color.
 */
export function useRecentColors() {
  const [colors, setColors] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      // Collapse the near-duplicates older versions stored (one per drag step).
      if (raw) setColors(dedupe(JSON.parse(raw)));
    } catch { /* ignore */ }
  }, []);

  const pushColor = useCallback((hex: string) => {
    if (!hex) return;
    const norm = hex.toLowerCase();
    setColors((prev) => {
      const next = dedupe([norm, ...prev]).slice(0, MAX);
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { recentColors: colors, pushColor };
}

/** Two colours closer than this (RGB distance) count as the same swatch. */
const NEAR = 24;
function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Keep the first of every group of near-identical colours (order = recency). */
function dedupe(list: string[]): string[] {
  const out: string[] = [];
  for (const c of list) {
    const a = rgb(c);
    if (!a) continue;
    if (out.some((o) => {
      const b = rgb(o)!;
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < NEAR;
    })) continue;
    out.push(c.toLowerCase());
  }
  return out;
}
