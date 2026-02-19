'use client';

import { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { AudioPlayer } from '@/components/audio/audio-player';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  AlertTriangle,
  CheckCircle,
  Download,
  FileAudio,
  FileVideo,
  Info,
  Loader2,
  Play,
  Trash2,
  Video,
  Volume2,
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

function fileBadge(f: AudioFileEntry): { label: string; className: string } {
  if (f.isExtracted) return { label: 'Extraído', className: 'bg-slate-700 text-slate-300' };
  if (f.isMix) return { label: 'Mix', className: 'bg-purple-900/60 text-purple-300' };
  if (f.isAmbient) return { label: 'Ambiente', className: 'bg-blue-900/60 text-blue-300' };
  if (f.isCleanup) return { label: 'Clean', className: 'bg-green-900/60 text-green-300' };
  if (f.name.startsWith('ambient')) return { label: 'Ambiente', className: 'bg-blue-900/60 text-blue-300' };
  if (f.name.startsWith('cleanup') || f.name.startsWith('clean')) return { label: 'Clean', className: 'bg-green-900/60 text-green-300' };
  return { label: 'Audio', className: 'bg-zinc-800 text-zinc-400' };
}

export default function SyncPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject } = useProjectStore();
  const { toast } = useToast();

  const [audioFiles, setAudioFiles] = useState<AudioFileEntry[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

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
      // Update zustand store so other pages see the change
      await fetchProject(projectId);
    } catch {
      // ignore
    }
  }, [projectId, currentProject, fetchProject]);
  const [boardVol, setBoardVol] = useState(
    currentProject?.sync.boardVolume ?? 1
  );
  const [ambientVol, setAmbientVol] = useState(
    currentProject?.sync.cameraAmbientVolume ?? 0.7
  );
  const [mixing, setMixing] = useState(false);
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

  // Auto-select mixed.wav or first mix file if nothing selected
  useEffect(() => {
    if (selectedAudio || audioFiles.length === 0) return;
    const mixed = audioFiles.find(f => f.name === 'mixed.wav');
    if (mixed) { setSelectedAudio(mixed.name); return; }
    const firstMix = audioFiles.find(f => f.isMix);
    if (firstMix) { setSelectedAudio(firstMix.name); return; }
  }, [audioFiles, selectedAudio]);

  // Generate mix via align API
  const handleMix = useCallback(async () => {
    setMixing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardVolume: boardVol,
          cameraAmbientVolume: ambientVol,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error');
      }
      await fetchProject(projectId);
      fetchAudioFiles();
      toast({ title: 'Audio sincronizado y mezclado' });
    } catch (err) {
      toast({ title: 'Error al mezclar', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setMixing(false);
    }
  }, [projectId, boardVol, ambientVol, fetchProject, fetchAudioFiles, toast]);

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
  }, [projectId, selectedAudio, expandedFile, fetchProject, fetchAudioFiles, toast]);

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
        throw new Error(data.error || 'Error');
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
      await fetchProject(projectId);
      toast({ title: 'Video muxado borrado' });
    } catch (err) {
      toast({ title: 'Error al borrar', description: (err as Error).message, variant: 'destructive' });
    }
  }, [currentProject, projectId, fetchProject, toast]);

  if (!currentProject) return null;

  const sources = currentProject.sources;
  const cameraSource = sources.find((s) => s.role === 'camera' && s.type === 'video');
  const boardSource = sources.find((s) => s.role === 'board');
  const hasBoardAudio = !!boardSource;
  const hasAmbient = !!currentProject.audio.ambientPath;
  const canSync = hasBoardAudio && hasAmbient;
  const alignmentOffsetMs = currentProject.audio.alignmentOffsetMs ?? 0;
  const ambientFileName = currentProject.audio.ambientPath?.split('/').pop() ?? null;
  const muxedVideoPath = currentProject.sync.muxedVideoPath;
  const muxedVideoName = muxedVideoPath?.split('/').pop() ?? null;

  const audioFileUrl = (name: string) =>
    `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(name)}&t=${Date.now()}`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Sincronización Audio → Video</h2>
        <p className="text-sm text-muted-foreground">
          Selecciona un audio, mézclalo o úsalo directamente, y muxálo en el video de cámara
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* 1. Status */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="pt-4 space-y-2">
              <p className="text-xs font-medium text-primary mb-2">Estado del proyecto</p>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  {cameraSource ? (
                    <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                  )}
                  <FileVideo className="h-3 w-3 text-blue-400" />
                  <span className={cameraSource ? 'text-green-400' : 'text-yellow-500'}>
                    Video de cámara
                  </span>
                  {cameraSource && (
                    <span className="text-muted-foreground ml-auto">{cameraSource.originalName}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {hasBoardAudio ? (
                    <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                  )}
                  <FileAudio className="h-3 w-3 text-green-400" />
                  <span className={hasBoardAudio ? 'text-green-400' : 'text-yellow-500'}>
                    Audio de mesa (voz)
                  </span>
                  {boardSource && (
                    <span className="text-muted-foreground ml-auto">{boardSource.originalName}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {hasAmbient ? (
                    <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                  )}
                  <FileAudio className="h-3 w-3 text-blue-400" />
                  <span className={hasAmbient ? 'text-green-400' : 'text-yellow-500'}>
                    Ambiente (sustracción guiada)
                  </span>
                  {ambientFileName && (
                    <span className="font-mono text-muted-foreground ml-auto">{ambientFileName}</span>
                  )}
                </div>
                {alignmentOffsetMs > 0 && (
                  <div className="flex items-center gap-2 pl-5 text-muted-foreground">
                    <span>Offset de alineación: <strong className="text-foreground">{formatTime(alignmentOffsetMs)}</strong></span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 2. Audio files list */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <FileAudio className="h-4 w-4" />
                Archivos de audio disponibles
                <span className="text-muted-foreground font-normal ml-auto text-xs">
                  {audioFiles.length} archivo{audioFiles.length !== 1 ? 's' : ''}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {audioFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No hay archivos de audio generados. Ve a Audio-prep para generar.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground mb-3">
                    Selecciona el audio que quieras muxar en el video. Puedes reproducir y borrar los que no necesites.
                  </p>
                  {audioFiles.map((f) => {
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
                            disabled={f.isExtracted}
                            className={`flex-none h-4 w-4 rounded-full border-2 transition-colors ${
                              isSelected
                                ? 'border-primary bg-primary'
                                : 'border-muted-foreground/40 hover:border-muted-foreground'
                            } ${f.isExtracted ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                            title={f.isExtracted ? 'Pistas extraídas no se pueden usar directamente' : 'Seleccionar para muxar'}
                          >
                            {isSelected && (
                              <div className="h-full w-full flex items-center justify-center">
                                <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                              </div>
                            )}
                          </button>

                          {/* Badge */}
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.className}`}>
                            {badge.label}
                          </span>

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

          {/* 3. Generate mix */}
          {canSync && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Generar nueva mezcla (mesa + ambiente)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border border-border bg-secondary/50 p-3">
                  <div className="flex items-start gap-2">
                    <Info className="h-4 w-4 text-primary mt-0.5 flex-none" />
                    <div className="text-xs text-muted-foreground">
                      Recorta el audio de <strong className="text-green-400">mesa</strong> desde
                      el offset ({formatTime(alignmentOffsetMs)}) y lo combina con
                      el <strong className="text-blue-400">ambiente</strong>.
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Vol. Mesa (Voz)</Label>
                      <span className="text-xs text-muted-foreground">{Math.round(boardVol * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={boardVol}
                      onChange={(e) => setBoardVol(parseFloat(e.target.value))}
                      disabled={mixing}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Vol. Ambiente</Label>
                      <span className="text-xs text-muted-foreground">{Math.round(ambientVol * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={ambientVol}
                      onChange={(e) => setAmbientVol(parseFloat(e.target.value))}
                      disabled={mixing}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
                    />
                  </div>
                </div>

                {mixing && <Progress value={50} className="h-2" />}

                <Button onClick={handleMix} disabled={mixing} className="w-full">
                  {mixing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Mezclando...
                    </>
                  ) : (
                    <>
                      <Volume2 className="mr-2 h-4 w-4" />
                      {currentProject.sync.mixedAudioPath ? 'Re-generar mezcla' : 'Generar mezcla'}
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* 4. Mux audio into video */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Video className="h-4 w-4" />
                Muxar audio en video
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Reemplaza la pista de audio del video de cámara con el audio seleccionado.
                El video no se re-encodea (copia directa), solo se cambia el audio → muy rápido.
              </p>

              {selectedAudio ? (
                <div className="flex items-center gap-2 text-xs text-primary">
                  <FileAudio className="h-3.5 w-3.5" />
                  <span>Audio seleccionado: <strong className="font-mono">{selectedAudio}</strong></span>
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
                    Muxar audio en video
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar: muxed result */}
        <div className="space-y-6">
          {/* Muxed video result */}
          {muxedVideoPath && muxedVideoName && (
            <Card className="border-green-800/40 bg-green-950/20">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2 text-green-400">
                  <CheckCircle className="h-4 w-4" />
                  Video muxado
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileVideo className="h-3.5 w-3.5 text-green-400 flex-none" />
                  <span className="font-mono truncate">{muxedVideoName}</span>
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
          )}

          {/* Mixed audio result */}
          {currentProject.sync.mixedAudioPath && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">
                  Audio mezclado actual
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-green-500">
                  <CheckCircle className="h-4 w-4" />
                  Audio sincronizado y mezclado
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileAudio className="h-3.5 w-3.5 text-primary flex-none" />
                  <span className="font-mono">mixed.wav</span>
                </div>
                <AudioPlayer
                  src={audioFileUrl('mixed.wav')}
                  label="Reproducir mezcla final"
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
