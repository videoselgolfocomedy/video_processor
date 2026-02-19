'use client';

import { useState, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { CheckCircle, XCircle, Loader2, Download, Trash2 } from 'lucide-react';
import { useSSE } from '@/hooks/use-sse';
import type { ExportRecord } from '@/types/project';
import { EXPORT_PRESETS } from '@/config/export-presets';

interface RenderQueueProps {
  exports: ExportRecord[];
  projectId: string;
  onRefresh: () => void;
}

function formatETA(seconds: number): string {
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.ceil(seconds % 60);
    return `~${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return `~${h}h ${m}m`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function ExportItem({
  record,
  projectId,
  onRefresh,
  onDelete,
}: {
  record: ExportRecord;
  projectId: string;
  onRefresh: () => void;
  onDelete: (id: string) => void;
}) {
  const preset = EXPORT_PRESETS.find((p) => p.id === record.presetId);
  const isActive = record.status === 'rendering';

  const [progress, setProgress] = useState(record.progress || 0);
  const [message, setMessage] = useState('');
  const startTimeRef = useRef(
    record.startedAt ? new Date(record.startedAt).getTime() : Date.now()
  );
  const [elapsed, setElapsed] = useState(0);
  const [eta, setEta] = useState<string | null>(null);

  const handleProgress = useCallback((pct: number, msg: string) => {
    setProgress(pct);
    setMessage(msg);

    const now = Date.now();
    const elapsedMs = now - startTimeRef.current;
    setElapsed(elapsedMs);

    if (pct > 2) {
      const totalEstMs = (elapsedMs / pct) * 100;
      const remainMs = totalEstMs - elapsedMs;
      setEta(formatETA(remainMs / 1000));
    }
  }, []);

  useSSE({
    jobId: isActive ? record.jobId || null : null,
    onProgress: handleProgress,
    onComplete: () => onRefresh(),
    onError: () => onRefresh(),
  });

  return (
    <div className="flex items-center gap-3 rounded-md bg-secondary p-3">
      <div className="flex-none">
        {record.status === 'done' && (
          <CheckCircle className="h-5 w-5 text-green-500" />
        )}
        {record.status === 'rendering' && (
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        )}
        {record.status === 'error' && (
          <XCircle className="h-5 w-5 text-destructive" />
        )}
        {record.status === 'queued' && (
          <div className="h-5 w-5 rounded-full border-2 border-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            {preset?.name || record.presetId}
          </p>
          {isActive && progress > 0 && (
            <span className="text-xs text-muted-foreground">
              {Math.round(progress)}%
            </span>
          )}
        </div>
        {isActive && progress > 0 && (
          <>
            <Progress value={progress} className="mt-1 h-1.5" />
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{message}</span>
              <span>
                {formatElapsed(elapsed)}
                {eta && ` · ETA ${eta}`}
              </span>
            </div>
          </>
        )}
        {isActive && progress === 0 && (
          <p className="text-xs text-muted-foreground">Iniciando...</p>
        )}
        {record.status === 'error' && record.error && (
          <p className="text-xs text-destructive">{record.error}</p>
        )}
        {record.status === 'done' && record.outputPath && (
          <p className="truncate text-xs text-muted-foreground">
            {record.outputPath.split('/').pop()}
          </p>
        )}
      </div>
      {record.status === 'done' && record.outputPath && (
        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
          <a
            href={`/api/projects/${projectId}/export/download?file=${encodeURIComponent(
              record.outputPath.split('/').pop() || ''
            )}`}
            download
          >
            <Download className="h-4 w-4" />
          </a>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-destructive hover:text-destructive"
        onClick={() => onDelete(record.id)}
        title="Eliminar"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function RenderQueue({ exports: exportRecords, projectId, onRefresh }: RenderQueueProps) {
  if (exportRecords.length === 0) return null;

  const handleDelete = async (exportId: string) => {
    await fetch(`/api/projects/${projectId}/export?exportId=${exportId}`, {
      method: 'DELETE',
    });
    onRefresh();
  };

  const handleClearAll = async () => {
    await fetch(`/api/projects/${projectId}/export`, {
      method: 'DELETE',
    });
    onRefresh();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            Render Queue ({exportRecords.length})
          </CardTitle>
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={handleClearAll}>
            Limpiar todo
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {exportRecords.map((record) => (
            <ExportItem
              key={record.id}
              record={record}
              projectId={projectId}
              onRefresh={onRefresh}
              onDelete={handleDelete}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
