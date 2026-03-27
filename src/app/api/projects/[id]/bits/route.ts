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

  // Helper: map source time → compose timeline time
  function sourceToCompose(sourceMs: number): number | null {
    for (const clip of composeClips as Array<{ timelineStartMs: number; timelineEndMs: number; sourceInMs: number; sourceOutMs: number }>) {
      if (sourceMs >= clip.sourceInMs && sourceMs <= clip.sourceOutMs) {
        return clip.timelineStartMs + (sourceMs - clip.sourceInMs);
      }
    }
    return null; // Not in compose timeline
  }

  // Get segments — optionally filter and remap by compose clips
  let segments = project.transcription.segments;
  if (source === 'compose' && composeClips.length > 0) {
    // Filter to segments that overlap with compose clips, then remap times to compose timeline
    segments = segments
      .filter((seg) =>
        composeClips.some((clip: { sourceInMs: number; sourceOutMs: number }) =>
          seg.endMs > clip.sourceInMs && seg.startMs < clip.sourceOutMs
        )
      )
      .map((seg) => {
        const newStart = sourceToCompose(seg.startMs);
        const newEnd = sourceToCompose(seg.endMs);
        if (newStart === null || newEnd === null) return null;
        return { ...seg, startMs: newStart, endMs: newEnd };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
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
