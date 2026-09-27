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
  /** Which cuts `bits` were detected against: the live compose timeline, a
   * named compose version, or the full video. The reels bits panel reads it
   * to label the list and to build reels from the SAME cuts. */
  bitsSource?: BitsSource;
  // Custom subtitle style presets (persisted per-project, not in localStorage)
  customStylePresets?: CustomStylePreset[];
  // Multi-part recordings: N (video + board audio) pairs, each independently
  // aligned/mixed/muxed, then concatenated in `parts order` into the final
  // muxed video (sync.muxedVideoPath). Absent on single-pair projects.
  parts?: ProjectPart[];
  // State of the final parts concatenation (join) step.
  partsConcat?: PartsConcatState;
  // DEPRECATED: old single reel settings (kept for migration only)
  reelSettings?: ReelSettings;
}

/**
 * One (video + board audio) pair processed independently through
 * extract → align → mix → mux. Derived files are namespaced by part id
 * (part_<id8>_*) so N parts never collide:
 *   audio/part_<id8>_board.wav      (board converted to 48k mono wav)
 *   audio/part_<id8>_alignment.json (cross-correlation diagnostics)
 *   audio/part_<id8>_mix.wav        (aligned board+ambient mix)
 *   export/part_<id8>_muxed.mp4     (video -c:v copy + mix as AAC)
 * NOTE: the name deliberately does NOT match export/muxed_*.mp4 — the mux
 * route blast-deletes that glob.
 */
/**
 * A time region on the board (mesa) audio where the level is ducked
 * (attenuated) to suppress the comic's filler sounds picked up by the mic —
 * rhythmic "je-je" chuckles and sustained "eehh" fillers. Times are ABSOLUTE
 * within the board wav (part_<id8>_board.wav), the same timeline the detection
 * script and the ducking editor render. Applied as a time-varying volume
 * envelope on the board branch of the mix (see src/server/audio-duck.ts).
 */
/** One AUTOMATIC ambient raise decided by the gain-curve engine (camera-wav clock). */
export interface AmbientAutoRaise { startMs: number; endMs: number; db: number }
/** One stretch the MESA GATE decided to close, in the board wav's clock (db = −24). */
export type BoardAutoGate = AmbientAutoRaise;

export interface BoardDuckRegion {
  id: string;
  startMs: number;
  endMs: number;
  attenuationDb: number;                 // negative = attenuate (e.g. -18); positive = boost (ambient regions)
  source: 'manual' | 'jeje' | 'eehh';    // manual, or auto-detected pattern type
  enabled: boolean;                      // proposals can be toggled off without deleting
  /** Gain ramp lengths for this region (ms). The ramp sits OUTSIDE the marked
   * range: fade-in over [start-fadeInMs, start], fade-out over [end,
   * end+fadeOutMs], so the marked range is the full-gain plateau. When absent
   * a short default anti-click ramp (~30ms) is used. Mainly for ambient BOOST
   * regions (raise the audience/laughs smoothly — no canned-laughter jump). */
  fadeInMs?: number;
  fadeOutMs?: number;
  /** Ramp shape: straight (default) or S-shaped (smoothstep — gradual at both ends). */
  fadeShape?: 'linear' | 'curve';
  /** Detector output carried onto the region so the list can show WHY it was
   * proposed (confidence 0..1, and a short human description such as
   * "5 pulsos · 210 ms · −12 dB bajo la voz"). Absent on manual regions. */
  confidence?: number;
  detail?: string;
  /** Review verdict for detector proposals. A proposal arrives with
   * enabled=false and NO verdict (= pending, "por revisar"); ✗ sets
   * rejected=true, ✓ sets enabled=true. Only rejected===true feeds the
   * "Buscar parecidos" negatives — a pending proposal is NOT a rejection
   * (the user's 30-ago review had 78 untouched proposals that looked exactly
   * like the 83 confirmed chuckles; treating them as ✗ killed the learning). */
  rejected?: boolean;
  /** Ambient "no raise" vetoes only. `retiresAuto`: the veto was born from ✕ on
   * an automatic raise's box — it is drawn as a faint outline (not a user
   * zone) so the raise can be restored. `ownerId`: the veto exists because the
   * manual band with that id TOOK OVER the automatic raise (materialize) — it
   * is never drawn and is deleted together with its band. Both keep their
   * engine effect (no automatic raise there). */
  retiresAuto?: boolean;
  ownerId?: string;
}

