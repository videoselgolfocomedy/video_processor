import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';
import { detectBitsOnly } from '@/server/workers/reinterpret-worker';
import type { LLMProvider } from '@/server/workers/reinterpret-worker';

/**
 * POST /api/projects/[id]/bits
 * Detect comedy bits from segments (no subtitle corrections).
 * Body: { segments, language, context?, provider, source: 'full' | 'compose' }
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

  // Get segments — optionally filter by compose clips
  let segments = project.transcription.segments;
  if (source === 'compose') {
    const composeClips = (project.composition?.clips ?? []).filter(
      (c: { trackId: string }) => c.trackId === 'v1'
    );
    if (composeClips.length > 0) {
      segments = segments.filter((seg) =>
        composeClips.some((clip: { sourceInMs: number; sourceOutMs: number }) =>
          seg.endMs > clip.sourceInMs && seg.startMs < clip.sourceOutMs
        )
      );
    }
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

        // Save bits to project
        await updateProject(id, { bits });

        controller.enqueue(
          encoder.encode(JSON.stringify({ type: 'done', bits }) + '\n')
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
