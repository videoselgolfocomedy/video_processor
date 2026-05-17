'use client';

import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { CompositionClip } from '@/types/project';

const STORAGE_KEY = 'text-overlay-library-v1';
const CHANGE_EVENT = 'text-overlay-library-change';

/**
 * A saved text-overlay preset, persisted to localStorage and available across
 * projects/reels for the same browser/user. Useful for re-using titles, lower
 * thirds, or labels you've designed for one reel in other reels without
 * re-doing the styling.
 */
export interface TextOverlayPreset {
  id: string;
  name: string;
  createdAt: string;
  /** Preview text shown in the picker; the user can edit after inserting. */
  textContent: string;
  textStyle: NonNullable<CompositionClip['textStyle']>;
  overlayPosition: NonNullable<CompositionClip['overlayPosition']>;
}

export function getLibrary(): TextOverlayPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLibrary(presets: TextOverlayPreset[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    // localStorage's native `storage` event fires only in OTHER tabs.
    // We dispatch a custom event so the current tab's hooks re-read.
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // localStorage might be unavailable (private mode quota, etc) — ignore.
  }
}

export function addToLibrary(
  preset: Omit<TextOverlayPreset, 'id' | 'createdAt'>
): TextOverlayPreset {
  const presets = getLibrary();
  const newPreset: TextOverlayPreset = {
    ...preset,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
  };
  saveLibrary([newPreset, ...presets]);
  return newPreset;
}

export function removeFromLibrary(id: string): void {
  saveLibrary(getLibrary().filter((p) => p.id !== id));
}

export function renameLibraryPreset(id: string, name: string): void {
  saveLibrary(getLibrary().map((p) => (p.id === id ? { ...p, name } : p)));
}

/**
 * Reactive read of the saved library. Re-renders when the library changes in
 * the same tab (via our custom event) or in another tab (storage event).
 */
export function useTextOverlayLibrary(): TextOverlayPreset[] {
  const [presets, setPresets] = useState<TextOverlayPreset[]>(() => getLibrary());
  useEffect(() => {
    const handler = () => setPresets(getLibrary());
    window.addEventListener('storage', handler);
    window.addEventListener(CHANGE_EVENT, handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(CHANGE_EVENT, handler);
    };
  }, []);
  return presets;
}
