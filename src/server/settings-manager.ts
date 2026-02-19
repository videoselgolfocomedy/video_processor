import fs from 'fs/promises';
import path from 'path';

const SETTINGS_PATH = path.join(process.cwd(), 'data', 'settings.json');

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
}

const defaults: AppSettings = {
  keys: {},
  openrouter: {
    model: 'anthropic/claude-haiku-4-5',
  },
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
