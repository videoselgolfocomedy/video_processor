import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';
import { runDemucs } from '@/server/workers/demucs-worker';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Find the camera source video
  const cameraSource = project.sources.find(
    (s) => s.role === 'camera' && s.type === 'video'
  );

  if (!cameraSource) {
    return NextResponse.json(
      { error: 'No camera video found. Upload a video and mark it as Cámara.' },
      { status: 400 }
    );
  }

  // Find the extracted audio track from the camera source
  const cameraTrack = project.audio.extractedTracks.find(
    (t) => t.sourceFileId === cameraSource.id
  );

  if (!cameraTrack) {
    return NextResponse.json(
      { error: 'Camera audio not extracted yet. Extract audio from the camera video first.' },
      { status: 400 }
    );
  }

  const inputPath = cameraTrack.path;

  const job = jobManager.createJob(id, 'demucs');
  jobManager.startJob(job.id);

  // Update project status
  await updateProject(id, {
    audio: {
      ...project.audio,
      demucsStatus: 'running',
      demucsJobId: job.id,
      demucsSourceId: cameraSource.id,
    },
  });

  runDemucs({
    projectId: id,
    inputPath,
    jobId: job.id,
    twoStems: true,
  });

  return NextResponse.json({ jobId: job.id });
}
