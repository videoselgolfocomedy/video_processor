'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Trash2, ChevronDown, ChevronUp, AlertTriangle, HardDrive, RefreshCw } from 'lucide-react';
import { formatFileSize } from '@/lib/utils';

interface FileInfo {
  name: string;
  size: number;
  mtimeMs: number;
  category: 'audio' | 'export' | 'compose' | 'transcription';
  referenced: boolean;
  role: string;
}

interface StorageData {
  files: FileInfo[];
  totalBytes: number;
  orphanBytes: number;
}

const CATEGORY_LABEL: Record<FileInfo['category'], string> = {
  audio: 'Audio',
  export: 'Exports',
  compose: 'Compose',
  transcription: 'Transcripción',
};

export function StoragePanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<StorageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/files`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDeleteOne = useCallback(
    async (name: string, referenced: boolean) => {
      if (referenced) {
        const ok = confirm(
          `"${name}" está siendo usado por el proyecto. Eliminarlo puede romper el render o el playback. ¿Eliminar de todos modos?`
        );
        if (!ok) return;
      }
      setDeleting(true);
      try {
        await fetch(`/api/projects/${projectId}/files`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: [name] }),
        });
        await load();
      } finally {
        setDeleting(false);
      }
    },
    [projectId, load]
  );

  const handleDeleteAllOrphans = useCallback(async () => {
    if (!data) return;
    const orphanCount = data.files.filter((f) => !f.referenced).length;
    if (orphanCount === 0) return;
    const ok = confirm(
      `Eliminar ${orphanCount} archivo(s) intermedio(s) huérfano(s) (~${formatFileSize(data.orphanBytes)})?\n\nEstos archivos no están referenciados por el proyecto y son seguros de eliminar.`
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${projectId}/files`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteAllOrphans: true }),
      });
      await load();
    } finally {
      setDeleting(false);
    }
  }, [projectId, data, load]);

  if (!data) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <HardDrive className="h-4 w-4" />
            Almacenamiento
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">{loading ? 'Cargando…' : 'Sin datos'}</p>
        </CardContent>
      </Card>
    );
  }

  const grouped: Record<FileInfo['category'], FileInfo[]> = {
    audio: [],
    export: [],
    compose: [],
    transcription: [],
  };
  for (const f of data.files) grouped[f.category].push(f);
  // Sort each group: orphans first, then biggest first
  for (const k of Object.keys(grouped) as FileInfo['category'][]) {
    grouped[k].sort((a, b) => {
      if (a.referenced !== b.referenced) return a.referenced ? 1 : -1;
      return b.size - a.size;
    });
  }

  const orphanCount = data.files.filter((f) => !f.referenced).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <HardDrive className="h-4 w-4" />
            Almacenamiento
            <span className="text-xs text-muted-foreground font-normal">
              {formatFileSize(data.totalBytes)} en total
              {orphanBytes(data) > 0 && (
                <> · <span className="text-amber-500">{formatFileSize(data.orphanBytes)} liberables</span></>
              )}
            </span>
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={load}
              disabled={loading}
              title="Refrescar"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            {orphanCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs text-amber-600 border-amber-600/50 hover:bg-amber-600/10"
                onClick={handleDeleteAllOrphans}
                disabled={deleting}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Limpiar {orphanCount} huérfano{orphanCount !== 1 ? 's' : ''}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4">
          {(Object.keys(grouped) as FileInfo['category'][]).map((cat) => {
            const files = grouped[cat];
            if (files.length === 0) return null;
            const catBytes = files.reduce((s, f) => s + f.size, 0);
            return (
              <div key={cat}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {CATEGORY_LABEL[cat]} <span className="text-[10px]">({files.length} · {formatFileSize(catBytes)})</span>
                  </span>
                </div>
                <div className="space-y-1">
                  {files.map((f) => (
                    <div
                      key={`${cat}/${f.name}`}
                      className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${
                        f.referenced ? 'bg-secondary/40' : 'bg-amber-950/20'
                      }`}
                    >
                      {!f.referenced && (
                        <span title="No referenciado por el proyecto" className="flex-shrink-0">
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                        </span>
                      )}
                      <span className="flex-1 min-w-0">
                        <div className="truncate font-mono text-[11px]">{f.name}</div>
                        <div className={`text-[10px] ${f.referenced ? 'text-muted-foreground' : 'text-amber-500/80'}`}>
                          {f.role}
                        </div>
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
                        {formatFileSize(f.size)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-red-500 flex-shrink-0"
                        onClick={() => handleDeleteOne(f.name, f.referenced)}
                        disabled={deleting}
                        title={f.referenced ? 'Archivo referenciado — eliminar con cuidado' : 'Eliminar'}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {data.files.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-3">
              No hay archivos intermedios.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function orphanBytes(data: StorageData): number {
  return data.orphanBytes;
}
