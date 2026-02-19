import { NextRequest, NextResponse } from 'next/server';
import { getSettings, saveSettings, maskKey } from '@/server/settings-manager';
import type { AppSettings } from '@/server/settings-manager';

/** GET: return settings with masked keys */
export async function GET() {
  const settings = await getSettings();

  // Mask keys for display — never send full keys to client
  const masked = {
    keys: {
      openai: settings.keys.openai ? maskKey(settings.keys.openai) : '',
      anthropic: settings.keys.anthropic ? maskKey(settings.keys.anthropic) : '',
      groq: settings.keys.groq ? maskKey(settings.keys.groq) : '',
      openrouter: settings.keys.openrouter ? maskKey(settings.keys.openrouter) : '',
      ollamaHost: settings.keys.ollamaHost || '',
      ollamaModel: settings.keys.ollamaModel || '',
    },
    openrouter: settings.openrouter,
    // Also report env vars presence so user knows what's already set
    envKeys: {
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      groq: !!process.env.GROQ_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
      ollama: !!process.env.OLLAMA_HOST,
    },
  };

  return NextResponse.json(masked);
}

/** PUT: update settings. Empty string = remove key. */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const current = await getSettings();

    const updated: AppSettings = {
      keys: { ...current.keys },
      openrouter: { ...current.openrouter },
    };

    // Update keys — only overwrite if the field is present in body
    // If value looks masked (contains "..."), skip it (user didn't change it)
    if (body.keys) {
      for (const [key, value] of Object.entries(body.keys)) {
        const v = value as string;
        if (v.includes('...')) continue; // masked value, skip
        const k = key as keyof AppSettings['keys'];
        if (v === '') {
          delete updated.keys[k];
        } else {
          updated.keys[k] = v;
        }
      }
    }

    if (body.openrouter?.model) {
      updated.openrouter.model = body.openrouter.model;
    }

    await saveSettings(updated);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
