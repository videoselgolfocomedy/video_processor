'use client';

import { CheckCircle, Clock, Loader2, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ProjectState } from '@/types/project';

interface AudioStatusPanelProps {
  project: ProjectState;
}

type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'idle' | 'syncing';

interface PipelineStep {
  label: string;
  status: StepStatus;
  detail?: string;
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'done':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'running':
    case 'syncing':
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    case 'error':
      return <AlertCircle className="h-4 w-4 text-destructive" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

export function AudioStatusPanel({ project }: AudioStatusPanelProps) {
  const boardSource = project.sources.find((s) => s.role === 'board');
  const cameraSource = project.sources.find(
    (s) => s.role === 'camera' && s.type === 'video'
  );
  const hasCameraExtracted = project.audio.extractedTracks.some(
    (t) => cameraSource && t.sourceFileId === cameraSource.id
  );

  // Determine separation method used/available
  const subtractionDone = (project.audio.subtractionStatus ?? 'idle') === 'done';
  const demucsDone = project.audio.demucsStatus === 'done';

  const steps: PipelineStep[] = [
    {
      label: 'Audio de Mesa',
      status: boardSource ? 'done' : 'pending',
      detail: boardSource
        ? boardSource.originalName
        : 'Sube y marca un audio como Mesa',
    },
    {
      label: 'Video de Cámara',
      status: cameraSource ? 'done' : 'pending',
      detail: cameraSource
        ? cameraSource.originalName
        : 'Sube y marca un video como Cámara',
    },
    {
      label: 'Extracción Audio Cámara',
      status: hasCameraExtracted ? 'done' : 'pending',
      detail: hasCameraExtracted
        ? `${project.audio.extractedTracks.length} pista(s)`
        : 'Extrae el audio del video de cámara',
    },
    {
      label: 'Alineación / Sustracción',
      status: project.audio.subtractionStatus ?? 'idle',
      detail:
        subtractionDone
          ? project.audio.subtractionConfig?.alignOnly
            ? 'Cámara alineada (sin sustracción)'
            : `Ambiente extraído (${project.audio.subtractionConfig?.method || 'spectral'})`
          : (project.audio.subtractionStatus ?? 'idle') === 'running'
            ? 'Procesando...'
            : 'Opcional: alinear y/o sustraer voz',
    },
    {
      label: 'Detección de Risas',
      status: project.audio.laughterStatus ?? 'idle',
      detail:
        (project.audio.laughterStatus ?? 'idle') === 'done'
          ? `${(project.audio.laughterSegments ?? []).length} segmento(s) detectados`
          : (project.audio.laughterStatus ?? 'idle') === 'running'
            ? 'Analizando...'
            : 'Detecta risas y aplausos en ambiente',
    },
    {
      label: 'Amplificación Mesa',
      status: project.audio.amplifyApplied ? 'done' : 'pending',
      detail: project.audio.amplifyApplied
        ? `Mesa amplificada (${project.audio.amplifySettings?.mode || 'loudnorm'})`
        : 'Opcional: normaliza y amplifica mesa',
    },
    {
      label: 'Limpieza de Ambiente',
      status: project.audio.cleanupApplied ? 'done' : 'pending',
      detail: project.audio.cleanupApplied
        ? 'Filtros aplicados'
        : 'Opcional: EQ, compresor, reducción ruido',
    },
    {
      label: 'Mezcla Final',
      status: project.sync.status,
      detail:
        project.sync.status === 'done'
          ? `Mesa ${Math.round((project.sync.boardVolume ?? 1) * 100)}% + Ambiente ${Math.round((project.sync.cameraAmbientVolume ?? 0.7) * 100)}%`
          : project.sync.offsetMs !== undefined
            ? `Offset: ${project.sync.offsetMs}ms`
            : 'Mesa (voz) + Ambiente (cámara)',
    },
  ];

  // Show legacy Demucs step only if it was used
  if (demucsDone && !subtractionDone) {
    steps.splice(3, 0, {
      label: 'Demucs (legacy)',
      status: project.audio.demucsStatus,
      detail: 'Voz + Ambiente separados con Demucs',
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Pipeline de Audio</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-3">
              <StepIcon status={step.status} />
              <div className="flex-1">
                <p className="text-sm">{step.label}</p>
                {step.detail && (
                  <p className="text-xs text-muted-foreground">{step.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
