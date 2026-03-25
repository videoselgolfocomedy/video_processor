'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useProjectStore } from '@/stores/project-store';
import { useSSE } from '@/hooks/use-sse';
import { SubtitleEditor } from '@/components/subtitles/subtitle-editor';
import { SubtitlePreview } from '@/components/subtitles/subtitle-preview';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { LANGUAGES } from '@/config/languages';
import { WHISPER_MODELS } from '@/lib/constants';
import { splitLongSegments, segmentsToSrt, segmentsToDiff, downloadAsFile } from '@/lib/subtitle-utils';
import { formatTimestamp } from '@/lib/utils';
import { AlertTriangle, Check, Download, FileAudio, FileVideo, Loader2, Mic, Scissors, Settings2, Sparkles, X, Zap } from 'lucide-react';
import type { PlayerRef } from '@remotion/player';
import type { SubtitleSegment, SubtitleConstraints } from '@/types/project';

type Engine = 'groq' | 'local';

const GROQ_MODELS = [
  { value: 'whisper-large-v3-turbo', label: 'large-v3-turbo (recomendado)' },
  { value: 'whisper-large-v3', label: 'large-v3 (mayor precisión)' },
  { value: 'distil-whisper-large-v3-en', label: 'distil-large-v3 (solo inglés)' },
];

