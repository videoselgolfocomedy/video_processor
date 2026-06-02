'use client';

import { create } from 'zustand';
import type { ProjectState } from '@/types/project';

interface ProjectStore {
  projects: ProjectState[];
  currentProject: ProjectState | null;
  loading: boolean;
  error: string | null;

  fetchProjects: () => Promise<void>;
  fetchProject: (id: string) => Promise<void>;
  createProject: (name: string) => Promise<ProjectState | null>;
  deleteProject: (id: string) => Promise<void>;
  updateCurrentProject: (updates: Partial<ProjectState>) => void;
  setCurrentProject: (project: ProjectState | null) => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  projects: [],
  currentProject: null,
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      set({ projects: data, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  fetchProject: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/projects/${id}`);
      if (!res.ok) throw new Error('Failed to fetch project');
      const data = await res.json();

      // Auto-reconcile media: if the muxed video path is missing or points to
      // a deleted file, this hits an endpoint that scans export/ + audio/ for
      // a hand-copied muxed_*.mp4 and links it. Lets restored projects work
      // from just project.json + a copied muxed file, without re-running mux
      // or needing the original camera/board sources. Silent on success/no-op.
      const muxedPath = data?.sync?.muxedVideoPath;
      const needsReconcile = !muxedPath; // server also handles "set but missing on disk"
      if (needsReconcile) {
        try {
          const recRes = await fetch(`/api/projects/${id}/reconcile-media`, { method: 'POST' });
          if (recRes.ok) {
            const recData = await recRes.json();
            if (recData.updated && recData.sync) {
              data.sync = recData.sync;
              console.log('[project-store] reconcile-media:', recData.messages?.join(' | '));
            }
          }
        } catch (recErr) {
          // Non-fatal — the project will load without the auto-link
          console.warn('[project-store] reconcile-media failed:', (recErr as Error).message);
        }
      }

      set({ currentProject: data, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  createProject: async (name: string) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('Failed to create project');
      const project = await res.json();
      set((state) => ({
        projects: [project, ...state.projects],
        loading: false,
      }));
      return project;
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
      return null;
    }
  },

  deleteProject: async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete project');
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== id),
        currentProject:
          state.currentProject?.id === id ? null : state.currentProject,
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  updateCurrentProject: (updates) => {
    set((state) => {
      if (!state.currentProject) return state;
      return {
        currentProject: { ...state.currentProject, ...updates },
      };
    });
  },

  setCurrentProject: (project) => set({ currentProject: project }),
}));
