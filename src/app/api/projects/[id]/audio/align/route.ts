import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getProject, updateProject, getProjectDir } from '@/server/project-manager';

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
  const boardVolume = body.boardVolume ?? project.sync.boardVolume ?? 1;
  const cameraAmbientVolume = body.cameraAmbientVolume ?? project.sync.cameraAmbientVolume ?? 0.7;

  // Board audio = clean voice from desk mixer
  const boardSource = project.sources.find((s) => s.role === 'board');
  let boardAudioPath: string | undefined;

  if (boardSource) {
    if (boardSource.type === 'audio') {
      boardAudioPath = path.join(getProjectDir(id, 'source'), boardSource.storedName);
    } else {
      const boardTrack = project.audio.extractedTracks.find(
        (t) => t.sourceFileId === boardSource.id
      );
      boardAudioPath = boardTrack?.path;
    }
  }

  // Camera ambient = extracted via guided subtraction (optionally cleaned)
  const cameraAmbientPath = project.audio.cameraAmbientPath || project.audio.ambientPath;

  if (!boardAudioPath) {
    return NextResponse.json(
      { error: 'No hay audio de mesa. Sube un audio y márcalo como Mesa.' },
      { status: 400 }
    );
  }

  if (!cameraAmbientPath) {
    return NextResponse.json(
      { error: 'No hay ambiente de cámara. Ejecuta la sustracción guiada primero.' },
      { status: 400 }
    );
  }

  // Use alignment offset to sync board with ambient
  // The ambient covers the overlap region of the camera.
  // Board needs to be trimmed from alignmentOffsetMs to match.
  const alignmentOffsetMs = project.audio.alignmentOffsetMs ?? 0;
  const offsetSec = Math.max(0, alignmentOffsetMs / 1000);

  const audioDir = getProjectDir(id, 'audio');
  const outputPath = path.join(audioDir, 'mixed.wav');

  try {
    const ffmpeg = getFFmpegPath();

    // Trim board from alignment offset, adjust volumes, mix with ambient
    const filterComplex = [
      `[0:a]atrim=start=${offsetSec},asetpts=PTS-STARTPTS,volume=${boardVolume}[board]`,
      `[1:a]volume=${cameraAmbientVolume}[amb]`,
      `[board][amb]amix=inputs=2:duration=shortest[out]`,
    ].join(';');

    const args = [
      '-i', boardAudioPath,
      '-i', cameraAmbientPath,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-y',
      outputPath,
    ];

    await execFileAsync(ffmpeg, args, { timeout: 600000 });

    await updateProject(id, {
      sync: {
        ...project.sync,
        status: 'done',
        offsetMs: alignmentOffsetMs,
        boardVolume,
        cameraAmbientVolume,
        mixedAudioPath: outputPath,
      },
      audio: {
        ...project.audio,
        boardAudioPath,
        cameraAmbientPath,
      },
    });

    return NextResponse.json({ ok: true, outputPath });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