export interface ProjectPart {
  id: string;
  name: string;               // "Parte 1", editable
  videoSourceId: string;      // SourceFile.id (type 'video')
  boardSourceId?: string;     // SourceFile.id (type 'audio'); absent = video-only part
  order: number;              // position in the final concat (0-based)
  // Pipeline state (dual-written: JobManager for SSE + persisted here for reloads)
  // 'aligned' = extract+align done, offset known/adjustable — mix+mux pending.
  status: 'idle' | 'processing' | 'aligned' | 'done' | 'error';
  stage?: 'extract' | 'align' | 'mix' | 'mux';
  jobId?: string;
  progress?: number;          // 0-100
  error?: string;
  // Mix settings used (defaults mirror SyncState boardVolume/cameraAmbientVolume)
  boardVolume?: number;
  ambientVolume?: number;
  // Extra gain applied to the board BEFORE the volume multiplier (dB, default 0)
  boardGainDb?: number;
  // Compress board dynamics before the gain (same compand chain as the
  // audio-prep amplifier: threshold -25 dB, ratio 4:1, limiter 0.95).
  // Default TRUE — mirrors the user's standard amplify settings.
  boardCompress?: boolean;
  /** Adaptive voice leveling (FFmpeg speechnorm): raise every stretch of
   * voice toward a common ceiling, each by however much IT needs (quiet
   * lines get more gain, loud ones little/none), smoothed so relative
   * dynamics survive. Replaces the compand step when enabled. */
  boardSpeechLevel?: boolean;
  /** MESA GATE (−24 dB where the mesa sits at its room floor, before the
   * leveler). OFF by default: the user deletes its closures in the edit every
   * time ("no tienen mucha utilidad; lo que cuenta es atenuar el ambiente
   * mientras hay voz"). Opt-in per part. */
  boardGate?: boolean;
  /** Integrated loudness (LUFS) of the raw board wav as measured by the last
   * mix/preview — the anchor of the leveler curve. Persisted so the UI can
   * draw the exact input→output curve the mix applies. */
  boardLUFS?: number;
  /** Room-noise floor of the part's window (p10 of 50 ms RMS, dBFS) — the leveler's knee rides it. */
  boardNoiseFloorDb?: number;
  /** Loud voice of the window (p95 of the follower over voice frames, dBFS):
   * the leveler maps it to the ceiling. Replaces boardLUFS as the anchor. */
  boardLoudDb?: number;
  /** Leveler knee set by hand (dBFS): voice below it is left alone. Unset =
   * room floor + 2 (the ramp straddles the floor). */
  boardLevelKneeDb?: number;
  /** Voice-duck shape extras (see ambientSidechainDuckFilters):
   *  attack = ms the ambient takes to drop once voice is detected (5–500,
   *  default 15); hold = ms it stays ducked AFTER the voice stops before the
   *  release starts (0–2000, default 0); gap boost = dB the ambient is RAISED
   *  in the gaps between phrases (0–12, default 0) — "subir los valles" —
   *  while the voice-time level stays at −ambientVoiceDuckDb vs the original. */
  ambientVoiceAttackMs?: number;
  ambientVoiceHoldMs?: number;
  ambientGapBoostDb?: number;
  /** Pre-computed-envelope duck extras (see ambient-gain-curve.ts):
   *  preRise = ms BEFORE the real end of the voice at which the rise into a
   *  laugh starts (0–1000, default 150) — the laugh swells under the last
   *  words instead of jumping in after them; gate = dB the ambient must sit
   *  above its own room floor for a long pause to count as "audience present"
   *  and be raised at all (0–30, default 6; 0 = every long pause rises). */
  ambientPreRiseMs?: number;
  ambientGateDb?: number;
  /** Room floor (dBFS) of the camera/ambient track measured over the WHOLE
   * part by the last full mix — the 30 s preview reuses it so its audience
   * gate decides exactly like the mix. Written by the worker, not the user. */
  ambientRoomFloorDb?: number;
  /** Cross-mic voice calibration of the last full mix (mesa−cámara ratio in
   * voice, mesa floor) — the 30 s preview reuses it. Worker-written. */
  ambientVoiceCalibDeltaDb?: number;
  ambientVoiceCalibFloorDb?: number;
  ambientVoiceCalibLoudDb?: number;
  /** p10 of the raw mesa's compand-style follower over the whole part — the
   * MESA GATE's floor (the gate opens 6 dB over it). Worker-written. */
  ambientVoiceCalibMesaFloorDb?: number;
  /** LEGACY (speechnorm era) — max boost in dB. No longer used by the chain. */
  boardSpeechLevelDb?: number;
  /** Leveler dynamics compression ratio (2 = volume differences halved).
   * Loud lines reach the ceiling; quieter lines get proportionally more
   * boost but keep an audible share of the original dynamics. */
  boardLevelRatio?: number;
  /** Where the loudest voice lands, dBFS (default −3). */
  boardLevelCeilingDb?: number;
  /** Sidechain-duck the camera AMBIENT while the board VOICE is active:
   * ambient drops fast when the comic speaks (kills the room echo of the
   * voice) and swells back with a fade in every gap so laughs/audience
   * read louder. */
  ambientDuckOnVoice?: boolean;
  /** Max ambient attenuation while voice is present, in dB (default 8). */
  ambientVoiceDuckDb?: number;
  /** Ambient recovery time after the voice stops, in ms (default 400) —
   * effectively the fade-in of the laughter in each gap. */
  ambientVoiceReleaseMs?: number;
  /** Sidechain lookahead, ms (default 200): the ambient ANTICIPATES the
   * voice — starts dropping before a phrase begins and swelling before it
   * ends, so the transitions stay glued to the voice even in short gaps. */
  ambientVoiceAnticipateMs?: number;
  /** Optional alignment search window (ms, mesa-before-camera positive):
   * restrict the GCC-PHAT coarse peak search when a short camera piece
   * produces a weak/ambiguous global peak (locks onto the wrong moment). */
  alignSearchStartMs?: number;
  alignSearchEndMs?: number;
  /** The stretch of the VIDEO this part covers (ms in the video file). The
   * mix, the mux and every clock downstream start at `startMs` and stop at
   * `endMs`; absent = the whole video. See lib/part-trims.ts. */
  videoRangeMs?: { startMs: number; endMs: number };
  /** Where in the MESA that stretch is expected (ms in the board file): the
   * aligner correlates ONLY this excerpt (±60 s) against the video range, so a
   * 30-min piece of a 2-hour dinner recording can't lock onto a look-alike
   * moment elsewhere. Search hint only — the mix uses the offset it yields. */
  boardRangeMs?: { startMs: number; endMs: number };
  /** The video range the part's muxed file was cut for (`start-end`), so an
   * audio-only re-mix knows the picture still matches. */
  muxedForRangeKey?: string;
  /** Ambient (camera) LEVEL zones for this part's mix (times ABSOLUTE in the
   * part's camera wav, applied before its atrim). `attenuationDb` is the level
   * over the ORIGINAL ambient in the plateau — the same number a "+4 dB auto"
   * box shows — and inside its span (cross-faded over its ramps) the zone
   * REPLACES whatever the automatic curve decided there; see
   * src/lib/ambient-bands.ts. Parts without `ambientBandsAbsolute` stored the
   * old meaning (an ADDITION on top of the curve) and are converted on read. */
  ambientBoostRegions?: BoardDuckRegion[];
  /** True once `ambientBoostRegions` carry absolute levels (set by the
   * read-time migration in project-manager; every write persists it). */
  ambientBandsAbsolute?: boolean;
  /** Ranges (camera-wav clock, like the boost regions) where the AUTOMATIC ambient
   * raise must NOT happen: the pre-computed curve keeps the voice level there. */
  ambientNoRaiseRegions?: BoardDuckRegion[];
  /** What the engine DECIDED on its last run (full mix or the auto-raises
   * route): each automatic raise as a range, so the timeline can show it as a
   * zone and the user can veto it. Camera-wav clock. */
  ambientAutoRaises?: AmbientAutoRaise[];
  ambientAutoRaisesAt?: string;
  // Time regions (in the part's OWN board wav timeline, part_<id8>_board.wav)
  // where the mesa mic is ducked (attenuated) to suppress the comic's filler
  // sounds ("je-je" chuckles, "eehh" fillers). Applied as a time-varying volume
  // envelope on the board branch at mix time. See BoardDuckRegion.
  boardDuckRegions?: BoardDuckRegion[];
  /** Board-wav clock, like boardDuckRegions (attenuationDb 0, no fades): stretches
   * where the MESA GATE must stay OPEN whatever the follower / cross-mic rule
   * decided — the user's veto over an automatic closure. */
  boardKeepOpenRegions?: BoardDuckRegion[];
  /** What the gate engine DECIDED to close on its last full run (board-wav clock,
   * db = −24), so the timeline can draw every closure as a read-only box the user
   * can veto with a keep-open zone. Worker-written. */
  boardAutoGates?: BoardAutoGate[];
  boardAutoGatesAt?: string;
  // Results
  alignmentOffsetMs?: number;   // + = board started before camera (same convention as audio.alignmentOffsetMs)
  alignmentPeakToNoise?: number; // >5 trustworthy, <2 noise (from alignment_data)
  mixedAudioPath?: string;      // absolute path to part mix wav
  muxedVideoPath?: string;      // absolute path to part muxed mp4
  muxedDurationMs?: number;
  /** Alignment offset the current muxedVideoPath was built for, and the
   * keyframe-snap residual (ms) trimmed off the mix's head at mux time. The
   * part VIDEO only depends on these — so a re-mix with the same offset can
   * skip the 25+ GB video rewrite and refresh audio only (single-part fast
   * path in runPartPipeline). Absent on parts muxed before this existed. */
  muxedForOffsetMs?: number;
  muxedAudioTrimMs?: number;
  /** When the current mix wav / muxed video were produced, and the exact
   * chain the mix applied (human strings from part-chain-description). The
   * UI labels every player with these ("mezcla de las 12:03 con …") and warns
   * when the video's embedded audio is OLDER than the current mix (audio-only
   * re-mix) or when the settings changed since the mix. */
  mixedAt?: string;
  muxedAt?: string;
  mixChainApplied?: { board: string; ambient: string; mix: string };
  processedAt?: string;         // ISO
}

