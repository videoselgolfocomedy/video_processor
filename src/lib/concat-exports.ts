/** Shared shapes of the "join exports" feature (export page ⇄ API). */

/** A finished YouTube export of some project, as offered to the join picker. */
export interface ConcatCandidate {
  projectId: string;
  projectName: string;
  exportId: string;
  fileName: string;
  presetId: string;
  label?: string;
  completedAt?: string;
  sizeBytes: number;
  durationMs: number;
  width: number;
  height: number;
  /** Equal keys can be joined without re-encoding. */
  formatKey: string;
  formatText: string;
}

export interface ConcatCandidateGroup {
  projectId: string;
  projectName: string;
  exports: ConcatCandidate[];
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

export function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
