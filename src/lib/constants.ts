import path from 'path';

export const PROJECTS_DIR = path.join(process.cwd(), 'projects');
export const INBOX_DIR = path.join(process.cwd(), 'inbox');

export const PROJECT_DIRS = {
  source: 'source',
  audio: 'audio',
  transcription: 'transcription',
  export: 'export',
  compose: 'compose',
} as const;

export const AUDIO_DEFAULTS = {
  sampleRate: 48000,
  bitDepth: 16,
  channels: 1,
  format: 'wav' as const,
};

export const SYNC_SAMPLE_RATE = 8000;

export const WHISPER_MODELS = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v3',
] as const;

export const DEFAULT_WHISPER_MODEL = 'medium';

export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
export const SUPPORTED_AUDIO_EXTENSIONS = ['.wav', '.mp3', '.aac', '.flac', '.ogg', '.m4a'];
export const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
export const SUPPORTED_EXTENSIONS = [...SUPPORTED_VIDEO_EXTENSIONS, ...SUPPORTED_AUDIO_EXTENSIONS];
export const SUPPORTED_COMPOSE_EXTENSIONS = [...SUPPORTED_VIDEO_EXTENSIONS, ...SUPPORTED_AUDIO_EXTENSIONS, ...SUPPORTED_IMAGE_EXTENSIONS];

export const MAX_UPLOAD_SIZE = 30 * 1024 * 1024 * 1024; // 30GB
