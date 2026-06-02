'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, FolderOpen, Upload, Film } from 'lucide-react';
import { useProjectStore } from '@/stores/project-store';
import { ProjectCard } from './project-card';
import { CreateProjectDialog } from './create-project-dialog';
import { RestoreMissingFilesDialog, type CopyTarget } from './restore-missing-files-dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

export function ProjectList() {
  const { projects, loading, fetchProjects, createProject, deleteProject } =
    useProjectStore();
  const router = useRouter();
  const { toast } = useToast();
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const muxedInputRef = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoringMuxed, setRestoringMuxed] = useState(false);
  const [restoreReport, setRestoreReport] = useState<{
    open: boolean;
    projectId: string;
    projectName: string;
    projectDir?: string;
    requiredFiles: CopyTarget[];
    recommendedFiles: CopyTarget[];
    regenerableFiles: CopyTarget[];
  } | null>(null);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  async function handleCreate(name: string) {
    const project = await createProject(name);
    if (project) {
      toast({ title: 'Proyecto creado', description: project.name });
      router.push(`/project/${project.id}`);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this project?')) return;
    await deleteProject(id);
    toast({ title: 'Proyecto eliminado' });
  }

  // Restore a project from JUST a muxed video file. Creates a new project
  // shell, copies the muxed to export/, probes for duration, and lets the
  // user start editing right away (transcribe → compose → reels → export).
  // No source camera/board files needed.
  async function handleRestoreFromMuxed(file: File) {
    setRestoringMuxed(true);
    const sizeGb = (file.size / 1024 ** 3).toFixed(2);
    toast({
      title: 'Importando muxed…',
      description: `Copiando ${file.name} (${sizeGb} GB). Para archivos grandes puede tardar varios minutos.`,
    });
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/projects/restore-from-muxed', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      await fetchProjects();
      toast({
        title: `Proyecto creado: ${data.projectName}`,
        description: data.message || 'Listo para editar',
      });
      router.push(`/project/${data.projectId}`);
    } catch (err) {
      toast({ title: 'Error al importar muxed', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setRestoringMuxed(false);
      if (muxedInputRef.current) muxedInputRef.current.value = '';
    }
  }

  async function handleRestore(file: File) {
    setRestoring(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/projects/restore', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const requiredFiles: CopyTarget[] = data.requiredFiles ?? [];
      const recommendedFiles: CopyTarget[] = data.recommendedFiles ?? [];
      const regenerableFiles: CopyTarget[] = data.regenerableFiles ?? [];
      const total = requiredFiles.length + recommendedFiles.length + regenerableFiles.length;

      fetchProjects();

      if (total > 0) {
        // Show the missing-files modal so the user can see exactly what to copy
        // and where. Modal handles routing to the project itself (Open button).
        setRestoreReport({
          open: true,
          projectId: data.projectId,
          projectName: data.projectName,
          projectDir: data.projectDir,
          requiredFiles,
          recommendedFiles,
          regenerableFiles,
        });
      } else {
        toast({ title: `Proyecto restaurado: ${data.projectName}`, description: 'Restauración completa' });
        router.push(`/project/${data.projectId}`);
      }
    } catch (err) {
      toast({ title: 'Error al restaurar', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setRestoring(false);
      if (restoreInputRef.current) restoreInputRef.current.value = '';
    }
  }

  if (loading && projects.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Proyectos</h2>
          <p className="text-sm text-muted-foreground">
            {projects.length} {projects.length === 1 ? 'proyecto' : 'proyectos'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={restoring || restoringMuxed}
            onClick={() => restoreInputRef.current?.click()}
            title="Restaura un proyecto desde un .zip de backup (project.json + estilos + fonts)"
          >
            {restoring ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-4 w-4" />
            )}
            Restaurar backup
          </Button>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleRestore(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={restoring || restoringMuxed}
            onClick={() => muxedInputRef.current?.click()}
            title="Crea un proyecto a partir de un muxed_*.mp4/.mov suelto, sin necesitar las fuentes originales. Listo para transcribir + componer + exportar."
          >
            {restoringMuxed ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Film className="mr-1.5 h-4 w-4" />
            )}
            Importar muxed
          </Button>
          <input
            ref={muxedInputRef}
            type="file"
            accept=".mp4,.mov,video/mp4,video/quicktime"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleRestoreFromMuxed(file);
            }}
          />
          <CreateProjectDialog onCreate={handleCreate} />
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-20">
          <FolderOpen className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <p className="text-muted-foreground">No hay proyectos</p>
          <p className="text-sm text-muted-foreground/70">
            Crea uno nuevo para empezar
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {restoreReport && (
        <RestoreMissingFilesDialog
          open={restoreReport.open}
          onOpenChange={(open) => setRestoreReport(open ? restoreReport : null)}
          projectId={restoreReport.projectId}
          projectName={restoreReport.projectName}
          projectDir={restoreReport.projectDir}
          requiredFiles={restoreReport.requiredFiles}
          recommendedFiles={restoreReport.recommendedFiles}
          regenerableFiles={restoreReport.regenerableFiles}
          onContinue={() => router.push(`/project/${restoreReport.projectId}`)}
        />
      )}
    </div>
  );
}
