import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { extractAudio, probeFile } from '@/server/ffmpeg-wrapper';
import { jobManager } from '@/server/job-manager';
import type { AudioTrack } from '@/types/project';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const videoSources = project.sources.filter((s) => s.type === 'video');
  if (videoSources.length === 0) {
    return NextResponse.json(
      { error: 'No video sources to extract audio from' },
      { status: 400 }
    );
  }

  const job = jobManager.createJob(id, 'audio-extract');
  jobManager.startJob(job.id);

  // Run extraction in background
  (async () => {
    try {
      const tracks: AudioTrack[] = [];
      const sourceDir = getProjectDir(id, 'source');
      const audioDir = getProjectDir(id, 'audio');

      for (let i = 0; i < videoSources.length; i++) {
        const source = videoSources[i];
        const inputPath = path.join(sourceDir, source.storedName);
        const outputName = `${source.id}_audio.wav`;
        const outputPath = path.join(audioDir, outputName);

        jobManager.updateProgress(
          job.id,
          (i / videoSources.length) * 100,
          `Extracting audio from ${source.originalName}...`
        );

        const { promise, process: proc } = extractAudio({
          inputPath,
          outputPath,
          sampleRate: 48000,
          channels: 1,
          onProgress: (percent) => {
            const overall =
              ((i + percent / 100) / videoSources.length) * 100;
            jobManager.updateProgress(job.id, overall);
          },
        });

        jobManager.setProcess(job.id, proc);
        await promise;

        // Probe the extracted audio
        const probe = await probeFile(outputPath);
        tracks.push({
          id: uuidv4(),
          sourceFileId: source.id,
          path: outputPath,
          sampleRate: probe.sampleRate || 48000,
          channels: probe.channels || 1,
          duration: probe.duration,
        });
      }

      // Update project
      const currentProject = await getProject(id);
      if (currentProject) {
        await updateProject(id, {
          audio: {
            ...currentProject.audio,
            extractedTracks: [
              ...currentProject.audio.extractedTracks,
              ...tracks,
            ],
          },
        });
      }

      jobManager.completeJob(job.id, { tracks });
    } catch (err) {
      jobManager.failJob(job.id, (err as Error).message);
    }
  })();

  return NextResponse.json({ jobId: job.id });
}
