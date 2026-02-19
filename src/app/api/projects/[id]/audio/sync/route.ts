import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { computeAudioSync } from '@/server/workers/audio-sync';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const tracks = project.audio.extractedTracks;
  if (tracks.length < 2) {
    return NextResponse.json(
      { error: 'Need at least 2 audio tracks for sync' },
      { status: 400 }
    );
  }

  const job = jobManager.createJob(id, 'audio-sync');
  jobManager.startJob(job.id);

  // Run sync in background
  (async () => {
    try {
      jobManager.updateProgress(job.id, 10, 'Loading audio files...');

      const result = await computeAudioSync(tracks[0].path, tracks[1].path);

      jobManager.updateProgress(job.id, 90, 'Updating project...');

      const currentProject = await getProject(id);
      if (currentProject) {
        await updateProject(id, {
          sync: {
            ...currentProject.sync,
            status: 'done',
            offsetMs: result.offsetMs,
            confidence: result.confidence,
            referenceTrackId: tracks[0].id,
            alignTrackId: tracks[1].id,
          },
        });
      }

      jobManager.completeJob(job.id, {
        offsetMs: result.offsetMs,
        confidence: result.confidence,
      });
    } catch (err) {
      jobManager.failJob(job.id, (err as Error).message);
    }
  })();

  return NextResponse.json({ jobId: job.id });
}
