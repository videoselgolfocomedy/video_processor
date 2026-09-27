import { useEffect, useState } from 'react';

/**
 * Client-side cache of `/api/projects/[id]/audio/envelope` results (25 ms peak
 * envelopes) so every clip drawn from the same file shares ONE fetch. The
 * key carries `rev` (sync.audioRev): a re-mix rewrites the stems in place,
 * bumps the rev, and the next render fetches fresh data — the server side
 * already recomputes its JSON cache from the wav's mtime.
 */
export interface EnvelopeData {
  envelope: number[];
  hop_ms: number;
  duration_s: number;
}

const inflight = new Map<string, Promise<EnvelopeData | null>>();

export function fetchEnvelope(projectId: string, fileName: string, rev?: number | string): Promise<EnvelopeData | null> {
  const key = `${projectId}|${fileName}|${rev ?? ''}`;
  let p = inflight.get(key);
  if (!p) {
    p = fetch(`/api/projects/${projectId}/audio/envelope?name=${encodeURIComponent(fileName)}`)
      .then((r) => (r.ok ? (r.json() as Promise<EnvelopeData>) : null))
      .catch(() => null);
    inflight.set(key, p);
    // A failed fetch must not poison the cache for the session.
    void p.then((d) => { if (!d) inflight.delete(key); });
  }
  return p;
}

/** `undefined` while loading, `null` when the file has no envelope (e.g. an mp4). */
export function useEnvelope(projectId: string | undefined, fileName: string | undefined, rev?: number | string): EnvelopeData | null | undefined {
  const [data, setData] = useState<EnvelopeData | null | undefined>(undefined);
  useEffect(() => {
    if (!projectId || !fileName) { setData(null); return; }
    let dead = false;
    setData(undefined);
    void fetchEnvelope(projectId, fileName, rev).then((d) => { if (!dead) setData(d); });
    return () => { dead = true; };
  }, [projectId, fileName, rev]);
  return data;
}
