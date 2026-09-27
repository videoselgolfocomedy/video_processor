'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

/**
 * Exports a timeline audio clip's [sourceInMs, sourceOutMs] slice as a WAV and
 * triggers a browser download — so the user can edit it externally (Audacity,
 * etc.). Shared by the reels and compose clip-property panels.
 */
export function ExportAudioClipButton({
  projectId,
  fileName,
  sourceInMs,
  sourceOutMs,
  downloadName,
  className,
}: {
  projectId?: string;
  fileName?: string;
  sourceInMs: number;
  sourceOutMs: number;
  downloadName?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = !projectId || !fileName || sourceOutMs <= sourceInMs || busy;

  const handleExport = async () => {
    if (!projectId || !fileName) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/export-clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, sourceInMs, sourceOutMs, downloadName }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        throw new Error(msg.error || `Error ${res.status}`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const name = cd.match(/filename="(.+?)"/)?.[1] || `${downloadName || 'clip'}.wav`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={handleExport}
        disabled={disabled}
        className={
          className ??
          'flex w-full items-center justify-center gap-1.5 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-40 disabled:hover:text-muted-foreground'
        }
        title="Exporta este audio como WAV para editarlo por fuera (Audacity, etc.)"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
        {busy ? 'Exportando…' : 'Exportar WAV'}
      </button>
      {error && <p className="text-[9px] text-red-400 leading-tight">{error}</p>}
    </div>
  );
}
