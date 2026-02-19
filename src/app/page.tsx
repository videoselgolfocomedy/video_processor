import { Header } from '@/components/layout/header';
import { ProjectList } from '@/components/projects/project-list';
import { WorkflowGuide } from '@/components/layout/workflow-guide';

export default function DashboardPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 p-6 space-y-8">
        <ProjectList />
        <WorkflowGuide />
      </main>
    </div>
  );
}
