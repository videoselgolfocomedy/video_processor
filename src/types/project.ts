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
  // Transcription state (text + timing only, no formatting)
  transcription: TranscriptionState;
  // YouTube subtitle formatting (separate from transcription)
  youtubeSubtitles: YouTubeSubtitleConfig;
  // Export state
  exports: ExportRecord[];
  // Composition timeline (YouTube 16:9)
  composition: CompositionState;
  // Reels (9:16) — each with own timeline, crop, subtitles
  reels: ReelDefinition[];
  // Punchline detection hints
  punchlineHints?: PunchlineHint[];
  // AI-identified comedy bits from reinterpretation
  bits?: BitDefinition[];
  // Custom subtitle style presets (persisted per-project, not in localStorage)
  customStylePresets?: CustomStylePreset[];
  // DEPRECATED: old single reel settings (kept for migration only)
  reelSettings?: ReelSettings;
}

export interface CropRegion {
  centerX: number;  // 0-1, crop center in source (default 0.5)
  centerY: number;  // 0-1 (default 0.5)
  scale: number;    // 0.1-1.0, 1.0 = full source height visible (default 1.0)
}

/** @deprecated Use ReelDefinition[] instead. Kept for migration only. */
export interface ReelSettings {
  cropRegion: CropRegion;
  videoPositionY?: number;
  subtitleStyle: SubtitleStyle;
  subtitleStylePreset: string;
  subtitleConstraints: SubtitleConstraints;
  reelSubtitleSegments?: SubtitleSegment[];
}

export interface YouTubeSubtitleConfig {
  style: SubtitleStyle;
  stylePreset: string;
  segments?: SubtitleSegment[];  // null/undefined = use transcription.segments
}

export interface CustomStylePreset {
  id: string;
  name: string;
  description: string;
  thumbnail: string;
  style: SubtitleStyle;
}

/**
 * One overlay (text or image) inside a saved overlay template. Times are
 * stored RELATIVE to the template's own start (the earliest overlay in the
 * saved set), so a template can be dropped onto any reel at any playhead
 * position and the lines keep their relative timing.
 *
 * Image overlays don't reference a project file directly — the PNG/GIF bytes
 * are copied into a GLOBAL asset store (data/overlay-templates/assets/) keyed
 * by `imageAssetId`, so the template stays valid even if the source project is
 * deleted. On apply, the asset is copied back into the target project.
 */
export interface OverlayTemplateItem {
  type: 'text' | 'image' | 'gif';
  /** ms from the template start (min timelineStartMs across the saved set). */
  startOffsetMs: number;
  durationMs: number;
  /** Which kind of overlay track to place this on when applying. */
  trackKind: 'text' | 'image';
  overlayPosition?: { x: number; y: number; width: number };
  opacity?: number;
  // text-overlay fields
  textContent?: string;
  textStyle?: NonNullable<CompositionClip['textStyle']>;
  // image/gif fields — `imageAssetId` is the filename in the global asset
  // store (e.g. "<uuid>.png"); `originalName` is the user-facing name.
  imageAssetId?: string;
  originalName?: string;
}

/**
 * A reusable overlay template saved to the global library (settings.json),
 * shared across all reels and projects and surviving project deletion.
 * `kind: 'single'` holds one overlay; `kind: 'set'` holds every overlay line
 * captured from a reel at once.
 */
export interface OverlayTemplate {
  id: string;
  name: string;
  createdAt: string;
  kind: 'single' | 'set';
  items: OverlayTemplateItem[];
  /** Timeline duration (ms) of the source reel when the template was saved.
   * Enables anchored apply: items from the first half of the source reel
   * anchor to the target reel's START (keeping their distance from t=0),
   * items from the second half anchor to its END (keeping their distance
   * from the end). Missing on templates saved before this field existed —
   * anchored apply then degrades to placing everything at the start. */
  sourceDurationMs?: number;
  /** Where (ms) the earliest saved overlay sat in the source reel. Item
   * startOffsetMs values are relative to this point. */
  sourceFirstStartMs?: number;
}

export interface ReelVersion {
  id: string;
  label: string;
  createdAt: string;
  clips: CompositionClip[];
  subtitleSegments: SubtitleSegment[];
  subtitleStyle: SubtitleStyle;
}

export interface ReelDefinition {
  id: string;
  name: string;
  createdAt: string;
  startMs: number;       // display/compose time
  endMs: number;         // display/compose time
  sourceStartMs?: number; // source time for video seeking (when from compose, differs from startMs)
  sourceEndMs?: number;   // source time for video seeking
  cropRegion: CropRegion;
  composition: CompositionState;
  subtitleStyle: SubtitleStyle;
  subtitleStylePreset: string;
  subtitleConstraints: SubtitleConstraints;
  subtitleSegments: SubtitleSegment[];
  punchlineSegmentIds: string[];
  versions?: ReelVersion[];
}