export interface PartsConcatState {
  status: 'idle' | 'running' | 'done' | 'error';
  jobId?: string;
  outputPath?: string;        // = sync.muxedVideoPath after success
  error?: string;
  concatenatedAt?: string;    // ISO
}

export interface CropRegion {
  centerX: number;  // 0-1, crop center in source (default 0.5)
  centerY: number;  // 0-1 (default 0.5)
  scale: number;    // 0.1-1.0, 1.0 = full source height visible (default 1.0)
}

/** A keyframe of the reel's 9:16 crop window — position/zoom of the frame at
 * a given REEL-TIMELINE time. With ≥1 keyframes the effective crop at any time
 * is the linear interpolation between surrounding keyframes (constant before
 * the first and after the last), enabling manual subject tracking / pans with
 * return. Without keyframes the static `cropRegion` applies, as always. */
export interface CropKeyframe extends CropRegion {
  id: string;
  timeMs: number;
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
  /** Framing at snapshot time — restoring clips without these would leave the
   *  animation keyed to a timeline that no longer exists. */
  cropRegion?: CropRegion;
  cropKeyframes?: CropKeyframe[];
}

export interface ReelDefinition {
  id: string;
  name: string;
  createdAt: string;
  startMs: number;       // display/compose time
  endMs: number;         // display/compose time
  sourceStartMs?: number; // source time for video seeking (when from compose, differs from startMs)
  sourceEndMs?: number;   // source time for video seeking
  /** Source ranges to play back-to-back when the reel's compose range spans
   * compose cuts. Present only for cut-spanning reels; lets the SETUP preview
   * skip the removed material (the timeline phase rebuilds clips from compose
   * directly). Each segment is [sourceInMs, sourceOutMs] in muxed-file time. */
  sourceSegments?: { sourceInMs: number; sourceOutMs: number }[];
  /** Set when the reel was created from bits detected against a NAMED compose
   * version: its startMs/endMs live on that version's timeline, and the setup
   * trim bar, the timeline build and the subtitle regeneration all use the
   * version's clips and subtitles instead of the live compose. */
  composeVersionId?: string;
  composeVersionLabel?: string;
  cropRegion: CropRegion;
  composition: CompositionState;
  subtitleStyle: SubtitleStyle;
  subtitleStylePreset: string;
  subtitleConstraints: SubtitleConstraints;
  subtitleSegments: SubtitleSegment[];
  punchlineSegmentIds: string[];
  versions?: ReelVersion[];
  /** Carry the compose EXTRA-audio clips (a2+) overlapping the reel's range
   * into the reel's Extra Audio track when its timeline is first built.
   * Defaults to true; the setup view offers a checkbox to opt out. */
  includeComposeExtraAudio?: boolean;
  /** Animated crop: keyframes of the 9:16 frame over the reel timeline
   * (manual subject tracking / pan+zoom with return). Empty/absent = the
   * static cropRegion applies. See CropKeyframe. */
  cropKeyframes?: CropKeyframe[];
}

