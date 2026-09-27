'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  FolderOpen,
  FileVideo,
  FileAudio,
  Import,
  RefreshCw,
  Loader2,
  Link2,
  Copy,
  ArrowRight,
} from 'lucide-react';
import { formatFileSize } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

/** Parse "mm:ss", "h:mm:ss" or plain seconds into ms. null for empty/invalid. */
function parseTimeToMs(str: string): number | null | 'invalid' {
  const t = str.trim();
  if (!t) return null;
  const parts = t.split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return 'invalid';
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0)) return 'invalid';
  let sec = 0;
  for (const n of nums) sec = sec * 60 + n;
  return Math.round(sec * 1000);
}

interface InboxFile {
  name: string;
  size: number;
  modifiedAt: string;
  type: 'video' | 'audio';
}

interface InboxPanelProps {
  projectId: string;
  onImported: () => void;
}

type ImportMode = 'move' | 'copy' | 'link';

export function InboxPanel({ projectId, onImported }: InboxPanelProps) {
  const [files, setFiles] = useState<InboxFile[]>([]);
  const [inboxPath, setInboxPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<'camera' | 'board' | 'other'>('other');
  const [importMode, setImportMode] = useState<ImportMode>('move');
  // Optional lossless trim range applied to the next import (mm:ss).
  const [trimStart, setTrimStart] = useState('');
  const [trimEnd, setTrimEnd] = useState('');
  const { toast } = useToast();

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/inbox');
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files);
        setInboxPath(data.path);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const handleImport = useCallback(
    async (filename: string) => {
      // Optional lossless trim range
      const startMs = parseTimeToMs(trimStart);
      const endMs = parseTimeToMs(trimEnd);
      if (startMs === 'invalid' || endMs === 'invalid') {
        toast({ title: 'Tramo no válido', description: 'Usa mm:ss (p. ej. 12:30) o h:mm:ss.', variant: 'destructive' });
        return;
      }
      if (startMs != null && endMs != null && endMs <= startMs) {
        toast({ title: 'Tramo no válido', description: 'El fin debe ser mayor que el inicio.', variant: 'destructive' });
        return;
      }
      const hasTrim = startMs != null || endMs != null;
      setImporting(filename);
      try {
        const res = await fetch(`/api/projects/${projectId}/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename,
            role: selectedRole,
            mode: importMode,
            ...(startMs != null ? { trimStartMs: startMs } : {}),
            ...(endMs != null ? { trimEndMs: endMs } : {}),
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Import failed');
        }
        toast({
          title: `Imported: ${filename}`,
          description: hasTrim ? 'Tramo cortado sin recomprimir (calidad idéntica). El original sigue en el inbox.' : undefined,
        });
        onImported();
        // Refresh inbox list (file may have been moved)
        fetchFiles();
      } catch (err) {
        toast({
          title: 'Import failed',
          description: (err as Error).message,
          variant: 'destructive',
        });
      } finally {
        setImporting(null);
      }
    },
    [projectId, selectedRole, importMode, trimStart, trimEnd, onImported, fetchFiles, toast]
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <FolderOpen className="h-4 w-4" />
            Inbox (Servidor)
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={fetchFiles}
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Deja ficheros en <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{inboxPath || 'inbox/'}</code> e impórtalos aquí.
        </p>

        {/* Import options */}
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">Rol:</span>
          {(['camera', 'board', 'other'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setSelectedRole(r)}
              className={`rounded px-2 py-0.5 transition-colors ${
                selectedRole === r
                  ? r === 'camera'
                    ? 'bg-blue-500/20 text-blue-400'
                    : r === 'board'
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {r === 'camera' ? 'Cámara' : r === 'board' ? 'Mesa' : 'Otro'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">Modo:</span>
          {([
            { mode: 'move' as ImportMode, icon: ArrowRight, label: 'Mover' },
            { mode: 'link' as ImportMode, icon: Link2, label: 'Enlace' },
            { mode: 'copy' as ImportMode, icon: Copy, label: 'Copiar' },
          ]).map(({ mode, icon: Icon, label }) => (
            <button
              key={mode}
              onClick={() => setImportMode(mode)}
              className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
                importMode === mode
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
              title={
                mode === 'move'
                  ? 'Mover fichero al proyecto (libera espacio en inbox)'
                  : mode === 'link'
                    ? 'Symlink - sin duplicar (ideal para local)'
                    : 'Copiar fichero (mantiene original en inbox)'
              }
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>

        {/* Optional lossless trim range — cut just a piece of a huge recording
            without re-encoding (identical quality, runs at disk speed). */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Tramo:</span>
          <Input
            value={trimStart}
            onChange={(e) => setTrimStart(e.target.value)}
            placeholder="inicio mm:ss"
            className="h-7 w-24 text-xs"
          />
          <span className="text-muted-foreground">→</span>
          <Input
            value={trimEnd}
            onChange={(e) => setTrimEnd(e.target.value)}
            placeholder="fin mm:ss"
            className="h-7 w-24 text-xs"
          />
          {(trimStart.trim() || trimEnd.trim()) && (
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => { setTrimStart(''); setTrimEnd(''); }}
            >
              Quitar
            </button>
          )}
        </div>
        {(trimStart.trim() || trimEnd.trim()) && (
          <p className="text-[10px] text-muted-foreground leading-tight">
            Corte <strong>sin recomprimir</strong> (calidad idéntica, va a velocidad de disco). Empieza en el
            keyframe anterior al inicio (~1s antes como mucho). El original se queda en el inbox.
            Con ficheros grandes puede tardar un par de minutos — no cierres la página.
          </p>
        )}

        {/* File list */}
        {files.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            {loading ? 'Cargando...' : 'No hay ficheros en el inbox'}
          </div>
        ) : (
          <div className="space-y-1.5">
            {files.map((file) => (
              <div
                key={file.name}
                className="flex items-center gap-2 rounded-md bg-secondary p-2"
              >
                {file.type === 'video' ? (
                  <FileVideo className="h-4 w-4 flex-none text-blue-400" />
                ) : (
                  <FileAudio className="h-4 w-4 flex-none text-green-400" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{file.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatFileSize(file.size)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => handleImport(file.name)}
                  disabled={importing === file.name}
                >
                  {importing === file.name ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Import className="h-3 w-3" />
                  )}
                  Importar
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