export interface BitDefinition {
  id: string;
  label: string;       // "Airplane food bit"
  summary: string;     // 1-2 sentences
  startMs: number;     // absolute source video time
  endMs: number;
}

export interface PunchlineHint {
  id: string;
  timestampMs: number;
  laughterSegmentId: string;
  confidence: number;  // 0-1
  suggestedLabel?: string;
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
  // Board audio amplification/normalization
  amplifyApplied: boolean;
  amplifySettings?: AudioAmplifySettings;
  amplifiedBoardPath?: string; // output of amplification
  // Board audio path (the clean desk audio used as main voice)
  boardAudioPath?: string;
  // Camera ambient path (after optional cleanup)
  cameraAmbientPath?: string;
  cleanupApplied: boolean;
  cleanupSettings?: AudioCleanupSettings;
}

export interface VoiceSubtractionConfig {
  method: 'spectral' | 'nlms';
  alignOnly?: boolean;   // true = only align, skip voice subtraction
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

export interface AudioAmplifySettings {
  mode: 'loudnorm' | 'gain' | 'both';
  gainDb: number;              // Simple gain in dB (-20 to +30)
  targetLUFS: number;          // Loudness normalization target (-24 to -10)
  truePeak: number;            // Max true peak level (-3 to 0)
  compressor: boolean;         // Apply dynamics before normalize
  compressorThreshold: number; // dB (-40 to 0)
  compressorRatio: number;     // 1:1 to 10:1
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
  muxedDurationMs?: number;  // actual duration of the muxed file (probed after mux completes)
  /**
   * How many ms the muxed video's t=0 is AHEAD of the standalone audio
   * (selectedAudioPath) t=0. Non-zero when the mux pipeline had to shift the
   * video forward to align with the audio: for a negative alignmentOffsetMs
   * the mux input-seeks the video to the nearest keyframe at-or-after
   * |alignmentOffsetMs|, which usually overshoots the target by a fraction
   * of a second. The same offset must be applied to the standalone audio
   * clip's sourceInMs in the Compose timeline, otherwise the Compose player
   * (which uses the muxed video silent + standalone audio) plays them
   * desynced by this amount.
   */
  muxedAudioOffsetMs?: number;
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
  constraints: SubtitleConstraints;
  // DEPRECATED: style/stylePreset moved to youtubeSubtitles (kept for migration)
  style?: SubtitleStyle;
  stylePreset?: string;
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
  style?: {
    color?: string;
    fontSize?: number;
    fontWeight?: number;
  };
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
  animation: 'none' | 'fade' | 'typewriter' | 'word-highlight' | 'pop' | 'punchline';
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
  targetType: 'youtube' | 'reel';
  reelId?: string;
}

// --- Composition Timeline ---

export interface CompositionClip {
  id: string;
  type: 'video' | 'image' | 'audio' | 'gif' | 'text';
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
  // Text overlay
  textContent?: string;
  textStyle?: {
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    color: string;
    backgroundColor?: string;
    lineHeight?: number;
    shadowColor?: string;
    shadowBlur?: number;
    shadowX?: number;
    shadowY?: number;
    /**
     * Horizontal alignment of the text inside its bounding box.
     * The box is centered on overlayPosition (x, y); textAlign controls how
     * the glyphs sit inside that box. Mirrors CSS text-align semantics and
     * libass alignment (4/5/6 for middle-left/center/right).
     * @default 'center'
     */
    textAlign?: 'left' | 'center' | 'right';
  };
  // Overlay position for image/gif/text
  overlayPosition?: {
    x: number;      // 0-1 fraction
    y: number;
    width: number;  // 0-1 fraction
  };
  // Per-clip motion transform (Premiere-style zoom/position/rotation).
  // Applied to the rendered clip on top of mode (cutaway/overlay) framing.
  // scale: 1.0 = original size, >1 = zoom in, <1 = zoom out
  // x/y: in fractions of composition width/height, 0 = no offset
  // rotation: degrees, clockwise positive. Useful for straightening a
  //   slightly-crooked camera. Combine with a small zoom so the rotated
  //   frame still fills the canvas (no black triangles in the corners).
  transform?: {
    scale: number;     // 0.1 - 5.0
    x: number;         // -1 to 1
    y: number;         // -1 to 1
    rotation?: number; // degrees, default 0
  };
}

export interface OverlayPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CompositionAspect = '16:9' | '9:16' | '1:1' | '4:5';

export interface CompositionTrack {
  id: string;
  type: 'video' | 'audio' | 'subtitle' | 'image' | 'text';
  label: string;
  locked: boolean;
  muted: boolean;
  visible: boolean;
}

export interface MediaBinAsset {
  id: string;
  fileName: string;
  originalName: string;
  type: 'video' | 'image' | 'audio' | 'gif';
  duration?: number;
  resolution?: { width: number; height: number };
}

export interface CompositionState {
  tracks: CompositionTrack[];
  clips: CompositionClip[];
  mediaBin: MediaBinAsset[];
  aspectRatio?: CompositionAspect;
}
