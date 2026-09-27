import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getProject, getProjectDir } from '@/server/project-manager';
import type { SubtitleSegment } from '@/types/project';

/**
 * GET /api/projects/[id]/transcription/original
 *
 * Returns the PRISTINE transcription as SubtitleSegment[] in SOURCE (muxed)
 * time, read from the raw engine output on disk — `transcription/
 * whisper_input.json` (local Whisper) or `transcription/groq_result.json`
 * (Groq). Compose/reels edits overwrite `project.transcription.segments`, so
 * these files are the only place the original survives. Used by the "fill
 * subtitle gap from original transcription" action in both composition
 * editors. When both files exist, the most recently modified wins.
 */

interface RawWord { word: string; start: number; end: number }
interface RawSegment { start: number; end: number; text: string; words?: RawWord[] }
interface RawResult { language?: string; segments?: RawSegment[]; words?: RawWord[] }

function toSegments(raw: RawResult): SubtitleSegment[] {
  const topWords = raw.words ?? [];
  return (raw.segments ?? [])
    .filter((s) => (s.text ?? '').trim().length > 0)
    .map((s) => {
      // Whisper local: per-segment words. Groq: one flat top-level words array —
      // assign by time overlap with the segment.
      const rawWords = s.words ?? topWords.filter((w) => w.end > s.start && w.start < s.end);
      return {
        id: uuidv4(),
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        text: s.text.trim(),
        words: rawWords.length > 0
          ? rawWords.map((w) => ({
              text: w.word.trim(),
              startMs: Math.round(w.start * 1000),
              endMs: Math.round(w.end * 1000),
            }))
          : undefined,
      };
    });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Proyecto no encontrado' }, { status: 404 });
  }

  const transcriptionDir = getProjectDir(id, 'transcription');
  const candidates = [
    { file: 'whisper_input.json', source: 'whisper' as const },
    { file: 'groq_result.json', source: 'groq' as const },
  ];

  let best: { filePath: string; source: string; mtimeMs: number } | null = null;
  for (const c of candidates) {
    const filePath = path.join(transcriptionDir, c.file);
    try {
      const st = await fs.stat(filePath);
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { filePath, source: c.source, mtimeMs: st.mtimeMs };
      }
    } catch {
      // file absent — try next
    }
  }

  if (!best) {
    return NextResponse.json(
      { error: 'No hay transcripción original en disco (transcription/whisper_input.json o groq_result.json). Vuelve a transcribir para regenerarla.' },
      { status: 404 }
    );
  }

  try {
    const raw: RawResult = JSON.parse(await fs.readFile(best.filePath, 'utf-8'));
    const segments = toSegments(raw);
    if (segments.length === 0) {
      return NextResponse.json({ error: 'La transcripción original está vacía.' }, { status: 404 });
    }
    return NextResponse.json({ source: best.source, segments });
  } catch (err) {
    return NextResponse.json(
      { error: `No se pudo leer la transcripción original: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
