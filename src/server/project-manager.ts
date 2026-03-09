import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PROJECTS_DIR, PROJECT_DIRS } from '@/lib/constants';
import { slugify } from '@/lib/utils';
import type { ProjectState, AudioState, SyncState, TranscriptionState, CompositionState, YouTubeSubtitleConfig, SubtitleStyle } from '@/types/project';
import { jobManager } from '@/server/job-manager';

const defaultAudioState: AudioState = {
  extractedTracks: [],
  demucsStatus: 'idle',
  subtractionStatus: 'idle',
  laughterStatus: 'idle',
  laughterSegments: [],
  volumeCurve: [],
  cleanupApplied: false,
};

const defaultSyncState: SyncState = {
  status: 'idle',
  boardVolume: 1,
  cameraAmbientVolume: 0.7,
};

const defaultCompositionState: CompositionState = {
  tracks: [
    { id: 'v1', type: 'video', label: 'Main Video', locked: true, muted: false, visible: true },
    { id: 'v2', type: 'video', label: 'Cutaways/Overlays', locked: false, muted: false, visible: true },
    { id: 'a1', type: 'audio', label: 'Main Audio', locked: true, muted: false, visible: true },
    { id: 'a2', type: 'audio', label: 'Extra Audio', locked: false, muted: false, visible: true },
    { id: 's1', type: 'subtitle', label: 'Subtitles', locked: false, muted: false, visible: true },
  ],
  clips: [],
  mediaBin: [],
};

const defaultTranscriptionState: TranscriptionState = {
  status: 'idle',
  language: 'auto',
  model: 'medium',
  segments: [],
  constraints: { maxCharsPerBlock: 80, maxDurationMs: 7000 },
};

const defaultSubtitleStyle: SubtitleStyle = {
  fontFamily: 'Inter',
  fontSize: 48,
  fontWeight: 700,
  color: '#FFFFFF',
  strokeColor: '#000000',
  strokeWidth: 3,
  backgroundColor: 'transparent',
  backgroundPadding: 8,
  backgroundRadius: 4,
  position: 'bottom',
  marginBottom: 80,
  animation: 'none',
  highlightColor: '#FFD700',
  textTransform: 'none',
  maxWidth: 900,
  lineHeight: 1.3,
  shadowColor: 'rgba(0,0,0,0.8)',
  shadowBlur: 8,
  shadowOffsetX: 2,
  shadowOffsetY: 2,
};

const defaultYoutubeSubtitles: YouTubeSubtitleConfig = {
  style: { ...defaultSubtitleStyle },
  stylePreset: 'youtube-classic',
};

async function ensureProjectsDir() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

function projectPath(id: string) {
  return path.join(PROJECTS_DIR, id);
}

function projectJsonPath(id: string) {
  return path.join(projectPath(id), 'project.json');
}

export async function listProjects(): Promise<ProjectState[]> {
  await ensureProjectsDir();
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects: ProjectState[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const jsonPath = path.join(PROJECTS_DIR, entry.name, 'project.json');
      const data = await fs.readFile(jsonPath, 'utf-8');
      const project = migrateProject(JSON.parse(data));
      projects.push(project);
    } catch {
      // Skip invalid project directories
    }
  }

  return projects.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function createProject(name: string): Promise<ProjectState> {
  await ensureProjectsDir();

  const id = uuidv4();
  const slug = slugify(name);
  const now = new Date().toISOString();

  const project: ProjectState = {
    id,
    name,
    slug,
    createdAt: now,
    updatedAt: now,
    sources: [],
    audio: { ...defaultAudioState },
    sync: { ...defaultSyncState },
    transcription: { ...defaultTranscriptionState },
    youtubeSubtitles: { ...defaultYoutubeSubtitles, style: { ...defaultYoutubeSubtitles.style } },
    exports: [],
    composition: { ...defaultCompositionState, tracks: defaultCompositionState.tracks.map(t => ({ ...t })) },
    reels: [],
  };

  const dir = projectPath(id);
  await fs.mkdir(dir, { recursive: true });

  // Create subdirectories
  for (const subdir of Object.values(PROJECT_DIRS)) {
    await fs.mkdir(path.join(dir, subdir), { recursive: true });
  }

  await fs.writeFile(projectJsonPath(id), JSON.stringify(project, null, 2));
  return project;
}

/**
 * Recover stale "running" states from jobs that died (e.g. server restart).
 * If project.json says a job is "running" but no matching job exists in memory,
 * reset the status back to its previous state.
 */
function recoverStaleJobs(project: ProjectState): ProjectState | null {
  let changed = false;
  const audio = { ...project.audio };

  if (audio.demucsStatus === 'running' && audio.demucsJobId) {
    const job = jobManager.getJob(audio.demucsJobId);
    if (!job || job.status === 'error' || job.status === 'cancelled') {
      audio.demucsStatus = 'idle';
      delete audio.demucsJobId;
      delete audio.demucsSourceId;
      changed = true;
    }
  }

  if (audio.subtractionStatus === 'running' && audio.subtractionJobId) {
    const job = jobManager.getJob(audio.subtractionJobId);
    if (!job || job.status === 'error' || job.status === 'cancelled') {
      audio.subtractionStatus = 'idle';
      delete audio.subtractionJobId;
      changed = true;
    }
  }

  if (audio.laughterStatus === 'running' && audio.laughterJobId) {
    const job = jobManager.getJob(audio.laughterJobId);
    if (!job || job.status === 'error' || job.status === 'cancelled') {
      audio.laughterStatus = 'idle';
      delete audio.laughterJobId;
      changed = true;
    }
  }

  if (!changed) return null;
  return { ...project, audio };
}

