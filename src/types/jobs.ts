export type JobType =
  | 'audio-extract'
  | 'demucs'
  | 'voice-subtract'
  | 'laughter-detect'
  | 'audio-cleanup'
  | 'mix-preview'
  | 'audio-sync'
  | 'mux'
  | 'transcribe'
  | 'render';

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: string;
  type: JobType;
  projectId: string;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
}

export interface JobEvent {
  type: 'progress' | 'complete' | 'error' | 'cancelled';
  jobId: string;
  progress?: number;
  message?: string;
  error?: string;
  result?: Record<string, unknown>;
}
