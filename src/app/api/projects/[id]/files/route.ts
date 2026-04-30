import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { getProject, getProjectDir } from '@/server/project-manager';
import type { ProjectState, ExportRecord, AudioTrack } from '@/types/project';

interface FileInfo {
  name: string;
  size: number;
  mtimeMs: number;
  category: 'audio' | 'export' | 'compose' | 'transcription';
  /** true if some part of project.json still references this file */
  referenced: boolean;
  /** Why it's referenced (or what category of intermediate it is) */
  role: string;
}

/**
 * Build the set of file names that the project.json currently references.
 * Anything NOT in this set is safe to delete to save space.
 */
function collectReferencedFiles(project: ProjectState): Map<string, string> {
  const refs = new Map<string, string>();

  const add = (filePath: string | undefined | null, role: string) => {
    if (!filePath) return;
    const name = filePath.split('/').pop();
    if (name) refs.set(name, role);
  };

  // Audio
  for (const t of project.audio.extractedTracks ?? [] as AudioTrack[]) {
    add(t.path, 'Audio extraído');
  }
  add(project.audio.ambientPath, 'Ambiente (sustracción)');
  add(project.audio.amplifiedBoardPath, 'Mesa amplificada');
  add(project.audio.boardAudioPath, 'Mesa origen');
  add(project.audio.cameraAmbientPath, 'Ambiente cámara');
  // Demucs stems
  if (project.audio.stems) {
    add(project.audio.stems.vocals, 'Demucs vocals');
    add(project.audio.stems.other, 'Demucs ambiente');
    add(project.audio.stems.bass, 'Demucs bass');
    add(project.audio.stems.drums, 'Demucs drums');
  }

  // Sync
  add(project.sync.muxedVideoPath, 'Vídeo muxed (compose/export)');
  add(project.sync.mixedAudioPath, 'Mix de audio activo');
  add(project.sync.selectedAudioPath, 'Audio seleccionado');

  // Compose mediaBin
  for (const asset of project.composition?.mediaBin ?? []) {
    refs.set(asset.fileName, `Compose media: ${asset.originalName}`);
  }
  for (const clip of project.composition?.clips ?? []) {
    if (clip.fileName) {
      refs.set(clip.fileName, `Compose clip: ${clip.originalName ?? clip.fileName}`);
    }
  }

  // Reels mediaBin + clips
  for (const reel of project.reels ?? []) {
    for (const asset of reel.composition?.mediaBin ?? []) {
      refs.set(asset.fileName, `Reel "${reel.name}" media: ${asset.originalName}`);
    }
    for (const clip of reel.composition?.clips ?? []) {
      if (clip.fileName) {
        refs.set(clip.fileName, `Reel "${reel.name}" clip`);
      }
    }
  }

  // Exports
  for (const e of project.exports ?? [] as ExportRecord[]) {
    add(e.outputPath, `Export ${e.presetId} (${e.status})`);
  }

  return refs;
}

async function listDirFiles(
  dir: string,
  category: FileInfo['category'],
  referenced: Map<string, string>,
): Promise<FileInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files: FileInfo[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue; // skip .DS_Store etc
    const full = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const ref = referenced.get(name);
    files.push({
      name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      category,
      referenced: !!ref,
      role: ref ?? inferOrphanRole(name, category),
    });
  }
  return files;
}

/** Best-guess label for files not referenced by project.json */
function inferOrphanRole(name: string, category: FileInfo['category']): string {
  const lower = name.toLowerCase();
  if (category === 'audio') {
    if (lower.includes('amplified')) return 'Amplificación previa (descartada)';
    if (lower.startsWith('mix_')) return 'Mix anterior (descartado)';
    if (lower.includes('ambient_aligned')) return 'Ambiente alineado (anterior)';
    if (lower.includes('alignment')) return 'Datos alineación (anterior)';
    if (lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.flac')) return 'Audio intermedio';
  }
  if (category === 'export') {
    if (lower.startsWith('muxed_')) return 'Muxed intermedio (anterior)';
    if (lower.endsWith('.ass')) return 'Subtítulos ASS (debug)';
    if (lower.endsWith('.mp4')) return 'Export anterior';
  }
  if (category === 'compose') {
    return 'Asset compose huérfano';
  }
  if (category === 'transcription') {
    if (lower.endsWith('.json') || lower.endsWith('.srt') || lower.endsWith('.txt')) return 'Transcripción anterior';
  }
  return 'Archivo intermedio';
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const referenced = collectReferencedFiles(project);

  const [audioFiles, exportFiles, composeFiles, transcriptionFiles] = await Promise.all([
    listDirFiles(getProjectDir(id, 'audio'), 'audio', referenced),
    listDirFiles(getProjectDir(id, 'export'), 'export', referenced),
    listDirFiles(getProjectDir(id, 'compose'), 'compose', referenced),
    listDirFiles(getProjectDir(id, 'transcription'), 'transcription', referenced),
  ]);

  const all = [...audioFiles, ...exportFiles, ...composeFiles, ...transcriptionFiles];
  const totalBytes = all.reduce((s, f) => s + f.size, 0);
  const orphanBytes = all.filter((f) => !f.referenced).reduce((s, f) => s + f.size, 0);

  return NextResponse.json({
    files: all,
    totalBytes,
    orphanBytes,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const requestedNames: string[] = Array.isArray(body.names) ? body.names : [];
  const deleteAllOrphans: boolean = body.deleteAllOrphans === true;

  if (requestedNames.length === 0 && !deleteAllOrphans) {
    return NextResponse.json({ error: 'No files specified' }, { status: 400 });
  }

  const referenced = collectReferencedFiles(project);

  // Resolve names → absolute paths. We search across audio/export/compose/transcription.
  const dirs: { path: string; category: FileInfo['category'] }[] = [
    { path: getProjectDir(id, 'audio'), category: 'audio' },
    { path: getProjectDir(id, 'export'), category: 'export' },
    { path: getProjectDir(id, 'compose'), category: 'compose' },
    { path: getProjectDir(id, 'transcription'), category: 'transcription' },
  ];

  let candidateNames: Set<string>;
  if (deleteAllOrphans) {
    candidateNames = new Set<string>();
    for (const d of dirs) {
      const entries = await fs.readdir(d.path).catch(() => [] as string[]);
      for (const n of entries) {
        if (n.startsWith('.')) continue;
        if (!referenced.has(n)) candidateNames.add(n);
      }
    }
  } else {
    candidateNames = new Set(requestedNames);
  }

  const deleted: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let freedBytes = 0;

  for (const name of Array.from(candidateNames)) {
    if (!deleteAllOrphans && referenced.has(name)) {
      // Safety: refuse to delete a referenced file unless caller acknowledges via deleteAllOrphans=false + explicit
      // For an explicit per-name request, we still allow it (user knows what they're doing).
    }
    let found = false;
    for (const d of dirs) {
      const full = path.join(d.path, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) {
          freedBytes += stat.size;
          await fs.unlink(full);
          deleted.push(name);
          found = true;
          break;
        }
      } catch {
        // not in this dir, try next
      }
    }
    if (!found) {
      skipped.push({ name, reason: 'not found' });
    }
  }

  return NextResponse.json({ deleted, skipped, freedBytes });
}
