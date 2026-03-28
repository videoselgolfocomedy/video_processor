import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';
import { detectBitsOnly, detectProviders } from '@/server/workers/reinterpret-worker';
import type { LLMProvider } from '@/server/workers/reinterpret-worker';

/**
 * GET /api/projects/[id]/bits
 * Returns available LLM providers for bit detection.
 */
export async function GET() {
  const providers = await detectProviders();
  // Prefer providers with large context windows for bit detection
  const preferred = ['openrouter', 'groq', 'anthropic', 'openai', 'ollama'];
  const sorted = preferred
    .map((id) => providers.find((p) => p.id === id))
    .filter(Boolean);
  return NextResponse.json({ providers: sorted });
}

/**
 * POST /api/projects/[id]/bits
 * Detect comedy bits from segments (no subtitle corrections).
 * Body: { language, context?, provider, source: 'full' | 'compose' }
 * Returns streaming ndjson with progress + final bits.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();
  const { language, context, provider, source } = body as {
    language: string;
    context?: string;
    provider: string;
    source: 'full' | 'compose';
  };

  // Get compose v1 clips sorted by timeline position
  const composeClips = (project.composition?.clips ?? [])
    .filter((c: { trackId: string }) => c.trackId === 'v1')
    .sort((a: { timelineStartMs: number }, b: { timelineStartMs: number }) => a.timelineStartMs - b.timelineStartMs);

  // Get segments — transcription.segments are already in compose timeline time
  // (compose saves them back in compose time domain after editing)
  let segments = project.transcription.segments;
  if (source === 'compose' && composeClips.length > 0) {
    // Segments are already in compose time — just filter out any that fall outside compose clips
    const maxCompose = Math.max(...composeClips.map((c: { timelineEndMs: number }) => c.timelineEndMs));
    segments = segments.filter((seg) => seg.endMs > 0 && seg.startMs < maxCompose);
  }

  if (segments.length === 0) {
    return NextResponse.json({ error: 'No segments found' }, { status: 400 });
  }

  // Stream progress
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const bits = await detectBitsOnly({
          segments,
          language: language || project.transcription.language || 'es',
          context,
          provider: provider as LLMProvider,
          onProgress: async (message: string) => {
            controller.enqueue(
              encoder.encode(JSON.stringify({ type: 'progress', message }) + '\n')
            );
          },
        });

        // When bits are from compose, add sourceStartMs/sourceEndMs so reels can
        // seek to the correct position in the muxed video
        const enrichedBits = (source === 'compose' && composeClips.length > 0)
          ? bits.map((bit) => {
              // Reverse map: compose time → source time
              let srcStart = bit.startMs;
              let srcEnd = bit.endMs;
              for (const clip of composeClips as Array<{ timelineStartMs: number; timelineEndMs: number; sourceInMs: number; sourceOutMs: number }>) {
                if (bit.startMs >= clip.timelineStartMs && bit.startMs <= clip.timelineEndMs) {
                  srcStart = clip.sourceInMs + (bit.startMs - clip.timelineStartMs);
                }
                if (bit.endMs >= clip.timelineStartMs && bit.endMs <= clip.timelineEndMs) {
                  srcEnd = clip.sourceInMs + (bit.endMs - clip.timelineStartMs);
                }
              }
              return { ...bit, sourceStartMs: srcStart, sourceEndMs: srcEnd };
            })
          : bits;

        // Save bits to project
        await updateProject(id, { bits: enrichedBits });

        controller.enqueue(
          encoder.encode(JSON.stringify({ type: 'done', bits: enrichedBits }) + '\n')
        );
      } catch (err) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: 'error', error: (err as Error).message }) + '\n')
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  });
}
