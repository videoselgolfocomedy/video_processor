import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';
import { applyAudioFilters } from '@/server/ffmpeg-wrapper';
import { jobManager } from '@/server/job-manager';
import type { AudioAmplifySettings } from '@/types/project';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Find the board (desk) audio source
  const boardSource = project.sources.find((s) => s.role === 'board');
  if (!boardSource) {
    return NextResponse.json(
      { error: 'No hay audio de mesa (board) importado. Importa el archivo de audio primero.' },
      { status: 400 }
    );
  }

  const sourceDir = getProjectDir(id, 'source');
  const audioDir = getProjectDir(id, 'audio');
  const inputPath = path.join(sourceDir, boardSource.storedName);

  const body = await request.json() as AudioAmplifySettings;
  const settings = body;

  // Build output filename
  const baseName = path.basename(boardSource.storedName, path.extname(boardSource.storedName));
  const suffix = settings.mode === 'loudnorm'
    ? `loud${Math.abs(settings.targetLUFS)}`
    : settings.mode === 'gain'
      ? `gain${settings.gainDb > 0 ? '+' : ''}${settings.gainDb}`
      : `loud${Math.abs(settings.targetLUFS)}_gain${settings.gainDb > 0 ? '+' : ''}${settings.gainDb}`;
  const outputPath = path.join(audioDir, `${baseName}_amplified_${suffix}.wav`);

  // Build FFmpeg filter chain
  const filters: string[] = [];

  // 1. Optional compressor (before gain/normalization to even out dynamics)
  if (settings.compressor) {
    const thresh = Math.abs(settings.compressorThreshold);
    const ratio = settings.compressorRatio;
    // compand: attack 5ms, decay 100ms
    filters.push(
      `compand=attacks=0.005:decays=0.1:points=-80/-80|-${thresh}/-${thresh}|0/-${Math.round(thresh / ratio)}|20/20`
    );
  }

  // 2. Simple gain boost
  if (settings.mode === 'gain' || settings.mode === 'both') {
    filters.push(`volume=${settings.gainDb}dB`);
  }

  // 3. Loudness normalization (EBU R128 / broadcast standard)
  if (settings.mode === 'loudnorm' || settings.mode === 'both') {
    filters.push(
      `loudnorm=I=${settings.targetLUFS}:TP=${settings.truePeak}:LRA=11:print_format=summary`
    );
  }

  // 4. Safety limiter to prevent clipping
  filters.push('alimiter=limit=0.95:attack=5:release=50');

  const job = jobManager.createJob(id, 'audio-amplify');
  jobManager.startJob(job.id);

  (async () => {
    try {
      jobManager.updateProgress(job.id, 10, 'Amplificando audio de mesa...');

      const { promise, process: proc } = applyAudioFilters({
        inputPath,
        outputPath,
        filters: filters.join(','),
      });
      jobManager.setProcess(job.id, proc);

      await promise;

      // Update project state
      const currentProject = await getProject(id);
      if (currentProject) {
        await updateProject(id, {
          audio: {
            ...currentProject.audio,
            amplifyApplied: true,
            amplifySettings: settings,
            amplifiedBoardPath: outputPath,
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
