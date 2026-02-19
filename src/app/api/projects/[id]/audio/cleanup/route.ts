import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { applyAudioFilters } from '@/server/ffmpeg-wrapper';
import { jobManager } from '@/server/job-manager';
import { audioCleanupSettingsSchema } from '@/lib/schemas';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Use ambient from guided subtraction
  const inputPath = project.audio.ambientPath;
  if (!inputPath) {
    return NextResponse.json(
      { error: 'Primero ejecuta la sustracción guiada para obtener el audio ambiente.' },
      { status: 400 }
    );
  }

  const body = await request.json();
  const parsed = audioCleanupSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const settings = parsed.data;
  const audioDir = getProjectDir(id, 'audio');

  // Name output based on input ambient + cleanup params
  const inputName = path.basename(inputPath, '.wav');
  const cleanSuffix = `eq${settings.eqFrequency}_nr${settings.noiseReduction}`;
  const outputPath = path.join(audioDir, `${inputName}_clean_${cleanSuffix}.wav`);

  // Build FFmpeg filter string
  const filters = [
    `equalizer=f=${settings.eqFrequency}:t=q:w=${settings.eqWidth}:g=${settings.eqGain}`,
    `compand=attacks=0.3:decays=0.8:points=-80/-80|-${Math.abs(settings.compressorThreshold)}/-${Math.abs(settings.compressorThreshold)}|0/-${Math.abs(settings.compressorThreshold) / settings.compressorRatio}|20/20`,
    `alimiter=limit=${settings.limiterLevel}`,
    `anlmdn=s=${settings.noiseReduction}:p=${settings.noiseFloor}`,
  ].join(',');

  const job = jobManager.createJob(id, 'audio-cleanup');
  jobManager.startJob(job.id);

  // Run in background
  (async () => {
    try {
      jobManager.updateProgress(job.id, 10, 'Applying audio filters...');

      const { promise, process: proc } = applyAudioFilters({
        inputPath,
        outputPath,
        filters,
      });
      jobManager.setProcess(job.id, proc);

      await promise;

      // Update project
      const currentProject = await getProject(id);
      if (currentProject) {
        await updateProject(id, {
          audio: {
            ...currentProject.audio,
            cleanupApplied: true,
            cleanupSettings: settings,
            cameraAmbientPath: outputPath,
          },
        });
      }

      jobManager.completeJob(job.id, { outputPath });
    } catch (err) {
      jobManager.failJob(job.id, (err as Error).message);
    }
  })();

  return NextResponse.json({ jobId: job.id });
}
