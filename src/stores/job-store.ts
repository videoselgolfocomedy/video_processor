'use client';

import { create } from 'zustand';
import type { Job } from '@/types/jobs';

interface JobStore {
  jobs: Map<string, Job>;
  getJob: (id: string) => Job | undefined;
  getProjectJobs: (projectId: string) => Job[];
  setJob: (job: Job) => void;
  updateJob: (id: string, updates: Partial<Job>) => void;
  removeJob: (id: string) => void;
}

export const useJobStore = create<JobStore>((set, get) => ({
  jobs: new Map(),

  getJob: (id: string) => get().jobs.get(id),

  getProjectJobs: (projectId: string) => {
    const jobs: Job[] = [];
    get().jobs.forEach((job) => {
      if (job.projectId === projectId) jobs.push(job);
    });
    return jobs;
  },

  setJob: (job: Job) =>
    set((state) => {
      const newJobs = new Map(state.jobs);
      newJobs.set(job.id, job);
      return { jobs: newJobs };
    }),

  updateJob: (id: string, updates: Partial<Job>) =>
    set((state) => {
      const existing = state.jobs.get(id);
      if (!existing) return state;
      const newJobs = new Map(state.jobs);
      newJobs.set(id, { ...existing, ...updates });
      return { jobs: newJobs };
    }),

  removeJob: (id: string) =>
    set((state) => {
      const newJobs = new Map(state.jobs);
      newJobs.delete(id);
      return { jobs: newJobs };
    }),
}));
