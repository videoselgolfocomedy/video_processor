import type { SubtitleSegment } from '@/types/project';
import {
  resolveKey,
  resolveOllamaHost,
  resolveOllamaModel,
  resolveOpenRouterModel,
} from '@/server/settings-manager';

export type LLMProvider = 'openrouter' | 'openai' | 'anthropic' | 'groq' | 'ollama';

const TAG = '[reinterpret]';

interface ProviderConfig {
  id: LLMProvider;
  label: string;
  available: boolean;
  model: string;
  batchSize: number;
  delayMs: number;
}

/** Detect available providers from settings + env vars */
export async function detectProviders(): Promise<ProviderConfig[]> {
  const [openrouterKey, openaiKey, anthropicKey, groqKey, ollamaHost, ollamaModel, openrouterModel] =
    await Promise.all([
      resolveKey('openrouter'),
      resolveKey('openai'),
      resolveKey('anthropic'),
      resolveKey('groq'),
      resolveOllamaHost(),
      resolveOllamaModel(),
      resolveOpenRouterModel(),
    ]);

  // Ollama is "available" if host is set to something other than default, or env var exists
  const ollamaConfigured = !!process.env.OLLAMA_HOST || !!process.env.OLLAMA_MODEL ||
    (ollamaHost !== 'http://localhost:11434');

  return [
    {
      id: 'openrouter',
      label: 'OpenRouter',
      available: !!openrouterKey,
      model: openrouterModel,
      batchSize: 9999,  // Send all at once - modern models handle 100K+ context
      delayMs: 0,
    },
    {
      id: 'openai',
      label: 'OpenAI (GPT-4o-mini)',
      available: !!openaiKey,
      model: 'gpt-4o-mini',
      batchSize: 9999,
      delayMs: 0,
    },
    {
      id: 'anthropic',
      label: 'Anthropic (Claude Haiku)',
      available: !!anthropicKey,
      model: 'claude-haiku-4-5-20251001',
      batchSize: 9999,
      delayMs: 0,
    },
    {
      id: 'ollama',
      label: `Ollama (${ollamaModel})`,
      available: ollamaConfigured,
      model: ollamaModel,
      batchSize: 50,    // Local models may have smaller context
      delayMs: 0,
    },
    {
      id: 'groq',
      label: 'Groq (llama-3.3-70b)',
      available: !!groqKey,
      model: 'llama-3.3-70b-versatile',
      batchSize: 9999,
      delayMs: 0,
    },
  ];
}

