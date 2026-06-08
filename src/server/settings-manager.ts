import fs from 'fs/promises';
import path from 'path';
import type { CustomStylePreset, OverlayTemplate } from '@/types/project';

const SETTINGS_PATH = path.join(process.cwd(), 'data', 'settings.json');

/**
 * Directory holding the binary assets (PNG/GIF) referenced by image overlay
 * templates. Lives next to settings.json under data/ so it's global (shared
 * across projects) and survives project deletion.
 */
export const OVERLAY_ASSETS_DIR = path.join(process.cwd(), 'data', 'overlay-templates', 'assets');

export async function ensureOverlayAssetsDir(): Promise<string> {
  await fs.mkdir(OVERLAY_ASSETS_DIR, { recursive: true });
  return OVERLAY_ASSETS_DIR;
}

export interface AppSettings {
  keys: {
    openai?: string;
    anthropic?: string;
    groq?: string;
    openrouter?: string;
    ollamaHost?: string;
    ollamaModel?: string;
  };
  openrouter: {
    model: string;
  };
  /**
   * Subtitle / text-overlay style presets the user saved as reusable across
   * the whole system. The UI promises "save and reuse in other reels and
   * projects", so these have to live OUTSIDE any individual project.json —
   * here in settings.json they survive project deletion, re-import, etc.
   */
  customStylePresets?: CustomStylePreset[];
  /**
   * Reusable overlay templates (text + image lines) saved from one reel and
   * applicable to any other reel/project. Global for the same reason as
   * customStylePresets — the UI promises cross-project reuse.
   */
  overlayTemplates?: OverlayTemplate[];
}

const defaults: AppSettings = {
  keys: {},
  openrouter: {
    model: 'anthropic/claude-haiku-4-5',
  },
  customStylePresets: [],
  overlayTemplates: [],
};

async function ensureDir() {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const stored = JSON.parse(data);
    // Merge with defaults so new fields are always present
    return {
      ...defaults,
      ...stored,
      keys: { ...defaults.keys, ...stored.keys },
      openrouter: { ...defaults.openrouter, ...stored.openrouter },
      customStylePresets: stored.customStylePresets ?? [],
      overlayTemplates: stored.overlayTemplates ?? [],
    };
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await ensureDir();
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/**
 * Resolve an API key: settings file first, then env var fallback.
 */
export async function resolveKey(provider: string): Promise<string | undefined> {
  const settings = await getSettings();
  switch (provider) {
    case 'openai':
      return settings.keys.openai || process.env.OPENAI_API_KEY;
    case 'anthropic':
      return settings.keys.anthropic || process.env.ANTHROPIC_API_KEY;
    case 'groq':
      return settings.keys.groq || process.env.GROQ_API_KEY;
    case 'openrouter':
      return settings.keys.openrouter || process.env.OPENROUTER_API_KEY;
    case 'ollama':
      return settings.keys.ollamaHost || process.env.OLLAMA_HOST || undefined;
    default:
      return undefined;
  }
}

export async function resolveOllamaHost(): Promise<string> {
  const settings = await getSettings();
  return settings.keys.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';
}

export async function resolveOllamaModel(): Promise<string> {
  const settings = await getSettings();
  return settings.keys.ollamaModel || process.env.OLLAMA_MODEL || 'llama3.1';
}

export async function resolveOpenRouterModel(): Promise<string> {
  const settings = await getSettings();
  return settings.openrouter.model || 'anthropic/claude-haiku-4-5';
}

/** Mask a key for display: show first 4 and last 4 chars */
export function maskKey(key: string): string {
  if (key.length <= 10) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
