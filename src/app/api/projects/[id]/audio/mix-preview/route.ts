import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getProject, getProjectDir } from '@/server/project-manager';
import { jobManager } from '@/server/job-manager';

const execFileAsync = promisify(execFile);

function getFFmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
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
  const boardVolume = Number(body.boardVolume ?? 1);
  const ambientVolume = Number(body.ambientVolume ?? 0.5);
  const manualAdjustMs = Number(body.manualAdjustMs ?? 0);

  // Find board audio path
  const boardSource = project.sources.find((s) => s.role === 'board');
  if (!boardSource) {
    return NextResponse.json({ error: 'No hay audio de mesa' }, { status: 400 });
  }
  const boardTrack = project.audio.extractedTracks.find(
    (t) => t.sourceFileId === boardSource.id
  );
  const boardPath = boardTrack?.path ||
    (boardSource.type === 'audio'
      ? path.join(getProjectDir(id, 'source'), boardSource.storedName)
      : null);

  if (!boardPath) {
    return NextResponse.json({ error: 'Audio de mesa no disponible' }, { status: 400 });
  }

  // Find ambient path
  const ambientPath = project.audio.ambientPath;
  if (!ambientPath) {
    return NextResponse.json(
      { error: 'No hay audio ambiente. Ejecuta la sustracción primero.' },
      { status: 400 }
    );
  }

  // Total offset = auto alignment + manual fine-tune
  // Positive offset = board starts before camera by this many ms
  // The ambient covers the camera's timeline, so we trim board from offset
  const autoOffsetMs = project.audio.alignmentOffsetMs ?? 0;
  const totalOffsetMs = autoOffsetMs + manualAdjustMs;
  const offsetSec = Math.max(0, totalOffsetMs / 1000);

  const audioDir = getProjectDir(id, 'audio');
  const ambientName = path.basename(ambientPath, '.wav');
  const adjustStr = manualAdjustMs !== 0 ? `_adj${manualAdjustMs}` : '';
  const outputPath = path.join(
    audioDir,
    `mix_${ambientName}_bv${boardVolume}_av${ambientVolume}${adjustStr}.wav`
  );

  const job = jobManager.createJob(id, 'mix-preview');
  jobManager.startJob(job.id);

  (async () => {
    try {
      jobManager.updateProgress(job.id, 10,
        `Mezclando (offset: ${(totalOffsetMs / 1000).toFixed(2)}s, adj: ${manualAdjustMs}ms)...`
      );

      const ffmpeg = getFFmpegPath();

      // FFmpeg filter_complex:
      // 1. Trim board from total offset (auto + manual) for precise sync
      // 2. Reset timestamps after trim
      // 3. Adjust volumes
      // 4. Mix using shortest duration (= ambient length)
      const filterComplex = [
        `[0:a]atrim=start=${offsetSec},asetpts=PTS-STARTPTS,volume=${boardVolume}[board]`,
        `[1:a]volume=${ambientVolume}[amb]`,
        `[board][amb]amix=inputs=2:duration=shortest[out]`,
      ].join(';');

      const args = [
        '-i', boardPath,
        '-i', ambientPath,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-acodec', 'pcm_s16le',
        '-ar', '48000',
        '-y',
        outputPath,
      ];

      await execFileAsync(ffmpeg, args, { timeout: 600000 });

      jobManager.completeJob(job.id, { outputPath });
    } catch (err) {
      jobManager.failJob(job.id, (err as Error).message);
    }
  })();

  return NextResponse.json({ jobId: job.id, outputName: path.basename(outputPath) });
}
