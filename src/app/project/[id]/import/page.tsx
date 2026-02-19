'use client';

import { useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { useUpload } from '@/hooks/use-upload';
import { FileUploader } from '@/components/upload/file-uploader';
import { InboxPanel } from '@/components/upload/inbox-panel';
import { AudioStatusPanel } from '@/components/audio/audio-status-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { formatFileSize, formatDuration } from '@/lib/utils';
import {
  FileVideo,
  FileAudio,
  Trash2,
  Camera,
  Radio,
  HelpCircle,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import type { SourceFile } from '@/types/project';

function RoleIcon({ role }: { role: string }) {
  switch (role) {
    case 'camera':
      return <Camera className="h-4 w-4 text-blue-400" />;
    case 'board':
      return <Radio className="h-4 w-4 text-green-400" />;
    default:
      return <HelpCircle className="h-4 w-4 text-muted-foreground" />;
  }
}

function SourceFileRow({
  source,
  projectId,
  onUpdate,
}: {
  source: SourceFile;
  projectId: string;
  onUpdate: () => void;
}) {
  const { toast } = useToast();

  const changeRole = async (newRole: string) => {
    const res = await fetch(
      `/api/projects/${projectId}/sources/${source.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      }
    );
    if (res.ok) {
      onUpdate();
      toast({ title: `Cambiado a ${newRole === 'camera' ? 'Cámara' : newRole === 'board' ? 'Mesa' : 'Otro'}` });
    }
  };

  const remove = async () => {
    if (!confirm(`¿Eliminar ${source.originalName}?`)) return;
    const res = await fetch(
      `/api/projects/${projectId}/sources/${source.id}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      onUpdate();
      toast({ title: 'Archivo eliminado' });
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-md bg-secondary p-3">
      {source.type === 'video' ? (
        <FileVideo className="h-4 w-4 flex-none text-blue-400" />
      ) : (
        <FileAudio className="h-4 w-4 flex-none text-green-400" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{source.originalName}</p>
        <p className="text-xs text-muted-foreground">
          {formatFileSize(source.size)}
          {source.duration ? ` · ${formatDuration(source.duration * 1000)}` : ''}
          {source.resolution
            ? ` · ${source.resolution.width}x${source.resolution.height}`
            : ''}
        </p>
      </div>

      {/* Role selector */}
      <div className="flex items-center gap-1">
        {(['camera', 'board', 'other'] as const).map((r) => (
          <button
            key={r}
            onClick={() => changeRole(r)}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
              source.role === r
                ? r === 'camera'
                  ? 'bg-blue-500/20 text-blue-400'
                  : r === 'board'
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-muted text-muted-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
            title={
              r === 'camera'
                ? 'Video con audio de cámara'
                : r === 'board'
                  ? 'Audio de mesa (voz limpia)'
                  : 'Otro'
            }
          >
            <RoleIcon role={r} />
            {r === 'camera' ? 'Cámara' : r === 'board' ? 'Mesa' : 'Otro'}
          </button>
        ))}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-none text-destructive"
        onClick={remove}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export default function ImportPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject } = useProjectStore();
  const {
    uploading,
    progress: uploadProgress,
    error: uploadError,
    upload,
  } = useUpload(projectId);
  const { toast } = useToast();

  const handleUpload = useCallback(
    async (files: File[], role: 'camera' | 'board' | 'other') => {
      const success = await upload(files, role);
      if (success) {
        await fetchProject(projectId);
        toast({ title: 'Archivos subidos' });
      }
      return success;
    },
    [upload, fetchProject, projectId, toast]
  );

  if (!currentProject) return null;

  const sources = currentProject.sources;
  const cameraSource = sources.find(
    (s) => s.role === 'camera' && s.type === 'video'
  );
  const boardSource = sources.find((s) => s.role === 'board');
  const hasBothSources = !!cameraSource && !!boardSource;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Importación de Recursos</h2>
        <p className="text-sm text-muted-foreground">
          Sube video de cámara + audio de mesa, asigna roles a los archivos
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <div className="md:col-span-2 lg:col-span-2 space-y-6">
          {/* Workflow guide */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="pt-4">
              <p className="text-xs font-medium text-primary mb-2">
                Flujo de trabajo
              </p>
              <ol className="space-y-1 text-xs text-muted-foreground">
                <li className="flex items-start gap-2">
                  <span className={`font-mono font-bold ${boardSource ? 'text-green-500' : 'text-primary'}`}>1.</span>
                  Sube el <strong>audio de mesa</strong> (pista limpia del mixer) y márcalo como <span className="text-green-400">Mesa</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className={`font-mono font-bold ${cameraSource ? 'text-green-500' : 'text-primary'}`}>2.</span>
                  Sube el <strong>video con audio de cámara</strong> y márcalo como <span className="text-blue-400">Cámara</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className={`font-mono font-bold ${currentProject.audio.extractedTracks.length > 0 ? 'text-green-500' : ''}`}>3.</span>
                  <strong>Extrae</strong> el audio del video de cámara
                </li>
                <li className="flex items-start gap-2">
                  <span className={`font-mono font-bold ${currentProject.audio.demucsStatus === 'done' ? 'text-green-500' : ''}`}>4.</span>
                  <strong>Demucs</strong> separa el audio de cámara en voz + ambiente
                </li>
                <li className="flex items-start gap-2">
                  <span className="">5.</span>
                  Opcionalmente <strong>limpia</strong> el ambiente (reducir ruido, EQ)
                </li>
                <li className="flex items-start gap-2">
                  <span className="">6.</span>
                  En <strong>Sync</strong>: sincroniza mesa con cámara, ajusta mezcla = <span className="text-green-400">Mesa</span> + <span className="text-blue-400">Ambiente cámara</span>
                </li>
              </ol>
            </CardContent>
          </Card>

          {/* Upload */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Subir archivos fuente
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FileUploader
                onUpload={handleUpload}
                uploading={uploading}
                progress={uploadProgress}
                error={uploadError}
              />
            </CardContent>
          </Card>

          {/* Import from server inbox */}
          <InboxPanel
            projectId={projectId}
            onImported={() => fetchProject(projectId)}
          />

          {/* Source file list with role editing */}
          {sources.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">
                  Archivos fuente ({sources.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {sources.map((source) => (
                    <SourceFileRow
                      key={source.id}
                      source={source}
                      projectId={projectId}
                      onUpdate={() => fetchProject(projectId)}
                    />
                  ))}
                </div>

                {/* Warnings */}
                {!boardSource && sources.length > 0 && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-yellow-500">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Marca un archivo como <strong>Mesa</strong> (audio del mixer)
                  </div>
                )}
                {!cameraSource && sources.length > 0 && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-yellow-500">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Marca un video como <strong>Cámara</strong>
                  </div>
                )}
                {hasBothSources && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-green-500">
                    <CheckCircle className="h-3.5 w-3.5" />
                    Mesa + Cámara configurados
                  </div>
                )}
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
