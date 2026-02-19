import { NextRequest, NextResponse } from 'next/server';
import { reinterpretSubtitles, detectProviders } from '@/server/workers/reinterpret-worker';
import type { LLMProvider } from '@/server/workers/reinterpret-worker';
import type { SubtitleSegment } from '@/types/project';

/** GET: return available providers for the UI */
export async function GET() {
  const providers = (await detectProviders()).map((p) => ({
    id: p.id,
    label: p.label,
    available: p.available,
    model: p.model,
    note: p.id === 'groq' && p.available
      ? 'Free tier: 12k TPM. Lento con muchos segmentos.'
      : p.id === 'openrouter' && p.available
        ? `Modelo: ${p.model}`
        : undefined,
  }));

  return NextResponse.json({ providers });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await params;

  try {
    const body = await request.json();
    const { segments, language, context, provider } = body as {
      segments: SubtitleSegment[];
      language: string;
      context?: string;
      provider?: LLMProvider;
    };

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      return NextResponse.json(
        { error: 'No segments provided' },
        { status: 400 }
      );
    }

    const providers = await detectProviders();
    const chosen = provider
      ? providers.find((p) => p.id === provider && p.available)
      : providers.find((p) => p.available);

    if (!chosen) {
      return NextResponse.json(
        {
          error: 'Ningún proveedor de IA configurado. Ve a Config para añadir una API key.',
        },
        { status: 500 }
      );
    }

    // Stream progress via ndjson
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    // Serialized writer: queue writes to avoid concurrent write() calls
    let writeChain = Promise.resolve();
    const send = (data: Record<string, unknown>) => {
      writeChain = writeChain.then(() =>
        writer.write(encoder.encode(JSON.stringify(data) + '\n'))
      );
      return writeChain;
    };

    // Run reinterpretation in background, writing progress to stream
    (async () => {
      try {
        const corrected = await reinterpretSubtitles({
          segments,
          language: language || 'auto',
          context,
          provider: chosen.id,
          onProgress: async (batch, total, message) => {
            await send({ type: 'progress', batch, total, message });
          },
        });

        await send({
          type: 'done',
          segments: corrected,
          provider: chosen.id,
          model: chosen.model,
        });
      } catch (err) {
        await send({ type: 'error', error: (err as Error).message });
      } finally {
        await writeChain;
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
