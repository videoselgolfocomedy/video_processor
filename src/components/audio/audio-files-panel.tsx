'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Trash2, FileAudio, CheckCircle, Star, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { AudioPlayer } from '@/components/audio/audio-player';

interface AudioFile {
  name: string;
  size: number;
  modified: string;
  isAmbient: boolean;
  isCleanup: boolean;
  isMix: boolean;
  isExtracted: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface AudioFilesPanelProps {
  projectId: string;
  onAmbientChanged: () => void;
}

export function AudioFilesPanel({ projectId, onAmbientChanged }: AudioFilesPanelProps) {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [playingFile, setPlayingFile] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/file?list=generated`);
      const data = await res.json();
      setFiles(data.files || []);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { fetchFiles(); }, [fetchFiles]);

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`¿Borrar ${name}?`)) return;
    setDeleting(name);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(name)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error');
      }
      toast({ title: `${name} borrado` });
      if (playingFile === name) setPlayingFile(null);
      onAmbientChanged();
      fetchFiles();
    } catch (err) {
      toast({ title: 'Error al borrar', description: (err as Error).message, variant: 'destructive' });
    }
    setDeleting(null);
  }, [projectId, playingFile, toast, fetchFiles, onAmbientChanged]);

  const handleSelect = useCallback(async (name: string) => {
    setSelecting(name);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/file`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ambientFile: name }),
      });
      if (!res.ok) throw new Error('Error');
      toast({ title: `${name} seleccionado como ambiente activo` });
      onAmbientChanged();
      fetchFiles();
    } catch {
      toast({ title: 'Error al seleccionar', variant: 'destructive' });
    }
    setSelecting(null);
  }, [projectId, toast, fetchFiles, onAmbientChanged]);

  // Group files
  const generated = files.filter(f => !f.isExtracted && f.name !== 'alignment_data.json' && f.name !== 'laughter_segments.json');
  const ambients = generated.filter(f => f.name.startsWith('ambient'));
  const mixes = generated.filter(f => f.isMix);
  const cleanups = generated.filter(f => f.name.includes('clean'));
  const other = generated.filter(f => !f.name.startsWith('ambient') && !f.isMix && !f.name.includes('clean'));

  if (generated.length === 0 && !loading) return null;

  const renderFile = (f: AudioFile) => (
    <div key={f.name} className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <FileAudio className={`h-3.5 w-3.5 flex-none ${
          f.isAmbient ? 'text-green-400' : f.isMix ? 'text-primary' : 'text-muted-foreground'
        }`} />
        <button
          className={`font-mono truncate text-left hover:underline ${
            playingFile === f.name ? 'text-primary' : ''
          }`}
          onClick={() => setPlayingFile(playingFile === f.name ? null : f.name)}
        >
          {f.name}
        </button>
        {f.isAmbient && (
          <span className="flex items-center gap-0.5 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-400 flex-none">
            <CheckCircle className="h-2.5 w-2.5" />
            Activo
          </span>
        )}
        <span className="text-muted-foreground/60 flex-none ml-auto">
          {formatSize(f.size)}
        </span>
        <span className="text-muted-foreground/60 flex-none">
          {formatDate(f.modified)}
        </span>
        {/* Select as ambient for sync */}
        {!f.isAmbient && !f.isMix && !f.isExtracted && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-none"
            onClick={() => handleSelect(f.name)}
            disabled={selecting === f.name}
            title="Usar como ambiente para sync"
          >
            {selecting === f.name ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Star className="h-3 w-3" />
            )}
          </Button>
        )}
        {/* Delete */}
        {!f.isExtracted && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-none text-destructive hover:text-destructive"
            onClick={() => handleDelete(f.name)}
            disabled={deleting === f.name}
            title="Borrar archivo"
          >
            {deleting === f.name ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          </Button>
        )}
      </div>
      {playingFile === f.name && (
        <div className="pl-5">
          <AudioPlayer
            src={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(f.name)}&t=${Date.now()}`}
          />
        </div>
      )}
    </div>
  );

  const renderSection = (title: string, items: AudioFile[]) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">{title}</p>
        {items.map(renderFile)}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Archivos generados</CardTitle>
          <Button variant="ghost" size="sm" onClick={fetchFiles} disabled={loading}>
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Actualizar'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {renderSection('Ambiente (sustracción)', ambients)}
        {renderSection('Limpieza', cleanups)}
        {renderSection('Mezclas preview', mixes)}
        {renderSection('Otros', other)}
      </CardContent>
    </Card>
  );
}
