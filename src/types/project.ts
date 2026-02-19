export interface ProjectState {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  // Source files
  sources: SourceFile[];
  // Audio pipeline state
  audio: AudioState;
  // Sync state
  sync: SyncState;
  // Transcription state
  transcription: TranscriptionState;
  // Export state
  exports: ExportRecord[];
  // Composition timeline
  composition: CompositionState;
}

export interface SourceFile {
  id: string;
  originalName: string;
  storedName: string;
  type: 'video' | 'audio' | 'image';
  role: 'camera' | 'board' | 'other';
  size: number;
  duration?: number;
  codec?: string;
  resolution?: { width: number; height: number };
  addedAt: string;
}

export interface AudioState {
  extractedTracks: AudioTrack[];
  // Demucs runs on camera audio to separate voice from ambient (legacy)
  demucsStatus: 'idle' | 'running' | 'done' | 'error';
  demucsJobId?: string;
  demucsSourceId?: string; // which source file was processed
  stems?: {
    vocals: string;   // voice extracted from camera (not used in final mix)
    other: string;    // ambient/room sound from camera (used in final mix)
    bass?: string;
    drums?: string;
  };
  // Guided voice subtraction (preferred over Demucs)
  subtractionStatus: 'idle' | 'running' | 'done' | 'error';
  subtractionJobId?: string;
  subtractionConfig?: VoiceSubtractionConfig;
  ambientPath?: string; // output of subtraction: ambient audio
  alignmentOffsetMs?: number; // offset found by cross-correlation (ms)
  // Laughter/reaction detection
  laughterStatus: 'idle' | 'running' | 'done' | 'error';
  laughterJobId?: string;
  laughterSegments: LaughterSegment[];
  laughterConfig?: LaughterDetectionConfig;
  volumeCurve: VolumeCurvePoint[];
  // Board audio path (the clean desk audio used as main voice)
  boardAudioPath?: string;
  // Camera ambient path (after optional cleanup)
  cameraAmbientPath?: string;
  cleanupApplied: boolean;
  cleanupSettings?: AudioCleanupSettings;
}

export interface VoiceSubtractionConfig {
  method: 'spectral' | 'nlms';
  alpha: number;         // over-subtraction factor (spectral, default 2.0)
  floor: number;         // spectral floor (spectral, default 0.01)
  filterLength: number;  // NLMS filter length (default 2048)
  mu: number;            // NLMS step size (default 0.5)
}

export interface LaughterSegment {
  id: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  peakEnergy: number;
  avgEnergy: number;
  label: 'laugh' | 'applause' | 'reaction';
}

export interface LaughterDetectionConfig {
  threshold: number;      // energy threshold factor over median (default 2.0)
  minDurationMs: number;  // minimum segment duration (default 300)
  mergeGapMs: number;     // merge segments closer than this (default 500)
  windowMs: number;       // analysis window size (default 50)
}

export interface VolumeCurvePoint {
  timeMs: number;
  volume: number; // multiplier, 1.0 = normal
}

export interface AudioTrack {
  id: string;
  sourceFileId: string;
  path: string;
  sampleRate: number;
  channels: number;
  duration: number;
}

export interface AudioCleanupSettings {
  eqFrequency: number;
  eqGain: number;
  eqWidth: number;
  compressorThreshold: number;
  compressorRatio: number;
  limiterLevel: number;
  noiseReduction: number;
  noiseFloor: number;
}

export interface SyncState {
  status: 'idle' | 'syncing' | 'done' | 'error';
  offsetMs?: number;
  confidence?: number;
  referenceTrackId?: string; // board audio (reference)
  alignTrackId?: string;     // camera audio (to align)
  mixedAudioPath?: string;
  muxedVideoPath?: string;   // video with replaced audio track
  selectedAudioPath?: string; // audio file chosen for mux (used as transcription source)
  // Mix volumes: board = clean voice from desk, ambient = room sound from camera
  boardVolume: number;
  cameraAmbientVolume: number;
}

export interface TranscriptionState {
  status: 'idle' | 'running' | 'done' | 'error';
  jobId?: string;
  language: string;
  model: string;
  segments: SubtitleSegment[];
  style: SubtitleStyle;
  stylePreset: string;
  constraints: SubtitleConstraints;
}

export interface SubtitleConstraints {
  maxCharsPerBlock: number;
  maxDurationMs: number;
}

export interface SubtitleSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words?: SubtitleWord[];
}

export interface SubtitleWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  backgroundColor: string;
  backgroundPadding: number;
  backgroundRadius: number;
  position: 'bottom' | 'center' | 'top';
  marginBottom: number;
  animation: 'none' | 'fade' | 'typewriter' | 'word-highlight' | 'pop';
  highlightColor: string;
  textTransform: 'none' | 'uppercase' | 'lowercase';
  maxWidth: number;
  lineHeight: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

export interface ExportPreset {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  fps: number;
  codec: 'h264' | 'h265';
  crf: number;
  audioBitrate: string;
  orientation: 'horizontal' | 'vertical';
}

export interface ExportRecord {
  id: string;
  presetId: string;
  status: 'queued' | 'rendering' | 'done' | 'error';
  jobId?: string;
  outputPath?: string;
  startedAt?: string;
  completedAt?: string;
  progress?: number;
  error?: string;
}

// --- Composition Timeline ---

export interface CompositionClip {
  id: string;
  type: 'video' | 'image' | 'audio';
  fileName: string;
  originalName: string;
  trackId: string;
  timelineStartMs: number;
  timelineEndMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  mode?: 'cutaway' | 'overlay';
  overlay?: OverlayPosition;
  volume?: number;
  opacity?: number;
}

export interface OverlayPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositionTrack {
  id: string;
  type: 'video' | 'audio' | 'subtitle';
  label: string;
  locked: boolean;
  muted: boolean;
  visible: boolean;
}

export interface MediaBinAsset {
  id: string;
  fileName: string;
  originalName: string;
  type: 'video' | 'image' | 'audio';
  duration?: number;
  resolution?: { width: number; height: number };
}

export interface CompositionState {
  tracks: CompositionTrack[];
  clips: CompositionClip[];
  mediaBin: MediaBinAsset[];
}
