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
      if (raw) setColors(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  const pushColor = useCallback((hex: string) => {
    if (!hex) return;
    const norm = hex.toLowerCase();
    setColors((prev) => {
      const next = [norm, ...prev.filter((c) => c.toLowerCase() !== norm)].slice(0, MAX);
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { recentColors: colors, pushColor };
}
