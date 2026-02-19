import { v4 as uuidv4 } from 'uuid';
import type { Job, JobType, JobEvent } from '@/types/jobs';
import type { ChildProcess } from 'child_process';

type JobListener = (event: JobEvent) => void;

interface ManagedJob {
  job: Job;
  process?: ChildProcess;
  listeners: Set<JobListener>;
}

class JobManager {
  private jobs = new Map<string, ManagedJob>();

  createJob(projectId: string, type: JobType): Job {
    const job: Job = {
      id: uuidv4(),
      type,
      projectId,
      status: 'pending',
      progress: 0,
      message: 'Waiting...',
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, { job, listeners: new Set() });
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  getProjectJobs(projectId: string): Job[] {
    const result: Job[] = [];
    this.jobs.forEach((managed) => {
      if (managed.job.projectId === projectId) {
        result.push(managed.job);
      }
    });
    return result;
  }

  setProcess(jobId: string, process: ChildProcess) {
    const managed = this.jobs.get(jobId);
    if (managed) {
      managed.process = process;
    }
  }

  startJob(jobId: string) {
    this.updateJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  }

  updateProgress(jobId: string, progress: number, message?: string) {
    const managed = this.jobs.get(jobId);
    if (!managed) return;

    managed.job.progress = progress;
    if (message) managed.job.message = message;

    this.notify(jobId, {
      type: 'progress',
      jobId,
      progress,
      message: message || managed.job.message,
    });
  }

  completeJob(jobId: string, result?: Record<string, unknown>) {
    this.updateJob(jobId, {
      status: 'done',
      progress: 100,
      message: 'Complete',
      completedAt: new Date().toISOString(),
      result,
    });

    this.notify(jobId, {
      type: 'complete',
      jobId,
      progress: 100,
      result,
    });
  }

  failJob(jobId: string, error: string) {
    this.updateJob(jobId, {
      status: 'error',
      message: error,
      error,
      completedAt: new Date().toISOString(),
    });

    this.notify(jobId, {
      type: 'error',
      jobId,
      error,
    });
  }

  cancelJob(jobId: string) {
    const managed = this.jobs.get(jobId);
    if (!managed) return;

    if (managed.process) {
      managed.process.kill('SIGTERM');
    }

    this.updateJob(jobId, {
      status: 'cancelled',
      message: 'Cancelled',
      completedAt: new Date().toISOString(),
    });

    this.notify(jobId, {
      type: 'cancelled',
      jobId,
    });
  }

  subscribe(jobId: string, listener: JobListener): () => void {
    const managed = this.jobs.get(jobId);
    if (!managed) return () => {};

    managed.listeners.add(listener);
    return () => {
      managed.listeners.delete(listener);
    };
  }

  private updateJob(jobId: string, updates: Partial<Job>) {
    const managed = this.jobs.get(jobId);
    if (!managed) return;
    Object.assign(managed.job, updates);
  }

  private notify(jobId: string, event: JobEvent) {
    const managed = this.jobs.get(jobId);
    if (!managed) return;
    managed.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    });
  }
}

// Singleton — survive Next.js hot reload in dev
const globalForJobs = globalThis as unknown as { __jobManager?: JobManager };
export const jobManager = globalForJobs.__jobManager ?? new JobManager();
globalForJobs.__jobManager = jobManager;