export interface BitsSource {
  kind: 'compose' | 'version' | 'full';
  versionId?: string;
  versionLabel?: string;
  detectedAt: string;
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
  /** Ambient (camera/audience) BOOST regions: raise the ambient branch of the
   * mix in these ranges (positive attenuationDb) with per-region fade-in/out,
   * so laughs swell smoothly while the mesa voice stays untouched (boosting
   * the whole camera audio echoes the voice). Times are ABSOLUTE in the
   * ambient wav (= mix timeline — the ambient drives the mix with no trim).
   * Applied by the mix route on the ambient branch; marked from the
   * Compose/Reels editors. */
  ambientBoostRegions?: BoardDuckRegion[];
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
  // Board ducking regions (single-pair flow) — attenuate the mesa's "je-je"/
  // "eehh" filler sounds. Times are ABSOLUTE in the board wav. Applied as a
  // volume envelope on the board branch by the mix-preview route. Mirrors the
  // per-part ProjectPart.boardDuckRegions. See src/server/audio-duck.ts.
  boardDuckRegions?: BoardDuckRegion[];
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
  /** Bumped (timestamp) whenever the selected mix wav is re-written in place
   *  (e.g. re-mixing with new board ducking from Compose/Reels). Appended to the
   *  preview audio URL so the browser reloads the updated wav instead of caching. */
  audioRev?: number;
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

/** How subtitles are chopped into blocks. 'clasico' = by characters (the
 *  long-form behaviour); 'picado' = ≤ maxWordsPerBlock words, aligned with the
 *  phrases and never splitting a determiner/preposition/auxiliary from what
 *  follows; 'remate' = 'picado' plus the last unit of every sentence isolated
 *  as its own block (the punchline beat for comedy reels). */
export type SubtitleSplitMode = 'clasico' | 'picado' | 'remate';

export interface SubtitleConstraints {
  maxCharsPerBlock: number;
  maxDurationMs: number;
  /** Undefined = 'clasico' for long-form (compose/transcription); reels default to 'picado'. */
  splitMode?: SubtitleSplitMode;
  /** Words per block for 'picado' / 'remate' (reels default 3). */
  maxWordsPerBlock?: number;
}

export interface SubtitleSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words?: SubtitleWord[];
  /** Per-segment animation override. When set, this segment animates with this
   *  instead of the global SubtitleStyle.animation — e.g. word-by-word reveal
   *  ('typewriter') on just one line. Undefined = use the global animation. */
  animation?: SubtitleStyle['animation'];
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

/** One volume zone inside an audio clip (see CompositionClip.gainRegions). */
export interface ClipGainRegion {
  id: string;
  startMs: number;
  endMs: number;
  /** Negative attenuates, positive amplifies. */
  db: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  fadeShape?: 'linear' | 'curve';
}

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
  /** Volume automation INSIDE this clip: zones with their own dB, ramps and
   * shape, in the clip's OWN file clock (the same clock as sourceInMs), so a
   * split or a ripple needs no remapping. The plateau is [startMs, endMs] and
   * the fades sit OUTSIDE it — the same convention as BoardDuckRegion, so the
   * server reuses buildDuckVolumeExpr and the UI reuses the zone silhouette.
   * Multiplies the clip's static `volume`. */
  gainRegions?: ClipGainRegion[];
  opacity?: number;
  // Audio fade-in applied at the START of this clip (mostly for extra-audio
  // layers). fadeInMs = 0/undefined → no fade. fadeInCurve picks the ramp
  // shape; maps to FFmpeg afade curves and a JS easing in the live preview.
  fadeInMs?: number;
  fadeInCurve?: 'linear' | 'exponential' | 'logarithmic' | 'quarter-sine';
  // Premiere-style transition INTO the next adjacent video clip on the same
  // track. Rendered on export via FFmpeg xfade using pre-roll ("handle")
  // material from before the next clip's in-point, so the total duration and
  // all downstream timings (subtitles, audio) are preserved. The live preview
  // shows a plain cut. dissolve→fade, wipe→wipeleft, slide→slideleft,
  // zoom→zoomin.
  transitionAfter?: { type: 'dissolve' | 'wipe' | 'slide' | 'zoom'; durationMs: number };
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

/** A NAMED snapshot of the Compose timeline (its cuts, subtitles and style),
 * saved from the compose toolbar. Reels can detect bits against one of these
 * instead of the live timeline, and a reel created from such bits keeps the
 * version's cuts and subtitles (ReelDefinition.composeVersionId). */
export interface ComposeVersion {
  id: string;
  label: string;
  createdAt: string;
  clips: CompositionClip[];
  subtitleSegments: SubtitleSegment[];
  subtitleStyle: SubtitleStyle;
}

export interface CompositionState {
  tracks: CompositionTrack[];
  clips: CompositionClip[];
  mediaBin: MediaBinAsset[];
  /** Named snapshots (compose toolbar bookmark button). */
  versions?: ComposeVersion[];
  aspectRatio?: CompositionAspect;
  /** Fill color behind the video when its aspect ratio doesn't match the
   * canvas (letterbox/pillarbox bars). Hex string, e.g. '#000000'. Defaults
   * to black when unset. Shared by Compose (project.composition) and each
   * Reel (reel.composition) since both use this same type — applies to both
   * the live preview AND the FFmpeg export so they never diverge. */
  backgroundColor?: string;
}