export default function TranscriptionPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { currentProject, fetchProject, updateCurrentProject } = useProjectStore();
  const { toast } = useToast();

  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [transcribing, setTranscribing] = useState(false);

  const [engine, setEngine] = useState<Engine>('groq');
  const [language, setLanguage] = useState(
    currentProject?.transcription.language || 'auto'
  );
  const [model, setModel] = useState(
    currentProject?.transcription.model || 'medium'
  );
  const [groqModel, setGroqModel] = useState('whisper-large-v3-turbo');
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number>();
  const [audioSource, setAudioSource] = useState<{ label: string; fileName: string } | null>(null);
  const [groqAvailable, setGroqAvailable] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // AI Reinterpretation state
  const [reinterpreting, setReinterpreting] = useState(false);
  const [reinterpretContext, setReinterpretContext] = useState('');
  const [reinterpretResults, setReinterpretResults] = useState<SubtitleSegment[] | null>(null);
  const [showReinterpretPanel, setShowReinterpretPanel] = useState(false);
  const [llmProviders, setLlmProviders] = useState<{ id: string; label: string; available: boolean; note?: string }[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [reinterpretError, setReinterpretError] = useState<string | null>(null);
  const [reinterpretProgress, setReinterpretProgress] = useState<string>('');

  // Constraints state
  const [showConstraints, setShowConstraints] = useState(false);

  // Player ref for seeking
  const playerRef = useRef<PlayerRef>(null) as React.RefObject<PlayerRef>;

  // Fetch project
  useEffect(() => {
    fetchProject(projectId);
  }, [projectId, fetchProject]);

  // Fetch which audio file will be transcribed
  useEffect(() => {
    fetch(`/api/projects/${projectId}/transcribe`)
      .then((res) => res.json())
      .then((data) => {
        setAudioSource(data.audioSource || null);
        setGroqAvailable(!!data.groqAvailable);
        if (!data.groqAvailable) setEngine('local');
      })
      .catch(() => {});
  }, [projectId, currentProject?.sync.selectedAudioPath, currentProject?.sync.mixedAudioPath]);

  // Fetch available LLM providers for reinterpretation
  useEffect(() => {
    if (!showReinterpretPanel) return;
    fetch(`/api/projects/${projectId}/subtitles/reinterpret`)
      .then((res) => res.json())
      .then((data) => {
        const provs = data.providers || [];
        setLlmProviders(provs);
        if (!selectedProvider) {
          const first = provs.find((p: { available: boolean }) => p.available);
          if (first) setSelectedProvider(first.id);
        }
      })
      .catch(() => {});
  }, [showReinterpretPanel, projectId, selectedProvider]);

  useSSE({
    jobId,
    onProgress: (prog, msg) => {
      setProgress(prog);
      setMessage(msg);
    },
    onComplete: () => {
      setTranscribing(false);
      setJobId(null);
      fetchProject(projectId);
      toast({ title: 'Transcripción completada' });
    },
    onError: (err) => {
      setTranscribing(false);
      setJobId(null);
      setErrorMessage(err);
    },
  });

  const handleTranscribe = useCallback(async () => {
    setTranscribing(true);
    setProgress(0);
    setMessage(engine === 'groq' ? 'Enviando a Groq...' : 'Iniciando transcripción...');
    setErrorMessage(null);
    try {
      const selectedModel = engine === 'groq' ? groqModel : model;
      const res = await fetch(`/api/projects/${projectId}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, model: selectedModel, engine }),
      });
      if (!res.ok) throw new Error('Failed to start transcription');
      const data = await res.json();
      setJobId(data.jobId);
    } catch {
      setTranscribing(false);
      toast({ title: 'Error al iniciar transcripción', variant: 'destructive' });
    }
  }, [projectId, language, model, groqModel, engine, toast]);

  const handleSegmentsChange = useCallback(
    (segments: SubtitleSegment[]) => {
      if (!currentProject) return;
      updateCurrentProject({
        transcription: { ...currentProject.transcription, segments },
      });
    },
    [currentProject, updateCurrentProject]
  );

  const handleSave = useCallback(async () => {
    if (!currentProject) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/subtitles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: currentProject.transcription.segments,
          constraints: currentProject.transcription.constraints,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      toast({ title: 'Transcripción guardada' });
    } catch {
      toast({ title: 'Error al guardar', variant: 'destructive' });
    }
  }, [currentProject, projectId, toast]);

  // Seek player when a segment is clicked
  const handleSegmentClick = useCallback((index: number) => {
    setActiveSegmentIndex(index);
    if (!currentProject) return;
    const seg = currentProject.transcription.segments[index];
    if (seg && playerRef.current) {
      const fps = 30;
      const frame = Math.round((seg.startMs / 1000) * fps);
      playerRef.current.seekTo(frame);
    }
  }, [currentProject]);

  // AI Reinterpretation (streaming ndjson)
  const handleReinterpret = useCallback(async () => {
    if (!currentProject) return;
    setReinterpreting(true);
    setReinterpretError(null);
    setReinterpretProgress('Iniciando...');
    try {
      const res = await fetch(`/api/projects/${projectId}/subtitles/reinterpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: currentProject.transcription.segments,
          language: currentProject.transcription.language,
          context: reinterpretContext || undefined,
          provider: selectedProvider || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Reinterpretation failed');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === 'progress') {
            const pct = Math.round((event.batch / event.total) * 100);
            setReinterpretProgress(`${event.message} (${pct}%)`);
          } else if (event.type === 'done') {
            // Don't apply splitLongSegments here — it changes array length
            // and breaks the index-based diff display. Split when accepting.
            setReinterpretResults(event.segments);
            // Persist bits if the LLM identified any
            if (event.bits && Array.isArray(event.bits) && event.bits.length > 0) {
              fetch(`/api/projects/${projectId}/subtitles`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bits: event.bits }),
              }).catch(() => {});
              updateCurrentProject({ bits: event.bits });
              toast({ title: `${event.bits.length} comedy bits identified (visible in Reels)` });
            }
          } else if (event.type === 'error') {
            setReinterpretError(event.error);
          }
        } catch (e) {
          console.error('[reinterpret-client] Failed to parse ndjson line:', line.substring(0, 200), e);
        }
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) processLine(line);
      }
      if (buffer.trim()) processLine(buffer);
    } catch (err) {
      setReinterpretError((err as Error).message);
    } finally {
      setReinterpreting(false);
      setReinterpretProgress('');
    }
  }, [currentProject, projectId, reinterpretContext, selectedProvider]);

  const applyReinterpretation = useCallback(
    (mode: 'all' | 'single', index?: number) => {
      if (!currentProject || !reinterpretResults) return;
      const original = currentProject.transcription.segments;
      let newSegments: SubtitleSegment[];

      if (mode === 'all') {
        // Apply splitLongSegments now (deferred from handleReinterpret to preserve index alignment for diff)
        const { constraints: c } = currentProject.transcription;
        newSegments = c
          ? splitLongSegments(reinterpretResults, c.maxCharsPerBlock, c.maxDurationMs)
          : reinterpretResults;
        setReinterpretResults(null);
        setShowReinterpretPanel(false);
      } else if (index !== undefined) {
        newSegments = original.map((seg, i) =>
          i === index ? { ...seg, text: reinterpretResults[i].text } : seg
        );
        const updatedResults = [...reinterpretResults];
        updatedResults[index] = { ...updatedResults[index], text: original[index].text };
        setReinterpretResults(updatedResults);
      } else {
        return;
      }

      updateCurrentProject({
        transcription: { ...currentProject.transcription, segments: newSegments },
      });
      toast({ title: mode === 'all' ? 'Todas las correcciones aplicadas' : 'Corrección aplicada' });
    },
    [currentProject, reinterpretResults, updateCurrentProject, toast]
  );

  // Constraints
  const handleConstraintsChange = useCallback(
    (constraints: SubtitleConstraints) => {
      if (!currentProject) return;
      updateCurrentProject({
        transcription: { ...currentProject.transcription, constraints },
      });
    },
    [currentProject, updateCurrentProject]
  );

  const handleAutoSplit = useCallback(() => {
    if (!currentProject) return;
    const { segments, constraints } = currentProject.transcription;
    const split = splitLongSegments(segments, constraints.maxCharsPerBlock, constraints.maxDurationMs);
    updateCurrentProject({
      transcription: { ...currentProject.transcription, segments: split },
    });
    toast({ title: `Auto-split: ${segments.length} -> ${split.length} segmentos` });
  }, [currentProject, updateCurrentProject, toast]);

  // Check if muxed video exists on disk (must be before early return)
  const muxedVideoPath = currentProject?.sync.muxedVideoPath;
  const muxedVideoName = muxedVideoPath?.split('/').pop();
  const [useMuxedVideo, setUseMuxedVideo] = useState<boolean | null>(null);

  useEffect(() => {
    if (!muxedVideoName) { setUseMuxedVideo(false); return; }
    fetch(`/api/projects/${projectId}/audio/file?name=${encodeURIComponent(muxedVideoName)}`, { method: 'HEAD' })
      .then((res) => setUseMuxedVideo(res.ok))
      .catch(() => setUseMuxedVideo(false));
  }, [muxedVideoName, projectId]);

  if (!currentProject) return null;

  const segments = currentProject.transcription.segments;
  const constraints = currentProject.transcription.constraints;
  const hasSegments = segments.length > 0;

  // Use youtubeSubtitles style for preview (read-only here)
  const style = currentProject.youtubeSubtitles.style;

  // Compute total duration from segments or video
  const videoSource = currentProject.sources.find((s) => s.type === 'video');
  const audioSourceEntry = currentProject.sources.find((s) => s.type === 'audio');
  // When using muxed video, its duration matches the audio source (not the original camera)
  const videoDurationMs = useMuxedVideo && muxedVideoName && audioSourceEntry?.duration
    ? audioSourceEntry.duration * 1000
    : (videoSource?.duration ? videoSource.duration * 1000 : 0);
  const totalDurationMs = hasSegments
    ? Math.max(...segments.map((s) => s.endMs), videoDurationMs)
    : videoDurationMs || 10000;

  // Video preview URL — prefer muxed video (has processed audio baked in)
  // Add cache buster to avoid stale cached video after re-mux
  const videoSrc = useMuxedVideo && muxedVideoName
    ? `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(muxedVideoName)}&v=${muxedVideoName}`
    : videoSource
      ? `/api/projects/${projectId}/audio/file?name=${encodeURIComponent(videoSource.storedName)}`
      : undefined;
  const usingMuxed = useMuxedVideo && !!muxedVideoName;

  // Count constraint violations
  const violations = constraints ? segments.filter(
    (s) => s.text.length > constraints.maxCharsPerBlock || (s.endMs - s.startMs) > constraints.maxDurationMs
  ).length : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Transcription</h2>
        <p className="text-sm text-muted-foreground">
          Transcribe, refine with AI, and auto-split segments
        </p>
      </div>

      {/* Transcription controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Transcription</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Engine selector */}
          <div className="flex gap-2">
            <button
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                engine === 'groq'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setEngine('groq')}
              disabled={!groqAvailable}
              title={!groqAvailable ? 'Añade GROQ_API_KEY en .env.local' : undefined}
            >
              <Zap className="h-3 w-3" />
              Groq Cloud
              {!groqAvailable && <span className="text-[10px] text-muted-foreground/60">(sin API key)</span>}
            </button>
            <button
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                engine === 'local'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setEngine('local')}
            >
              <Mic className="h-3 w-3" />
              Whisper Local
            </button>
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">
                Idioma
              </label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name} ({lang.nativeName})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">
                Modelo
              </label>
              {engine === 'groq' ? (
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={groqModel}
                  onChange={(e) => setGroqModel(e.target.value)}
                >
                  {GROQ_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {WHISPER_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {engine === 'groq' && (
            <p className="text-[10px] text-muted-foreground/70">
              Groq transcribe en ~30 segundos (vs minutos en local). Gratis con rate limit. Límite: 25MB por archivo.
            </p>
          )}

          {/* Video source indicator */}
          {usingMuxed ? (
            <div className="flex items-center gap-2 rounded-md border border-green-800/40 bg-green-950/20 px-3 py-2">
              <FileVideo className="h-4 w-4 text-green-500 flex-none" />
              <span className="text-xs text-green-400 flex-1">
                Video muxado (con audio procesado)
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-yellow-800/40 bg-yellow-950/20 px-3 py-2">
              <FileVideo className="h-4 w-4 text-yellow-500 flex-none" />
              <span className="text-xs text-yellow-500 flex-1">
                Video original ({videoSource?.originalName ?? 'sin video'}) — sin audio procesado.
                {muxedVideoPath ? ' El muxado anterior no se encontró.' : ''} Ve a Sync & Mix para muxar.
              </span>
              <Link href={`/project/${projectId}/sync`} className="text-[10px] text-yellow-400 hover:underline flex-none">
                Ir a Sync
              </Link>
            </div>
          )}

          {/* Audio source indicator */}
          {audioSource ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-2">
              <FileAudio className="h-4 w-4 text-primary flex-none" />
              <div className="text-xs flex-1">
                <span className="text-muted-foreground">Se transcribirá: </span>
                <strong className="text-foreground">{audioSource.label}</strong>
              </div>
              <Link
                href={`/project/${projectId}/sync`}
                className="text-[10px] text-primary hover:underline flex-none"
              >
                Cambiar
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-yellow-800/40 bg-yellow-950/20 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-yellow-500 flex-none" />
              <span className="text-xs text-yellow-500 flex-1">
                No hay audio disponible. Ve a Sync & Mix para generar una mezcla.
              </span>
              <Link
                href={`/project/${projectId}/sync`}
                className="text-[10px] text-yellow-400 hover:underline flex-none"
              >
                Ir a Sync
              </Link>
            </div>
          )}

          {transcribing && (
            <div className="space-y-1">
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground">{message}</p>
            </div>
          )}

          {errorMessage && (
            <div className="rounded-md border border-red-800/40 bg-red-950/20 p-3 space-y-1">
              <p className="text-xs font-medium text-red-400">Error de transcripción</p>
              <p className="text-xs text-red-300/80 whitespace-pre-wrap break-all select-text">
                {errorMessage}
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleTranscribe} disabled={transcribing || !audioSource}>
              {transcribing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Transcribiendo... {Math.round(progress)}%
                </>
              ) : (
                <>
                  {engine === 'groq' ? (
                    <Zap className="mr-2 h-4 w-4" />
                  ) : (
                    <Mic className="mr-2 h-4 w-4" />
                  )}
                  {hasSegments ? 'Re-transcribir' : 'Transcribir'}
                  {engine === 'groq' && ' con Groq'}
                </>
              )}
            </Button>
            {hasSegments && (
              <Button
                variant="outline"
                onClick={() => setShowReinterpretPanel(!showReinterpretPanel)}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Reinterpretar con IA
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* AI Reinterpretation panel */}
      {showReinterpretPanel && hasSegments && (
        <Card className="border-purple-800/30 bg-purple-950/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-purple-400" />
              Reinterpretar subtítulos con IA
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-muted-foreground">
                  Proveedor de IA
                </label>
                {llmProviders.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Cargando proveedores...</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {llmProviders.map((p) => (
                      <button
                        key={p.id}
                        disabled={!p.available}
                        onClick={() => setSelectedProvider(p.id)}
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                          selectedProvider === p.id
                            ? 'border-primary bg-primary/10 text-primary'
                            : p.available
                              ? 'border-border text-muted-foreground hover:text-foreground'
                              : 'border-border/50 text-muted-foreground/40 cursor-not-allowed'
                        }`}
                        title={!p.available ? `Añade la API key en .env.local` : p.note || undefined}
                      >
                        {p.label}
                        {!p.available && <span className="ml-1 text-[9px]">(sin key)</span>}
                      </button>
                    ))}
                  </div>
                )}
                {llmProviders.find((p) => p.id === selectedProvider)?.note && (
                  <p className="mt-1 text-[10px] text-yellow-500">
                    {llmProviders.find((p) => p.id === selectedProvider)?.note}
                  </p>
                )}
                {llmProviders.length > 0 && !llmProviders.some((p) => p.available) && (
                  <p className="mt-1 text-[10px] text-red-400">
                    Ningún proveedor disponible. Añade OPENAI_API_KEY, ANTHROPIC_API_KEY, o configura OLLAMA_HOST en .env.local
                  </p>
                )}
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs text-muted-foreground">
                  Contexto (opcional)
                </label>
                <Input
                  placeholder="Ej: Es un monólogo de comedia sobre fútbol español"
                  value={reinterpretContext}
                  onChange={(e) => setReinterpretContext(e.target.value)}
                />
              </div>
            </div>

            {constraints && (
              <p className="text-[10px] text-muted-foreground/70">
                Tras corregir, se aplicará auto-split si excede: máx {constraints.maxCharsPerBlock} chars, máx {(constraints.maxDurationMs / 1000).toFixed(1)}s por bloque.
              </p>
            )}

            <Button
              onClick={handleReinterpret}
              disabled={reinterpreting || !selectedProvider}
              variant="secondary"
            >
              {reinterpreting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Procesando...
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Analizar y corregir
                </>
              )}
            </Button>

            {reinterpreting && reinterpretProgress && (
              <p className="text-xs text-purple-400 animate-pulse">
                {reinterpretProgress}
              </p>
            )}

            {reinterpretError && (
              <div className="rounded-md border border-red-800/40 bg-red-950/20 p-3 space-y-1">
                <p className="text-xs font-medium text-red-400">Error al reinterpretar</p>
                <p className="text-xs text-red-300/80 whitespace-pre-wrap break-all select-text">
                  {reinterpretError}
                </p>
              </div>
            )}

            {reinterpretResults && (() => {
              const changedIndices = segments
                .map((orig, i) => {
                  const corr = reinterpretResults[i];
                  return corr && orig.text !== corr.text ? i : -1;
                })
                .filter((i) => i >= 0);
              const changedCount = changedIndices.length;

              const origViolationsChars = constraints
                ? segments.filter((s) => s.text.length > constraints.maxCharsPerBlock).length
                : 0;
              const corrViolationsChars = constraints
                ? reinterpretResults.filter((s) => s.text.length > constraints.maxCharsPerBlock).length
                : 0;
              const origViolationsDur = constraints
                ? segments.filter((s) => (s.endMs - s.startMs) > constraints.maxDurationMs).length
                : 0;
              const corrViolationsDur = constraints
                ? reinterpretResults.filter((s) => (s.endMs - s.startMs) > constraints.maxDurationMs).length
                : 0;

              return (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
                    <span>
                      Segmentos cambiados: <strong className="text-purple-400">{changedCount}/{segments.length}</strong>
                    </span>
                    {constraints && origViolationsChars > 0 && (
                      <span>
                        Exceden chars: <strong className="text-red-400">{origViolationsChars}</strong> → <strong className="text-green-400">{corrViolationsChars}</strong>
                      </span>
                    )}
                    {constraints && origViolationsDur > 0 && (
                      <span>
                        Exceden duración: <strong className="text-red-400">{origViolationsDur}</strong> → <strong className="text-green-400">{corrViolationsDur}</strong>
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="default" onClick={() => applyReinterpretation('all')}>
                      <Check className="mr-1 h-3 w-3" />
                      Aceptar todas
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setReinterpretResults(null)}>
                      <X className="mr-1 h-3 w-3" />
                      Descartar
                    </Button>
                    <div className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => downloadAsFile(segmentsToSrt(segments), 'subtitles_original.srt', 'text/srt')}>
                      <Download className="mr-1 h-3 w-3" /> SRT original
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => downloadAsFile(segmentsToSrt(reinterpretResults), 'subtitles_corrected.srt', 'text/srt')}>
                      <Download className="mr-1 h-3 w-3" /> SRT corregido
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => downloadAsFile(segmentsToDiff(segments, reinterpretResults), 'subtitles_diff.txt')}>
                      <Download className="mr-1 h-3 w-3" /> Diff
                    </Button>
                  </div>

                  {changedCount === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      No se detectaron cambios en los subtítulos.
                    </p>
                  ) : (
                    <div className="max-h-[400px] overflow-y-auto space-y-1.5">
                      {changedIndices.map((i) => {
                        const orig = segments[i];
                        const corr = reinterpretResults[i];
                        const durationSec = ((orig.endMs - orig.startMs) / 1000).toFixed(1);
                        return (
                          <div key={orig.id} className="rounded-md border border-border p-2.5 text-xs space-y-1.5">
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                              <span>#{i + 1} &middot; {formatTimestamp(orig.startMs)} → {formatTimestamp(orig.endMs)} ({durationSec}s)</span>
                              <Button size="sm" variant="ghost" className="h-5 px-2 text-[10px]" onClick={() => applyReinterpretation('single', i)}>
                                <Check className="mr-1 h-2.5 w-2.5" /> Aplicar
                              </Button>
                            </div>
                            <div className="text-red-400/70 line-through">{orig.text}</div>
                            <div className="text-green-400">{corr.text}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* Constraints settings */}
      {hasSegments && (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowConstraints(!showConstraints)}>
            <Settings2 className="mr-1 h-3 w-3" /> Límites
          </Button>
          {violations > 0 && (
            <span className="text-xs text-red-400">
              {violations} segmento{violations > 1 ? 's' : ''} excede{violations > 1 ? 'n' : ''} los límites
            </span>
          )}
        </div>
      )}

      {showConstraints && constraints && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex flex-wrap gap-4">
              <div className="flex-1 min-w-[140px]">
                <label className="mb-1 block text-xs text-muted-foreground">Máx. caracteres por bloque</label>
                <Input
                  type="number" min={20} max={200}
                  value={constraints.maxCharsPerBlock}
                  onChange={(e) => handleConstraintsChange({ ...constraints, maxCharsPerBlock: parseInt(e.target.value) || 80 })}
                />
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="mb-1 block text-xs text-muted-foreground">Máx. duración (ms)</label>
                <Input
                  type="number" min={1000} max={30000} step={500}
                  value={constraints.maxDurationMs}
                  onChange={(e) => handleConstraintsChange({ ...constraints, maxDurationMs: parseInt(e.target.value) || 7000 })}
                />
              </div>
            </div>
            {violations > 0 && (
              <Button variant="outline" size="sm" onClick={handleAutoSplit}>
                <Scissors className="mr-2 h-3 w-3" />
                Auto-split ({violations} segmentos)
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Video preview */}
      {videoSrc && !hasSegments && (
        <SubtitlePreview segments={[]} style={style} durationMs={totalDurationMs} videoSrc={videoSrc} />
      )}

      {/* Editor + Preview (NO style editor - that's in Compose now) */}
      {hasSegments && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="md:col-span-1">
            <SubtitleEditor
              segments={segments}
              onChange={handleSegmentsChange}
              onSave={handleSave}
              activeSegmentIndex={activeSegmentIndex}
              onSegmentClick={handleSegmentClick}
              constraints={constraints}
            />
          </div>

          <div className="md:col-span-1 space-y-6">
            <SubtitlePreview
              segments={segments}
              style={style}
              durationMs={totalDurationMs}
              videoSrc={videoSrc}
              playerRef={playerRef}
            />
          </div>
        </div>
      )}
    </div>
  );
}
