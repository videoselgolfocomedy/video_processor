import type { SubtitleSegment, BitDefinition } from '@/types/project';
import { v4 as uuidv4 } from 'uuid';
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

export interface ReinterpretResult {
  segments: SubtitleSegment[];
  bits: BitDefinition[];
}

interface RawBit {
  label: string;
  summary: string;
  startSegmentId: string;
  endSegmentId: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function buildPrompt(language: string, context?: string, includeBits = false): string {
  const base = [
    `You are a subtitle correction assistant. Fix transcription errors in these subtitles.`,
    `Language: ${language === 'auto' ? 'detect from context' : language}.`,
    `Common errors: misspelled proper nouns, slang misheard by speech-to-text, context-dependent words, numbers, punctuation.`,
    context ? `Context: ${context}` : '',
  ].filter(Boolean);

  if (includeBits) {
    base.push(
      `Return ONLY a JSON object with two keys:`,
      `1. "corrections": array of {"id", "text"} for segments whose text you changed. Empty array if nothing changed.`,
      `2. "bits": array of {"label", "summary", "startSegmentId", "endSegmentId"} identifying distinct comedy bits/topics/routines in the content. Each bit should have a short descriptive label, a 1-2 sentence summary, and the IDs of the first and last segment that belong to it. If the content is not comedy or has no clear bits, return an empty array.`,
      `Do NOT add any explanation or text outside the JSON object.`,
    );
  } else {
    base.push(
      `Return ONLY a JSON array of objects with "id" and "text" fields.`,
      `Include ONLY the segments whose text you changed. Do NOT include unchanged segments.`,
      `If nothing needs correction, return an empty array [].`,
      `Do NOT add any explanation or text outside the JSON array.`,
    );
  }

  return base.join(' ');
}

export async function reinterpretSubtitles(
  options: ReinterpretOptions
): Promise<ReinterpretResult> {
  const { segments, language, context, provider, onProgress } = options;
  const providers = await detectProviders();
  const config = providers.find((p) => p.id === provider);
  if (!config || !config.available) {
    throw new Error(`Proveedor "${provider}" no disponible. Configura la API key en Config.`);
  }

  console.log(`${TAG} Starting reinterpretation: ${segments.length} segments, provider=${config.id}, model=${config.model}, batchSize=${config.batchSize}`);

  // Phase 1: Correct subtitles in batches (no bit detection per batch)
  const correctionBatches = Math.ceil(segments.length / config.batchSize);
  const results: SubtitleSegment[] = [];
  const totalSteps = correctionBatches + 1; // +1 for the dedicated bit detection pass

  for (let i = 0; i < segments.length; i += config.batchSize) {
    const batch = segments.slice(i, i + config.batchSize);
    const batchNum = Math.floor(i / config.batchSize) + 1;

    if (i > 0 && config.delayMs > 0) {
      console.log(`${TAG} [Batch ${batchNum}/${correctionBatches}] Waiting ${config.delayMs}ms (rate limit delay)`);
      await onProgress?.(batchNum, totalSteps, `Esperando rate limit (${(config.delayMs / 1000).toFixed(0)}s)...`);
      await sleep(config.delayMs);
    }

    const label = correctionBatches === 1
      ? `Corrigiendo ${batch.length} segmentos...`
      : `Corrigiendo batch ${batchNum}/${correctionBatches} (${batch.length} segmentos)...`;
    await onProgress?.(batchNum, totalSteps, label);
    console.log(`${TAG} [Batch ${batchNum}/${correctionBatches}] Sending ${batch.length} segments for correction...`);
    const t0 = Date.now();
    const { corrected } = await callProvider(config, batch, language, context, batchNum, correctionBatches, false);
    const elapsed = Date.now() - t0;
    console.log(`${TAG} [Batch ${batchNum}/${correctionBatches}] Done in ${elapsed}ms, got ${corrected.length} segments back`);
    const doneLabel = correctionBatches === 1
      ? `Corrección completada (${(elapsed / 1000).toFixed(1)}s)`
      : `Batch ${batchNum}/${correctionBatches} completado (${(elapsed / 1000).toFixed(1)}s)`;
    await onProgress?.(batchNum, totalSteps, doneLabel);
    results.push(...corrected);
  }

  // Phase 2: Dedicated bit detection pass — send ALL segments (condensed) in one call
  // This ensures the LLM sees all the content when identifying comedy bits.
  await onProgress?.(totalSteps, totalSteps, 'Detectando comedy bits...');
  console.log(`${TAG} [Bits] Starting dedicated bit detection with ALL ${segments.length} segments`);

  let rawBits: RawBit[] = [];
  try {
    // Condense segments to just id+text to fit in context window
    const condensed = segments.map((s) => ({ id: s.id, text: s.text }));
    const condensedJson = JSON.stringify(condensed);
    console.log(`${TAG} [Bits] Condensed payload: ${condensedJson.length} chars`);

    const bitsPrompt = buildPrompt(language, context, true);
    const t0 = Date.now();
    const { bits: detectedBits } = await callProvider(
      config,
      segments, // pass full segments for the correction merge
      language,
      context,
      1,
      1,
      true // includeBits
    );
    const elapsed = Date.now() - t0;
    console.log(`${TAG} [Bits] Done in ${elapsed}ms, detected ${detectedBits.length} bits`);
    rawBits = detectedBits;
  } catch (err) {
    console.error(`${TAG} [Bits] Bit detection failed (corrections are preserved):`, err);
  }

  const bits = resolveBits(rawBits, segments);
  console.log(`${TAG} Reinterpretation complete: ${results.length} total segments, ${bits.length} bits identified`);
  return { segments: results, bits };
}

async function callProvider(
  config: ProviderConfig,
  batch: SubtitleSegment[],
  language: string,
  context: string | undefined,
  batchNum: number,
  totalBatches: number,
  includeBits: boolean,
  retries = 2
): Promise<{ corrected: SubtitleSegment[]; bits: RawBit[] }> {
  const logPrefix = `${TAG} [Batch ${batchNum}/${totalBatches}]`;
  const segmentTexts = batch.map((s) => ({ id: s.id, text: s.text }));
  const systemPrompt = buildPrompt(language, context, includeBits);
  const userContent = JSON.stringify(segmentTexts);

  console.log(`${logPrefix} Provider=${config.id} model=${config.model} includeBits=${includeBits}`);
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

    return parseResponse(responseText, batch, includeBits);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`${logPrefix} ERROR: ${msg}`);

