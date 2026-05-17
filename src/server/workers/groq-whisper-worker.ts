import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { jobManager } from '@/server/job-manager';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { convertForGroq } from '@/server/ffmpeg-wrapper';
import { resolveTranscriptionAudio } from '@/server/workers/whisper-worker';
import { resolveKey } from '@/server/settings-manager';
import type { SubtitleSegment } from '@/types/project';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export const GROQ_MODELS = [
  'whisper-large-v3-turbo',
  'whisper-large-v3',
  'distil-whisper-large-v3-en',
] as const;

export interface GroqWhisperOptions {
  projectId: string;
  jobId: string;
  language: string;
  model: string;
}

export async function runGroqTranscription(options: GroqWhisperOptions): Promise<void> {
  const { projectId, jobId, language, model } = options;

  // Read the key from settings.json (Settings UI) or fall back to env var.
  // The Settings UI is the primary source; .env.local is the legacy fallback.
  const apiKey = await resolveKey('groq');
  if (!apiKey) {
    jobManager.failJob(
      jobId,
      'Groq API key no configurada. Añádela en /settings o en GROQ_API_KEY=gsk_... en .env.local'
    );
    return;
  }

  const project = await getProject(projectId);
  if (!project) {
    jobManager.failJob(jobId, 'Project not found');
    return;
  }

  const sourceDir = getProjectDir(projectId, 'source');
  const audioDir = getProjectDir(projectId, 'audio');
  const resolved = resolveTranscriptionAudio(project, sourceDir, audioDir);

  if (!resolved) {
    jobManager.failJob(jobId, 'No hay audio disponible para transcribir. Genera una mezcla en Sync primero.');
    return;
  }

  const transcriptionDir = getProjectDir(projectId, 'transcription');

  // Convert to compressed mp3 for Groq (48kbps mono → ~11MB for 30min)
  const groqInput = path.join(transcriptionDir, 'groq_input.mp3');
  jobManager.updateProgress(jobId, 5, 'Comprimiendo audio para Groq...');

  try {
    await convertForGroq(resolved.path, groqInput);
  } catch (err) {
    jobManager.failJob(jobId, `Error al comprimir audio: ${(err as Error).message}`);
    return;
  }

  // Check file size
  const stat = await fs.stat(groqInput);
  if (stat.size > MAX_FILE_SIZE) {
    jobManager.failJob(jobId,
      `Audio comprimido (${(stat.size / 1024 / 1024).toFixed(1)}MB) excede el límite de Groq (25MB). ` +
      `Usa un audio más corto o el motor local.`
    );
    return;
  }

  jobManager.updateProgress(jobId, 15, `Enviando a Groq (${(stat.size / 1024 / 1024).toFixed(1)}MB)...`);

  try {
    // Build multipart form data
    const fileBuffer = await fs.readFile(groqInput);
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });
    formData.append('file', blob, 'audio.mp3');
    formData.append('model', model);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    formData.append('timestamp_granularities[]', 'segment');
    formData.append('temperature', '0');

    if (language && language !== 'auto') {
      formData.append('language', language);
    }

    jobManager.updateProgress(jobId, 20, 'Transcribiendo en Groq...');

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMsg = `Groq API error ${response.status}`;
      try {
        const errJson = JSON.parse(errorBody);
        errorMsg = errJson.error?.message || errorMsg;
      } catch { /* use raw */ }
      jobManager.failJob(jobId, errorMsg);
      return;
    }

    jobManager.updateProgress(jobId, 85, 'Procesando resultado...');

    const result = await response.json();

    // Convert Groq response to SubtitleSegment format
    // Groq verbose_json returns segments[] and words[] at top level
    const groqSegments = result.segments || [];
    const groqWords = result.words || [];

    // Build a word lookup by time for mapping words to segments
    const segments: SubtitleSegment[] = groqSegments.map(
      (seg: { id: number; start: number; end: number; text: string }) => {
        // Find words that belong to this segment by time overlap
        const segWords = groqWords.filter(
          (w: { word: string; start: number; end: number }) =>
            w.start >= seg.start - 0.01 && w.end <= seg.end + 0.01
        );

        return {
          id: uuidv4(),
          startMs: Math.round(seg.start * 1000),
          endMs: Math.round(seg.end * 1000),
          text: seg.text.trim(),
          words: segWords.map((w: { word: string; start: number; end: number }) => ({
            text: w.word.trim(),
            startMs: Math.round(w.start * 1000),
            endMs: Math.round(w.end * 1000),
          })),
        };
      }
    );

    // Save raw response for debugging
    await fs.writeFile(
      path.join(transcriptionDir, 'groq_result.json'),
      JSON.stringify(result, null, 2)
    );

    // Update project
    const currentProject = await getProject(projectId);
    if (currentProject) {
      await updateProject(projectId, {
        transcription: {
          ...currentProject.transcription,
          status: 'done',
          language: result.language || language,
          model,
          segments,
        },
      });
    }

    jobManager.completeJob(jobId, {
      segmentCount: segments.length,
      language: result.language || language,
      duration: result.duration,
      engine: 'groq',
    });
  } catch (err) {
    jobManager.failJob(jobId, `Error en transcripción Groq: ${(err as Error).message}`);
  }
}