/** Backfill new fields for projects created before schema additions. */
function migrateProject(project: ProjectState): ProjectState {
  let changed = false;
  const audio = { ...project.audio };
  const sync = { ...project.sync };

  // Audio: new subtraction/laughter fields
  if (audio.subtractionStatus === undefined) {
    audio.subtractionStatus = 'idle';
    changed = true;
  }
  if (audio.laughterStatus === undefined) {
    audio.laughterStatus = 'idle';
    changed = true;
  }
  if (!Array.isArray(audio.laughterSegments)) {
    audio.laughterSegments = [];
    changed = true;
  }
  if (!Array.isArray(audio.volumeCurve)) {
    audio.volumeCurve = [];
    changed = true;
  }

  // Transcription: ensure constraints exist
  const transcription = { ...project.transcription };
  if (!transcription.constraints) {
    transcription.constraints = { maxCharsPerBlock: 80, maxDurationMs: 7000 };
    changed = true;
  }

  // Sync: rename old voiceVolume/ambientVolume → boardVolume/cameraAmbientVolume
  const syncAny = sync as Record<string, unknown>;
  if (sync.boardVolume === undefined && syncAny.voiceVolume !== undefined) {
    sync.boardVolume = syncAny.voiceVolume as number;
    delete syncAny.voiceVolume;
    changed = true;
  } else if (sync.boardVolume === undefined) {
    sync.boardVolume = 1;
    changed = true;
  }
  if (sync.cameraAmbientVolume === undefined && syncAny.ambientVolume !== undefined) {
    sync.cameraAmbientVolume = syncAny.ambientVolume as number;
    delete syncAny.ambientVolume;
    changed = true;
  } else if (sync.cameraAmbientVolume === undefined) {
    sync.cameraAmbientVolume = 0.7;
    changed = true;
  }

  // Composition: ensure it exists
  let composition = project.composition;
  if (!composition) {
    composition = { ...defaultCompositionState, tracks: defaultCompositionState.tracks.map(t => ({ ...t })) };
    changed = true;
  }

  // YouTubeSubtitles: migrate from transcription.style if needed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projectAny = project as any;
  let youtubeSubtitles = projectAny.youtubeSubtitles as ProjectState['youtubeSubtitles'] | undefined;
  if (!youtubeSubtitles) {
    const oldStyle = transcription.style;
    const oldPreset = transcription.stylePreset;
    youtubeSubtitles = {
      style: oldStyle ?? { ...defaultSubtitleStyle },
      stylePreset: oldPreset ?? 'youtube-classic',
    };
    changed = true;
  }

  // Clean deprecated style/stylePreset from transcription
  if (transcription.style !== undefined) {
    delete transcription.style;
    delete transcription.stylePreset;
    changed = true;
  }

  // Reels: migrate from old reelSettings if needed
  let reels = projectAny.reels as ProjectState['reels'] | undefined;
  if (!reels) {
    reels = [];
    const oldReelSettings = project.reelSettings;
    if (oldReelSettings) {
      reels.push({
        id: uuidv4(),
        name: 'Reel 1 (migrated)',
        createdAt: project.createdAt,
        startMs: 0,
        endMs: (project.sources[0]?.duration ?? 0) * 1000,
        cropRegion: oldReelSettings.cropRegion ?? { centerX: 0.5, centerY: 0.5, scale: 1.0 },
        composition: { tracks: [], clips: [], mediaBin: [] },
        subtitleStyle: oldReelSettings.subtitleStyle,
        subtitleStylePreset: oldReelSettings.subtitleStylePreset,
        subtitleConstraints: oldReelSettings.subtitleConstraints,
        subtitleSegments: oldReelSettings.reelSubtitleSegments ?? [],
        punchlineSegmentIds: [],
      });
    }
    changed = true;
  }

  // Exports: ensure targetType exists on all records
  let exports = project.exports;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const needsExportMigration = exports?.some((e) => !(e as any).targetType);
  if (needsExportMigration) {
    exports = exports.map((e) => ({
      ...e,
      targetType: e.targetType ?? 'youtube' as const,
    }));
    changed = true;
  }

  return changed ? { ...project, audio, sync, transcription, composition, youtubeSubtitles, reels, exports } : project;
}

export async function getProject(id: string): Promise<ProjectState | null> {
  try {
    const data = await fs.readFile(projectJsonPath(id), 'utf-8');
    let project: ProjectState = JSON.parse(data);

    // Backfill new fields for old projects
    project = migrateProject(project);

    // Auto-recover stale running states
    const recovered = recoverStaleJobs(project);
    if (recovered) {
      await fs.writeFile(projectJsonPath(id), JSON.stringify(recovered, null, 2));
      return recovered;
    }

    return project;
  } catch {
    return null;
  }
}

export async function updateProject(
  id: string,
  updates: Partial<ProjectState>
): Promise<ProjectState | null> {
  const project = await getProject(id);
  if (!project) return null;

  const updated = {
    ...project,
    ...updates,
    id: project.id, // Prevent id change
    createdAt: project.createdAt, // Prevent createdAt change
    updatedAt: new Date().toISOString(),
  };

  await fs.writeFile(projectJsonPath(id), JSON.stringify(updated, null, 2));
  return updated;
}

export async function deleteProject(id: string): Promise<boolean> {
  try {
    await fs.rm(projectPath(id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function getProjectDir(id: string, subdir?: keyof typeof PROJECT_DIRS): string {
  if (subdir) {
    return path.join(projectPath(id), PROJECT_DIRS[subdir]);
  }
  return projectPath(id);
}