    if (retries > 0 && msg.includes('429')) {
      const waitSec = (3 - retries) * 20;
      console.log(`${logPrefix} Rate limited (429), retrying in ${waitSec}s (${retries} retries left)`);
      await sleep(waitSec * 1000);
      return callProvider(config, batch, language, context, batchNum, totalBatches, includeBits, retries - 1);
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

function parseResponse(
  text: string,
  batch: SubtitleSegment[],
  includeBits: boolean
): { corrected: SubtitleSegment[]; bits: RawBit[] } {
  if (!text.trim()) throw new Error('Empty response from LLM');

  const jsonStr = extractJson(text);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`JSON parse error: ${(e as Error).message}. First 400 chars: ${jsonStr.substring(0, 400)}`);
  }

  // Extract corrections and optional bits
  let corrections: { id: string; text: string }[];
  let bits: RawBit[] = [];

  if (Array.isArray(parsed)) {
    // Old format: just an array of corrections
    corrections = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;

    // New format: { corrections: [...], bits: [...] }
    if (Array.isArray(obj.corrections)) {
      corrections = obj.corrections as { id: string; text: string }[];
      if (Array.isArray(obj.bits)) {
        bits = (obj.bits as RawBit[]).filter(
          (b) => b.label && b.startSegmentId && b.endSegmentId
        );
        console.log(`${TAG} parseResponse: found ${bits.length} bits in response`);
      }
    } else {
      // Fallback: find first array in the object
      const firstArray = Object.values(obj).find(Array.isArray);
      if (!firstArray) {
        throw new Error(`LLM response is an object but contains no array. Keys: ${Object.keys(obj).join(', ')}`);
      }
      corrections = firstArray as { id: string; text: string }[];
    }
  } else {
    throw new Error(`Unexpected LLM response type: ${typeof parsed}`);
  }

  console.log(`${TAG} parseResponse: ${corrections.length} corrections for ${batch.length} batch segments, includeBits=${includeBits}`);

  let corrected: SubtitleSegment[];
  if (corrections.length === 0) {
    console.log(`${TAG} parseResponse: No corrections, returning originals`);
    corrected = batch;
  } else {
    const correctionMap = new Map(corrections.map((c) => [c.id, c.text]));
    corrected = batch.map((seg) => ({
      ...seg,
      text: correctionMap.get(seg.id) ?? seg.text,
    }));
  }

  return { corrected, bits };
}

function resolveBits(rawBits: RawBit[], allSegments: SubtitleSegment[]): BitDefinition[] {
  if (rawBits.length === 0) return [];

  const segMap = new Map(allSegments.map((s) => [s.id, s]));
  const resolved: BitDefinition[] = [];

  for (const raw of rawBits) {
    const startSeg = segMap.get(raw.startSegmentId);
    const endSeg = segMap.get(raw.endSegmentId);
    if (!startSeg || !endSeg) {
      console.log(`${TAG} resolveBits: skipping bit "${raw.label}" — invalid segment IDs (start=${raw.startSegmentId}, end=${raw.endSegmentId})`);
      continue;
    }
    resolved.push({
      id: uuidv4(),
      label: raw.label,
      summary: raw.summary || '',
      startMs: startSeg.startMs,
      endMs: endSeg.endMs,
    });
  }

  console.log(`${TAG} resolveBits: ${resolved.length}/${rawBits.length} bits resolved successfully`);
  return resolved;
}

/**
 * Detect comedy bits only (no subtitle corrections).
 * Sends all segments in a single call dedicated to bit detection.
 */
export async function detectBitsOnly(options: {
  segments: SubtitleSegment[];
  language: string;
  context?: string;
  provider: LLMProvider;
  onProgress?: (message: string) => void | Promise<void>;
}): Promise<BitDefinition[]> {
  const { segments, language, context, provider, onProgress } = options;
  const providers = await detectProviders();
  const config = providers.find((p) => p.id === provider);
  if (!config || !config.available) {
    throw new Error(`Proveedor "${provider}" no disponible.`);
  }

  console.log(`${TAG} detectBitsOnly: ${segments.length} segments, provider=${config.id}, model=${config.model}`);
  await onProgress?.('Enviando segmentos para detectar bits...');

  const t0 = Date.now();
  const { bits: rawBits } = await callProvider(config, segments, language, context, 1, 1, true);
  const elapsed = Date.now() - t0;
  console.log(`${TAG} detectBitsOnly: Done in ${elapsed}ms, detected ${rawBits.length} raw bits`);
  await onProgress?.(`${rawBits.length} bits detectados (${(elapsed / 1000).toFixed(1)}s)`);

  const bits = resolveBits(rawBits, segments);
  return bits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
