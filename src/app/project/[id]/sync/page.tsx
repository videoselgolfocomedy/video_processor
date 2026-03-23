'use client';

import { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useProjectStore } from '@/stores/project-store';
import { AudioPlayer } from '@/components/audio/audio-player';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  AlertTriangle,
  CheckCircle,
  Download,
  FileAudio,
  FileVideo,
  Loader2,
  Play,
  Trash2,
  Video,
} from 'lucide-react';

interface AudioFileEntry {
  name: string;
  size: number;
  modified: string;
  isAmbient: boolean;
  isCleanup: boolean;
  isMix: boolean;
  isExtracted: boolean;
}

function formatTime(ms: number): string {
  const totalSec = Math.abs(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileBadge(f: AudioFileEntry): { label: string; className: string } | null {
  if (f.isExtracted) return { label: 'Extraído', className: 'bg-slate-700 text-slate-300' };
  if (f.isMix || f.name === 'mixed.wav') return { label: 'Mix', className: 'bg-purple-900/60 text-purple-300' };
  if (f.isAmbient) return { label: 'Ambiente', className: 'bg-blue-900/60 text-blue-300' };
  if (f.isCleanup) return { label: 'Clean', className: 'bg-green-900/60 text-green-300' };
  if (f.name.startsWith('ambient')) return { label: 'Ambiente', className: 'bg-blue-900/60 text-blue-300' };
  if (f.name.startsWith('cleanup') || f.name.startsWith('clean')) return { label: 'Clean', className: 'bg-green-900/60 text-green-300' };
  if (f.name.startsWith('amplified')) return { label: 'Amplificado', className: 'bg-amber-900/60 text-amber-300' };
  return null;
}

export default function SyncPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject } = useProjectStore();
  const { toast } = useToast();

  const [audioFiles, setAudioFiles] = useState<AudioFileEntry[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Mux state
  const [muxJobId, setMuxJobId] = useState<string | null>(null);
  const [muxProgress, setMuxProgress] = useState(0);
  const [muxMessage, setMuxMessage] = useState('');
  const [muxing, setMuxing] = useState(false);

  // SSE for mux progress
  useSSE({
    jobId: muxJobId,
    onProgress: useCallback((progress: number, message: string) => {
      setMuxProgress(progress);
      setMuxMessage(message);
    }, []),
    onComplete: useCallback(() => {
      setMuxing(false);
      setMuxJobId(null);
      setMuxProgress(0);
      setMuxMessage('');
      fetchProject(projectId);
      toast({ title: 'Video muxado correctamente' });
    }, [fetchProject, projectId, toast]),
    onError: useCallback((error: string) => {
      setMuxing(false);
      setMuxJobId(null);
      setMuxProgress(0);
      toast({ title: 'Error al muxar', description: error, variant: 'destructive' });
    }, [toast]),
  });

  // Persist selectedAudioPath to project when user selects an audio file
  const handleSelectAudio = useCallback(async (fileName: string | null) => {
    setSelectedAudio(fileName);
    if (!currentProject) return;
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sync: {
            ...currentProject.sync,
            selectedAudioPath: fileName ?? null,
          },
        }),
      });
      await fetchProject(projectId);
    } catch {
      // ignore
    }
  }, [projectId, currentProject, fetchProject]);

  // Fetch available audio files
  const fetchAudioFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/file?list=generated`);
      const data = await res.json();
      setAudioFiles((data.files || []) as AudioFileEntry[]);
    } catch {
      // ignore
    }
  }, [projectId]);

  useEffect(() => { fetchAudioFiles(); }, [fetchAudioFiles]);

  // Restore selection from project state
  useEffect(() => {
    if (!currentProject) return;
    const saved = currentProject.sync.selectedAudioPath;
    if (saved) {
      // selectedAudioPath can be a full path or just a filename
      const name = saved.includes('/') ? saved.split('/').pop()! : saved;
      setSelectedAudio(name);
    }
  }, [currentProject]);

  // Auto-select mixed.wav or first mix file if nothing selected
  useEffect(() => {
    if (selectedAudio || audioFiles.length === 0) return;
    const mixed = audioFiles.find(f => f.name === 'mixed.wav');
    if (mixed) { handleSelectAudio(mixed.name); return; }
    const firstMix = audioFiles.find(f => f.isMix || f.name.startsWith('mix_'));
    if (firstMix) { handleSelectAudio(firstMix.name); return; }
  }, [audioFiles, selectedAudio, handleSelectAudio]);

  // Delete file
  const handleDelete = useCallback(async (fileName: string) => {
    if (!confirm(`¿Borrar "${fileName}"? Esta acción no se puede deshacer.`)) return;
    setDeleting(fileName);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(fileName)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error');
      }
      if (selectedAudio === fileName) handleSelectAudio(null);
      if (expandedFile === fileName) setExpandedFile(null);
      await fetchProject(projectId);
      fetchAudioFiles();
      toast({ title: `"${fileName}" borrado` });
    } catch (err) {
      toast({ title: 'Error al borrar', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setDeleting(null);
    }
  }, [projectId, selectedAudio, expandedFile, fetchProject, fetchAudioFiles, toast, handleSelectAudio]);

  // Mux audio into video
  const handleMux = useCallback(async () => {
    if (!selectedAudio) return;
    setMuxing(true);
    setMuxProgress(0);
    setMuxMessage('Iniciando...');
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/mux`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioFileName: selectedAudio }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al muxar');
      }
      const data = await res.json();
      setMuxJobId(data.jobId);
    } catch (err) {
      setMuxing(false);
      toast({ title: 'Error al muxar', description: (err as Error).message, variant: 'destructive' });
    }
  }, [projectId, selectedAudio, toast]);

  // Delete muxed video
  const handleDeleteMuxed = useCallback(async () => {
    if (!currentProject?.sync.muxedVideoPath) return;
    const fileName = currentProject.sync.muxedVideoPath.split('/').pop() || '';
    if (!confirm(`¿Borrar video muxado "${fileName}"?`)) return;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(fileName)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error');
      }
      // Clear muxedVideoPath from project
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sync: { ...currentProject.sync, muxedVideoPath: null } }),
      });
      await fetchProject(projectId);
      toast({ title: 'Video muxado borrado' });
    } catch (err) {
      toast({ title: 'Error al borrar', description: (err as Error).message, variant: 'destructive' });
    }
  }, [currentProject, projectId, fetchProject, toast]);

  if (!currentProject) return null;

  const cameraSource = currentProject.sources.find((s) => s.role === 'camera' && s.type === 'video');
  const alignmentOffsetMs = currentProject.audio.alignmentOffsetMs ?? 0;
  const muxedVideoPath = currentProject.sync.muxedVideoPath;
  const muxedVideoName = muxedVideoPath?.split('/').pop() ?? null;

  // Filter: only show usable audio files (not raw extracted tracks)
  const usableFiles = audioFiles.filter(f => !f.isExtracted);

  const audioFileUrl = (name: string) =>
    `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(name)}&t=${Date.now()}`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Sync & Mix</h2>
        <p className="text-sm text-muted-foreground">
          Selecciona el audio procesado y reemplaza la pista de audio del video de cámara
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">

          {/* 1. Select audio file */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <FileAudio className="h-4 w-4" />
                1. Selecciona el audio
                <span className="text-muted-foreground font-normal ml-auto text-xs">
                  {usableFiles.length} archivo{usableFiles.length !== 1 ? 's' : ''}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {usableFiles.length === 0 ? (
                <div className="py-6 text-center space-y-3">
                  <p className="text-xs text-muted-foreground">
                    No hay archivos de audio procesados.
                  </p>
                  <Link href={`/project/${projectId}/audio-prep`}>
                    <Button variant="outline" size="sm" className="text-xs">
                      Ir a Audio para generar mezcla
                    </Button>
                  </Link>
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground mb-3">
                    Elige el audio que quieras usar en el video final. Este audio se usará también para la transcripción.
                  </p>
                  {usableFiles.map((f) => {
                    const badge = fileBadge(f);
                    const isSelected = selectedAudio === f.name;
                    const isExpanded = expandedFile === f.name;
                    return (
                      <div
                        key={f.name}
                        className={`rounded-md border p-2 transition-colors ${
                          isSelected
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-border/80'
                        }`}
                      >
                        <div className="flex items-center gap-2 text-xs">
                          {/* Select radio */}
                          <button
                            onClick={() => handleSelectAudio(isSelected ? null : f.name)}
                            className={`flex-none h-4 w-4 rounded-full border-2 transition-colors cursor-pointer ${
                              isSelected
                                ? 'border-primary bg-primary'
                                : 'border-muted-foreground/40 hover:border-muted-foreground'
                            }`}
                            title="Seleccionar para muxar"
                          >
                            {isSelected && (
                              <div className="h-full w-full flex items-center justify-center">
                                <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                              </div>
                            )}
                          </button>

                          {/* Badge */}
                          {badge && (
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.className}`}>
                              {badge.label}
                            </span>
                          )}

                          {/* File name */}
                          <span className={`font-mono truncate ${isSelected ? 'text-primary' : ''}`}>
                            {f.name}
                          </span>

                          {/* Size */}
                          <span className="text-muted-foreground/60 flex-none ml-auto">
                            {formatSize(f.size)}
                          </span>

                          {/* Play toggle */}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 flex-none"
                            onClick={() => setExpandedFile(isExpanded ? null : f.name)}
                            title="Reproducir"
                          >
                            <Play className="h-3 w-3" />
                          </Button>

                          {/* Delete */}
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
                        </div>

                        {/* Inline player */}
                        {isExpanded && (
                          <div className="mt-2 pl-6">
                            <AudioPlayer src={audioFileUrl(f.name)} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </CardContent>
          </Card>

          {/* 2. Mux audio into video */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Video className="h-4 w-4" />
                2. Reemplazar audio del video
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Reemplaza la pista de audio del video de cámara con el audio seleccionado.
                El video no se re-encodea (copia directa), solo se cambia el audio.
              </p>

              {!cameraSource && (
                <div className="flex items-center gap-2 text-xs text-yellow-500">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>No hay video de cámara importado</span>
                </div>
              )}

              {selectedAudio ? (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-2 space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <FileAudio className="h-3.5 w-3.5 text-primary" />
                    <span className="text-muted-foreground">Audio seleccionado:</span>
                    <strong className="font-mono text-primary">{selectedAudio}</strong>
                  </div>
                  {alignmentOffsetMs > 0 && !(selectedAudio === 'mixed.wav' || selectedAudio.startsWith('mix_')) && (
                    <p className="text-[10px] text-muted-foreground pl-5">
                      Se aplicará offset de alineación: se recortarán los primeros {formatTime(alignmentOffsetMs)} del audio para sincronizar con el video.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-yellow-500">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>Selecciona un archivo de audio arriba primero</span>
                </div>
              )}

              {muxing && (
                <div className="space-y-1">
                  <Progress value={muxProgress} className="h-2" />
                  <p className="text-xs text-muted-foreground">{muxMessage}</p>
                </div>
              )}

              <Button
                onClick={handleMux}
                disabled={!selectedAudio || !cameraSource || muxing}
                className="w-full"
              >
                {muxing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Muxando...
                  </>
                ) : (
                  <>
                    <Video className="mr-2 h-4 w-4" />
                    {muxedVideoPath ? 'Re-muxar audio en video' : 'Muxar audio en video'}
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar: result */}
        <div className="space-y-6">
          {muxedVideoPath && muxedVideoName ? (
            <Card className="border-green-800/40 bg-green-950/20">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2 text-green-400">
                  <CheckCircle className="h-4 w-4" />
                  Video listo
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  El video ya tiene el audio procesado. Puedes ir a Compose o Reels para editar.
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileVideo className="h-3.5 w-3.5 text-green-400 flex-none" />
                  <span className="font-mono truncate">{muxedVideoName}</span>
                </div>

                <div className="flex gap-2">
                  <Link href={`/project/${projectId}/compose`} className="flex-1">
                    <Button variant="outline" size="sm" className="w-full text-xs">
                      Ir a Compose
                    </Button>
                  </Link>
                  <Link href={`/project/${projectId}/transcription`} className="flex-1">
                    <Button variant="outline" size="sm" className="w-full text-xs">
                      Transcribir
                    </Button>
                  </Link>
                </div>

                <a
                  href={`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(muxedVideoName)}`}
                  download={muxedVideoName}
                  className="inline-flex items-center gap-2 text-xs text-primary hover:underline"
                >
                  <Download className="h-3.5 w-3.5" />
                  Descargar video
                </a>

                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-destructive hover:text-destructive text-xs"
                  onClick={handleDeleteMuxed}
                >
                  <Trash2 className="mr-1.5 h-3 w-3" />
                  Borrar video muxado
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-border">
              <CardContent className="pt-6 text-center space-y-3">
                <Video className="h-8 w-8 text-muted-foreground/40 mx-auto" />
                <p className="text-xs text-muted-foreground">
                  Aún no hay video muxado. Selecciona un audio y pulsa &quot;Muxar&quot;.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Info card */}
          <Card className="border-border">
            <CardContent className="pt-4 space-y-2 text-xs text-muted-foreground">
              <p className="font-medium text-foreground text-xs">Flujo de trabajo</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Procesa el audio en <Link href={`/project/${projectId}/audio-prep`} className="text-primary hover:underline">Audio</Link></li>
                <li>Selecciona el audio final aquí</li>
                <li>Muxar → reemplaza el audio del video</li>
                <li><Link href={`/project/${projectId}/transcription`} className="text-primary hover:underline">Transcribir</Link> el audio seleccionado</li>
                <li>Editar en <Link href={`/project/${projectId}/compose`} className="text-primary hover:underline">Compose</Link> / <Link href={`/project/${projectId}/reels`} className="text-primary hover:underline">Reels</Link></li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
