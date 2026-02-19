'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useProjectStore } from '@/stores/project-store';
import { useSSE } from '@/hooks/use-sse';
import { AudioStatusPanel } from '@/components/audio/audio-status-panel';
import { SubtractPanel } from '@/components/audio/subtract-panel';
import { LaughterPanel } from '@/components/audio/laughter-panel';
import { VolumeCurvePanel } from '@/components/audio/volume-curve-panel';
import { AudioCleanupPanel } from '@/components/audio/audio-cleanup-panel';
import { MixPreviewPanel } from '@/components/audio/mix-preview-panel';
import { AudioFilesPanel } from '@/components/audio/audio-files-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import {
  Music,
  Loader2,
  ArrowDown,
  CheckCircle,
  Circle,
  FolderInput,
} from 'lucide-react';

type PipelineStepStatus = 'pending' | 'running' | 'done';

function PreparationPipeline({
  extractStatus,
  extractProgress,
  subtractStatus,
  subtractProgress,
  laughterStatus,
  laughterProgress,
  cleanupStatus,
}: {
  extractStatus: PipelineStepStatus;
  extractProgress: number;
  subtractStatus: PipelineStepStatus;
  subtractProgress: number;
  laughterStatus: PipelineStepStatus;
  laughterProgress: number;
  cleanupStatus: PipelineStepStatus;
}) {
  const steps: { label: string; status: PipelineStepStatus; progress: number }[] = [
    { label: 'Extracción', status: extractStatus, progress: extractProgress },
    { label: 'Sustracción guiada', status: subtractStatus, progress: subtractProgress },
    { label: 'Detección risas', status: laughterStatus, progress: laughterProgress },
    { label: 'Limpieza', status: cleanupStatus, progress: cleanupStatus === 'done' ? 100 : 0 },
  ];

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="pt-4">
        <p className="text-xs font-medium text-primary mb-3">Pipeline de preparación</p>
        <div className="flex items-center gap-2">
          {steps.map((step, i) => (
            <div key={step.label} className="flex items-center gap-2 flex-1">
              <div className="flex-1">
                <div className="flex items-center gap-1.5 mb-1">
                  {step.status === 'done' ? (
                    <CheckCircle className="h-3.5 w-3.5 text-green-500 flex-none" />
                  ) : step.status === 'running' ? (
                    <Loader2 className="h-3.5 w-3.5 text-primary animate-spin flex-none" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-muted-foreground/40 flex-none" />
                  )}
                  <span className={`text-xs ${
                    step.status === 'done'
                      ? 'text-green-500'
                      : step.status === 'running'
                        ? 'text-primary'
                        : 'text-muted-foreground/60'
                  }`}>
                    {step.label}
                  </span>
                </div>
                <Progress
                  value={step.status === 'done' ? 100 : step.progress}
                  className="h-1"
                />
              </div>
              {i < steps.length - 1 && (
                <ArrowDown className="h-3 w-3 text-muted-foreground/30 flex-none rotate-[-90deg]" />
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AudioPrepPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject } = useProjectStore();
  const { toast } = useToast();

  const [extractJobId, setExtractJobId] = useState<string | null>(null);
  const [extractProgress, setExtractProgress] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [subtractProgress, setSubtractProgress] = useState(0);
  const [subtractRunning, setSubtractRunning] = useState(false);
  const [laughterProgress, setLaughterProgress] = useState(0);
  const [laughterRunning, setLaughterRunning] = useState(false);

  useSSE({
    jobId: extractJobId,
    onProgress: (prog) => setExtractProgress(prog),
    onComplete: () => {
      setExtracting(false);
      setExtractJobId(null);
      fetchProject(projectId);
      toast({ title: 'Audio extraído del video' });
    },
    onError: (err) => {
      setExtracting(false);
      setExtractJobId(null);
      toast({
        title: 'Extracción fallida',
        description: err,
        variant: 'destructive',
      });
    },
  });

  const handleExtractAudio = useCallback(async () => {
    setExtracting(true);
    setExtractProgress(0);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/audio/extract`,
        { method: 'POST' }
      );
      if (!res.ok) throw new Error('Failed to start extraction');
      const data = await res.json();
      setExtractJobId(data.jobId);
    } catch {
      setExtracting(false);
      toast({
        title: 'No se pudo iniciar la extracción',
        variant: 'destructive',
      });
    }
  }, [projectId, toast]);

  const handleSubtractProgress = useCallback((progress: number, running: boolean) => {
    setSubtractProgress(progress);
    setSubtractRunning(running);
  }, []);

  const handleLaughterProgress = useCallback((progress: number, running: boolean) => {
    setLaughterProgress(progress);
    setLaughterRunning(running);
  }, []);

  if (!currentProject) return null;

  const sources = currentProject.sources;
  const cameraSource = sources.find(
    (s) => s.role === 'camera' && s.type === 'video'
  );
  const boardSource = sources.find((s) => s.role === 'board');
  const hasCameraExtracted = currentProject.audio.extractedTracks.some(
    (t) => cameraSource && t.sourceFileId === cameraSource.id
  );
  const hasExtractedAudio = currentProject.audio.extractedTracks.length > 0;
  const hasRequiredAudio = hasExtractedAudio && !!boardSource;
  const ambientReady = !!currentProject.audio.ambientPath ||
    (currentProject.audio.subtractionStatus ?? 'idle') === 'done';

  // Pipeline status helpers
  const extractStatus: PipelineStepStatus = hasExtractedAudio
    ? 'done'
    : extracting
      ? 'running'
      : 'pending';

  const subtractStatus: PipelineStepStatus = (currentProject.audio.subtractionStatus ?? 'idle') === 'done'
    ? 'done'
    : subtractRunning
      ? 'running'
      : 'pending';

  const laughterStatus: PipelineStepStatus = (currentProject.audio.laughterStatus ?? 'idle') === 'done'
    ? 'done'
    : laughterRunning
      ? 'running'
      : 'pending';

  const cleanupStatus: PipelineStepStatus = currentProject.audio.cleanupApplied
    ? 'done'
    : 'pending';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Preparación de Audio</h2>
        <p className="text-sm text-muted-foreground">
          Extrae, separa por sustracción guiada, detecta risas y limpia las pistas
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <div className="md:col-span-2 lg:col-span-2 space-y-6">
          {/* Pipeline overview */}
          <PreparationPipeline
            extractStatus={extractStatus}
            extractProgress={extracting ? extractProgress : hasExtractedAudio ? 100 : 0}
            subtractStatus={subtractStatus}
            subtractProgress={subtractRunning ? subtractProgress : (currentProject.audio.subtractionStatus ?? 'idle') === 'done' ? 100 : 0}
            laughterStatus={laughterStatus}
            laughterProgress={laughterRunning ? laughterProgress : (currentProject.audio.laughterStatus ?? 'idle') === 'done' ? 100 : 0}
            cleanupStatus={cleanupStatus}
          />

          {/* Step 1: Extract audio from camera video */}
          {cameraSource && !hasCameraExtracted && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <ArrowDown className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm font-medium">
                    Extraer audio de cámara
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Extraer audio del video de cámara ({cameraSource.originalName})
                  para poder separar voz de ambiente.
                </p>
                {extracting && (
                  <Progress value={extractProgress} className="h-2" />
                )}
                <Button
                  onClick={handleExtractAudio}
                  disabled={extracting}
                >
                  {extracting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Extrayendo... {Math.round(extractProgress)}%
                    </>
                  ) : (
                    <>
                      <Music className="mr-2 h-4 w-4" />
                      Extraer audio de cámara
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Show completed extraction */}
          {hasCameraExtracted && (
            <div className="flex items-center gap-2 text-sm text-green-500 px-1">
              <CheckCircle className="h-4 w-4" />
              Audio de cámara extraído
            </div>
          )}

          {/* Extracted audio tracks */}
          {hasExtractedAudio && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">
                  Pistas de audio extraídas
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {currentProject.audio.extractedTracks.map((track) => {
                    const srcFile = sources.find(
                      (s) => s.id === track.sourceFileId
                    );
                    return (
                      <div
                        key={track.id}
                        className="flex items-center gap-3 rounded-md bg-secondary p-3 text-sm"
                      >
                        <Music className="h-4 w-4 text-green-400" />
                        <div className="flex-1 min-w-0">
                          <p className="truncate">
                            {track.path.split('/').pop()}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            de: {srcFile?.originalName || 'desconocido'} ·{' '}
                            {track.sampleRate}Hz / {track.channels}ch
                          </p>
                        </div>
                        {srcFile?.role === 'camera' && (
                          <span className="rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-400">
                            Cámara
                          </span>
                        )}
                        {srcFile?.role === 'board' && (
                          <span className="rounded bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                            Mesa
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 2: Guided voice subtraction (primary method) */}
          {hasExtractedAudio && (
            <SubtractPanel
              projectId={projectId}
              subtractionStatus={currentProject.audio.subtractionStatus ?? 'idle'}
              hasRequiredAudio={hasRequiredAudio}
              boardSource={boardSource}
              cameraSource={cameraSource}
              cameraTrack={currentProject.audio.extractedTracks.find(
                (t) => cameraSource && t.sourceFileId === cameraSource.id
              )}
              ambientPath={currentProject.audio.ambientPath}
              onComplete={() => fetchProject(projectId)}
              onProgressChange={handleSubtractProgress}
            />
          )}

          {/* Mix preview: board + ambient */}
          {ambientReady && (
            <MixPreviewPanel
              projectId={projectId}
              hasAmbient={ambientReady}
              alignmentOffsetMs={currentProject.audio.alignmentOffsetMs}
            />
          )}

          {/* Step 3: Laughter detection */}
          {ambientReady && (
            <LaughterPanel
              projectId={projectId}
              laughterStatus={currentProject.audio.laughterStatus ?? 'idle'}
              hasAmbientAudio={ambientReady}
              segments={currentProject.audio.laughterSegments ?? []}
              onComplete={() => fetchProject(projectId)}
              onProgressChange={handleLaughterProgress}
            />
          )}

          {/* Volume curve visualization */}
          {(currentProject.audio.volumeCurve ?? []).length > 0 && (
            <VolumeCurvePanel
              volumeCurve={currentProject.audio.volumeCurve ?? []}
              segments={currentProject.audio.laughterSegments ?? []}
            />
          )}

          {/* Step 4: Cleanup ambient audio */}
          {ambientReady && (
            <AudioCleanupPanel
              projectId={projectId}
              cleanupApplied={currentProject.audio.cleanupApplied}
              cameraAmbientPath={currentProject.audio.cameraAmbientPath}
              onComplete={() => fetchProject(projectId)}
            />
          )}

          {/* Generated files manager */}
          {hasExtractedAudio && (
            <AudioFilesPanel
              projectId={projectId}
              onAmbientChanged={() => fetchProject(projectId)}
            />
          )}

          {/* Empty state when no sources */}
          {!hasExtractedAudio && !cameraSource && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                <p className="mb-3">
                  Primero importa archivos y marca un video como Cámara para comenzar.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/project/${projectId}/import`}>
                    <FolderInput className="mr-2 h-4 w-4" />
                    Ir a Importar
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar status */}
        <div>
          <AudioStatusPanel project={currentProject} />
        </div>
      </div>
    </div>
  );
}
