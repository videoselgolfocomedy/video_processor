'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import type { JobEvent } from '@/types/jobs';

interface UseSSEOptions {
  jobId: string | null;
  onProgress?: (progress: number, message: string) => void;
  onComplete?: (result?: Record<string, unknown>) => void;
  onError?: (error: string) => void;
}

const MAX_RECONNECTS = 5;

export function useSSE({ jobId, onProgress, onComplete, onError }: UseSSEOptions) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectCountRef = useRef(0);
  const lastEventTimeRef = useRef(0);
  const [connected, setConnected] = useState(false);

  const connect = useCallback(() => {
    if (!jobId) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/jobs/${jobId}/sse`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
      // Reset reconnect count on successful connection that receives data
    };

    es.onmessage = (event) => {
      reconnectCountRef.current = 0; // Got data, reset counter
      lastEventTimeRef.current = Date.now();

      try {
        const data: JobEvent = JSON.parse(event.data);

        switch (data.type) {
          case 'progress':
            onProgress?.(data.progress || 0, data.message || '');
            break;
          case 'complete':
            onComplete?.(data.result);
            es.close();
            setConnected(false);
            break;
          case 'error':
            onError?.(data.error || 'Unknown error');
            es.close();
            setConnected(false);
            break;
          case 'cancelled':
            onError?.('Job cancelled');
            es.close();
            setConnected(false);
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
      setConnected(false);

      reconnectCountRef.current += 1;

      if (reconnectCountRef.current >= MAX_RECONNECTS) {
        onError?.('Conexión perdida con el servidor. El job puede haber fallado.');
        eventSourceRef.current = null;
        return;
      }

      // Reconnect with backoff
      const delay = Math.min(3000 * reconnectCountRef.current, 15000);
      setTimeout(() => {
        if (eventSourceRef.current === es || eventSourceRef.current === null) {
          connect();
        }
      }, delay);
    };
  }, [jobId, onProgress, onComplete, onError]);

  useEffect(() => {
    reconnectCountRef.current = 0;
    connect();
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [connect]);

  const disconnect = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setConnected(false);
  }, []);

  return { connected, disconnect };
}
