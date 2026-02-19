'use client';

import { useEffect, useCallback } from 'react';

interface ShortcutMap {
  [key: string]: () => void;
}

export function useKeyboardShortcuts(shortcuts: ShortcutMap) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }

      const key = buildKeyString(e);
      const handler = shortcuts[key];
      if (handler) {
        e.preventDefault();
        handler();
      }
    },
    [shortcuts]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

// Common shortcut presets
export function usePlaybackShortcuts(callbacks: {
  onPlayPause?: () => void;
  onSeekBack?: () => void;
  onSeekForward?: () => void;
  onSave?: () => void;
  onExport?: () => void;
}) {
  useKeyboardShortcuts({
    ' ': () => callbacks.onPlayPause?.(),
    j: () => callbacks.onSeekBack?.(),
    l: () => callbacks.onSeekForward?.(),
    arrowleft: () => callbacks.onSeekBack?.(),
    arrowright: () => callbacks.onSeekForward?.(),
    'mod+s': () => callbacks.onSave?.(),
    'mod+e': () => callbacks.onExport?.(),
  });
}
