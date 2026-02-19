'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { Sidebar } from '@/components/layout/sidebar';
import { NotificationCenter } from '@/components/layout/notification-center';
import { useProjectStore } from '@/stores/project-store';

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const projectId = params.id as string;
  const { fetchProject, currentProject } = useProjectStore();

  useEffect(() => {
    fetchProject(projectId);
  }, [projectId, fetchProject]);

  return (
    <div className="flex h-screen flex-col">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar projectId={projectId} />
        <main className="flex-1 overflow-y-auto p-3 sm:p-6">
          {currentProject ? (
            children
          ) : (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              Loading project...
            </div>
          )}
        </main>
      </div>
      <NotificationCenter />
    </div>
  );
}