export interface ReinterpretOptions {
  segments: SubtitleSegment[];
  language: string;
  context?: string;
  provider: LLMProvider;
  onProgress?: (batch: number, total: number, message: string) => void | Promise<void>;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function buildPrompt(language: string, context?: string): string {
  return [
    `You are a subtitle correction assistant. Fix transcription errors in these subtitles.`,
    `Language: ${language === 'auto' ? 'detect from context' : language}.`,
    `Common errors: misspelled proper nouns, slang misheard by speech-to-text, context-dependent words, numbers, punctuation.`,
    context ? `Context: ${context}` : '',
    `Return ONLY a JSON array of objects with "id" and "text" fields.`,
    `Include ONLY the segments whose text you changed. Do NOT include unchanged segments.`,
    `If nothing needs correction, return an empty array [].`,
    `Do NOT add any explanation or text outside the JSON array.`,
  ].filter(Boolean).join(' ');
}

export async function reinterpretSubtitles(
  options: ReinterpretOptions
): Promise<SubtitleSegment[]> {
  const { segments, language, context, provider, onProgress } = options;
  const providers = await detectProviders();
  const config = providers.find((p) => p.id === provider);
  if (!config || !config.available) {
    throw new Error(`Proveedor "${provider}" no disponible. Configura la API key en Config.`);
  }

  console.log(`${TAG} Starting reinterpretation: ${segments.length} segments, provider=${config.id}, model=${config.model}, batchSize=${config.batchSize}`);

  const totalBatches = Math.ceil(segments.length / config.batchSize);
  const results: SubtitleSegment[] = [];

  for (let i = 0; i < segments.length; i += config.batchSize) {
    const batch = segments.slice(i, i + config.batchSize);
    const batchNum = Math.floor(i / config.batchSize) + 1;

    if (i > 0 && config.delayMs > 0) {
      console.log(`${TAG} [Batch ${batchNum}/${totalBatches}] Waiting ${config.delayMs}ms (rate limit delay)`);
      await onProgress?.(batchNum, totalBatches, `Esperando rate limit (${(config.delayMs / 1000).toFixed(0)}s)...`);
      await sleep(config.delayMs);
    }

    const label = totalBatches === 1
      ? `Enviando ${batch.length} segmentos al LLM...`
      : `Enviando batch ${batchNum}/${totalBatches} (${batch.length} segmentos)...`;
    await onProgress?.(batchNum, totalBatches, label);
    console.log(`${TAG} [Batch ${batchNum}/${totalBatches}] Sending ${batch.length} segments...`);
    const t0 = Date.now();
    const corrected = await callProvider(config, batch, language, context, batchNum, totalBatches);
    const elapsed = Date.now() - t0;
    console.log(`${TAG} [Batch ${batchNum}/${totalBatches}] Done in ${elapsed}ms, got ${corrected.length} segments back`);
    const doneLabel = totalBatches === 1
      ? `Análisis completado (${(elapsed / 1000).toFixed(1)}s)`
      : `Batch ${batchNum}/${totalBatches} completado (${(elapsed / 1000).toFixed(1)}s)`;
    await onProgress?.(batchNum, totalBatches, doneLabel);
    results.push(...corrected);
  }

  console.log(`${TAG} Reinterpretation complete: ${results.length} total segments returned`);
  return results;
}

async function callProvider(
  config: ProviderConfig,
  batch: SubtitleSegment[],
  language: string,
  context: string | undefined,
  batchNum: number,
  totalBatches: number,
  retries = 2
): Promise<SubtitleSegment[]> {
  const logPrefix = `${TAG} [Batch ${batchNum}/${totalBatches}]`;
  const segmentTexts = batch.map((s) => ({ id: s.id, text: s.text }));
  const systemPrompt = buildPrompt(language, context);
  const userContent = JSON.stringify(segmentTexts);

  console.log(`${logPrefix} Provider=${config.id} model=${config.model}`);
  console.log(`${logPrefix} System prompt length: ${systemPrompt.length} chars`);
  console.log(`${logPrefix} User content length: ${userContent.length} chars (${batch.length} segments)`);

  try {
    let responseText: string;

    switch (config.id) {
      case 'openrouter': {
        const key = await resolveKey('openrouter');
        responseText = await callOpenAICompat(
          'https://openrouter.ai/api/v1/chat/completions',
          key!,
          systemPrompt,
          userContent,
          config.model
        );
        break;
      }
      case 'openai': {
        const key = await resolveKey('openai');
        responseText = await callOpenAICompat(
          'https://api.openai.com/v1/chat/completions',
          key!,
          systemPrompt,
          userContent,
          config.model
        );
        break;
      }
      case 'anthropic': {
        const key = await resolveKey('anthropic');
        responseText = await callAnthropic(key!, systemPrompt, userContent, config.model);
        break;
      }
      case 'ollama': {
        const host = await resolveOllamaHost();
        responseText = await callOllama(host, systemPrompt, userContent, config.model);
        break;
      }
      case 'groq': {
        const key = await resolveKey('groq');
        responseText = await callOpenAICompat(
          'https://api.groq.com/openai/v1/chat/completions',
          key!,
          systemPrompt,
          userContent,
          config.model
        );
        break;
      }
      default:
        throw new Error(`Unknown provider: ${config.id}`);
    }

    console.log(`${logPrefix} Response length: ${responseText.length} chars`);
    if (!responseText.trim()) {
      console.error(`${logPrefix} EMPTY RESPONSE from ${config.id}/${config.model}`);
    } else {
      console.log(`${logPrefix} Response preview: ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);
    }

    return parseResponse(responseText, batch);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`${logPrefix} ERROR: ${msg}`);

    if (retries > 0 && msg.includes('429')) {
      const waitSec = (3 - retries) * 20;
      console.log(`${logPrefix} Rate limited (429), retrying in ${waitSec}s (${retries} retries left)`);
      await sleep(waitSec * 1000);
      return callProvider(config, batch, language, context, batchNum, totalBatches, retries - 1);
    }

    throw new Error(`[Batch ${batchNum}/${totalBatches}] ${msg}`);
  }
}

// ---- Provider implementations ----

// Models known to support response_format json_object
const JSON_MODE_SAFE = new Set([
  'gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo',
  'llama-3.3-70b-versatile', 'llama-3.1-70b-versatile',
]);

async function callOpenAICompat(
  url: string,
  apiKey: string,
  system: string,
  user: string,
  model: string
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  // Only use response_format for models known to support it.
  // OpenRouter routes to many models and most don't support it.
  const useJsonMode = JSON_MODE_SAFE.has(model);

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.3,
    max_tokens: 16384,
  };
  if (useJsonMode) {
    body.response_format = { type: 'json_object' };
  }

  console.log(`${TAG} callOpenAICompat: POST ${url} model=${model} jsonMode=${useJsonMode} bodySize=${JSON.stringify(body).length}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  console.log(`${TAG} callOpenAICompat: HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`${TAG} callOpenAICompat: Error body: ${errorText.substring(0, 500)}`);
    throw new Error(`API error (${res.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const finishReason = data.choices?.[0]?.finish_reason;
  const usage = data.usage;

  console.log(`${TAG} callOpenAICompat: finish_reason=${finishReason} content_length=${content.length} usage=${JSON.stringify(usage)}`);

  // Some providers wrap errors inside a successful response
  if (data.error) {
    console.error(`${TAG} callOpenAICompat: Wrapped error: ${JSON.stringify(data.error).substring(0, 300)}`);
    throw new Error(`API error: ${JSON.stringify(data.error).substring(0, 300)}`);
  }

  return content;
}

async function callAnthropic(
  apiKey: string,
  system: string,
  user: string,
  model: string
): Promise<string> {
  console.log(`${TAG} callAnthropic: POST model=${model} systemLen=${system.length} userLen=${user.length}`);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  console.log(`${TAG} callAnthropic: HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`${TAG} callAnthropic: Error body: ${errorText.substring(0, 500)}`);
    throw new Error(`Anthropic API error (${res.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');
  const content = textBlock?.text || '';
  const stopReason = data.stop_reason;
  const usage = data.usage;

  console.log(`${TAG} callAnthropic: stop_reason=${stopReason} content_length=${content.length} usage=${JSON.stringify(usage)}`);

  return content;
}

async function callOllama(
  host: string,
  system: string,
  user: string,
  model: string
): Promise<string> {
  console.log(`${TAG} callOllama: POST ${host}/api/chat model=${model} systemLen=${system.length} userLen=${user.length}`);

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      format: 'json',
    }),
  });

  console.log(`${TAG} callOllama: HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`${TAG} callOllama: Error body: ${errorText.substring(0, 500)}`);
    throw new Error(`Ollama error (${res.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await res.json();
  const content = data.message?.content || '';
  console.log(`${TAG} callOllama: content_length=${content.length} done=${data.done} eval_count=${data.eval_count}`);

  return content;
}

// ---- Helpers ----

/**
 * Extract JSON from LLM response text. Handles:
 * - Code fences: ```json ... ```
 * - Raw JSON array: [ ... ]
 * - Wrapped in object: { "segments": [ ... ] }
 * - Surrounding commentary text
 */
function extractJson(text: string): string {
  // 1. Try code fences first
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // 2. Try to find the outermost JSON array or object
  // Find the first [ or { and match it to its closing counterpart
  const trimmed = text.trim();
  const startChar = trimmed[0];
  if (startChar === '[' || startChar === '{') {
    // Response starts with JSON - find matching close bracket
    const closeChar = startChar === '[' ? ']' : '}';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === startChar) depth++;
      if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          return trimmed.substring(0, i + 1);
        }
      }
    }
  }

  // 3. Find first [ in the text (LLM added preamble text)
  const arrayStart = trimmed.indexOf('[');
  if (arrayStart >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = arrayStart; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '[') depth++;
      if (ch === ']') {
        depth--;
        if (depth === 0) {
          return trimmed.substring(arrayStart, i + 1);
        }
      }
    }
  }

  // 4. Fallback - return as-is and let JSON.parse report the error
  return trimmed;
}

function parseResponse(text: string, batch: SubtitleSegment[]): SubtitleSegment[] {
  if (!text.trim()) throw new Error('Empty response from LLM');

  const jsonStr = extractJson(text);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`JSON parse error: ${(e as Error).message}. First 400 chars: ${jsonStr.substring(0, 400)}`);
  }

  // Extract the array of {id, text} corrections
  let corrections: { id: string; text: string }[];
  if (Array.isArray(parsed)) {
    corrections = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const firstArray = Object.values(parsed).find(Array.isArray);
    if (!firstArray) {
      throw new Error(`LLM response is an object but contains no array. Keys: ${Object.keys(parsed as Record<string, unknown>).join(', ')}`);
    }
    corrections = firstArray as { id: string; text: string }[];
  } else {
    throw new Error(`Unexpected LLM response type: ${typeof parsed}`);
  }

  console.log(`${TAG} parseResponse: ${corrections.length} corrections for ${batch.length} batch segments`);

  if (corrections.length === 0) {
    // No corrections needed - return originals unchanged
    console.log(`${TAG} parseResponse: No corrections, returning originals`);
    return batch;
  }

  // Apply only the corrections, keep rest unchanged
  const correctionMap = new Map(corrections.map((c) => [c.id, c.text]));
  return batch.map((seg) => ({
    ...seg,
    text: correctionMap.get(seg.id) ?? seg.text,
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
