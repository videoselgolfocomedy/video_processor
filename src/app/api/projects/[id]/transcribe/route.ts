import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { runWhisperTranscription, resolveTranscriptionAudio } from '@/server/workers/whisper-worker';
import { runGroqTranscription } from '@/server/workers/groq-whisper-worker';
import { resolveKey } from '@/server/settings-manager';

/**
 * GET /api/projects/[id]/transcribe
 * Returns which audio file would be transcribed (for UI display).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const sourceDir = getProjectDir(id, 'source');
  const audioDir = getProjectDir(id, 'audio');
  const resolved = resolveTranscriptionAudio(project, sourceDir, audioDir);

  // Check both env var and the key saved via /settings (resolveKey reads both).
  // The rest of the codebase already uses resolveKey('groq') — this endpoint
  // was the outlier, leaving the UI permanently disabled even when the user
  // had pasted the key into Settings.
  const groqKey = await resolveKey('groq');

  return NextResponse.json({
    audioSource: resolved
      ? { path: resolved.path, label: resolved.label, fileName: resolved.path.split('/').pop() }
      : null,
    groqAvailable: !!groqKey,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json();
  const language = body.language || 'auto';
  const model = body.model || 'medium';
  const engine: string = body.engine || 'local';

  const job = jobManager.createJob(id, 'transcribe');
  jobManager.startJob(job.id);

  // Update project status
  await updateProject(id, {
    transcription: {
      ...project.transcription,
      status: 'running',
      jobId: job.id,
      language,
      model,
    },
  });

  // Run in background
  if (engine === 'groq') {
    runGroqTranscription({
      projectId: id,
      jobId: job.id,
      language,
      model,
    });
  } else {
    runWhisperTranscription({
      projectId: id,
      jobId: job.id,
      language,
      model,
    });
  }

  return NextResponse.json({ jobId: job.id });
}
