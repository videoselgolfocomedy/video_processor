import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getProject, getProjectDir } from '@/server/project-manager';
import { getFFmpegPath } from '@/server/ffmpeg-wrapper';

const execFileAsync = promisify(execFile);
const inflight = new Map<string, Promise<void>>();

/**
 * Regenerate a part's RAW MESA wav (`part_<id8>_board.wav`) on demand when it
 * is missing from audio/. It is a pure function of the board source (48 kHz
 * mono s16 — the same conversion stage 2 of the part pipeline runs), and it is
 * what the je-je panel, the alignment view and every "gris = original"
 * reference draw. On a real project it vanished because the storage panel
 * listed every part-derived file as an orphan; instead of a blank panel the
 * routes that serve it now rebuild it first (one conversion shared between
 * concurrent callers). Any other name is a no-op.
 */
export async function ensurePartBoardWav(projectId: string, safeName: string): Promise<void> {
  const m = /^part_([0-9a-f]{8})_board\.wav$/i.exec(safeName);
  if (!m) return;
  const audioDir = getProjectDir(projectId, 'audio');
  const target = path.join(audioDir, safeName);
  try {
    const st = await fs.stat(target);
    if (st.size > 44) return;
  } catch { /* missing → regenerate below */ }

  let p = inflight.get(target);
  if (!p) {
    p = (async () => {
      const project = await getProject(projectId);
      const part = (project?.parts ?? []).find((x) => x.id.slice(0, 8).toLowerCase() === m[1].toLowerCase());
      const board = part?.boardSourceId ? project!.sources.find((s) => s.id === part.boardSourceId) : undefined;
      if (!board) return;
      const src = path.join(getProjectDir(projectId, 'source'), board.storedName);
      await fs.access(src);
      await fs.mkdir(audioDir, { recursive: true });
      const tmp = path.join(audioDir, `.${safeName}.tmp-${process.pid}.wav`);
      console.log(`[part-files] ${safeName} no está en audio/ — regenerando desde ${board.storedName}`);
      const t0 = Date.now();
      try {
        await execFileAsync(getFFmpegPath(), [
          '-y', '-i', src, '-vn', '-ar', '48000', '-ac', '1', '-sample_fmt', 's16', tmp,
        ], { timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
        await fs.rename(tmp, target);
        console.log(`[part-files] ${safeName} regenerado en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
    })().finally(() => inflight.delete(target));
    inflight.set(target, p);
  }
  await p;
}
