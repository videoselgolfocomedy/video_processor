'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, FolderOpen } from 'lucide-react';
import { useProjectStore } from '@/stores/project-store';
import { ProjectCard } from './project-card';
import { CreateProjectDialog } from './create-project-dialog';
import { useToast } from '@/hooks/use-toast';

export function ProjectList() {
  const { projects, loading, fetchProjects, createProject, deleteProject } =
    useProjectStore();
  const router = useRouter();
  const { toast } = useToast();

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
        <CreateProjectDialog onCreate={handleCreate} />
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
    </div>
  );
}
