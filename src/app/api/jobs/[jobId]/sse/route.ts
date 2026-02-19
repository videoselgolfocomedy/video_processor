import { NextRequest } from 'next/server';
import { jobManager } from '@/server/job-manager';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = jobManager.getJob(jobId);

  if (!job) {
    return new Response('Job not found', { status: 404 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

      function cleanup() {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }

      function send(data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          cleanup();
        }
      }

      // Send current state
      send({
        type: job.status === 'done' ? 'complete' : job.status === 'error' ? 'error' : 'progress',
        jobId: job.id,
        progress: job.progress,
        message: job.message,
        error: job.error,
        result: job.result,
      });

      // If already terminal, close
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        try { controller.close(); } catch { /* */ }
        return;
      }

      // Heartbeat every 15s to detect dead connections
      heartbeatInterval = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          cleanup();
        }
      }, 15000);

      // Subscribe to updates
      unsubscribe = jobManager.subscribe(jobId, (event) => {
        send(event);
        if (['complete', 'error', 'cancelled'].includes(event.type)) {
          cleanup();
          try { controller.close(); } catch { /* */ }
        }
      });
    },
    cancel() {
      // Called when client disconnects — handled by cleanup in start()
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
