import path from 'path';
import { promises as fs } from 'fs';
import { getProject, getProjectDir } from '@/server/project-manager';
import type { ProjectState } from '@/types/project';

/**
 * Where a media file named in the composition actually lives, in the one order
 * every route must agree on: audio/ (derived wavs) → export/ (the muxed videos)
 * → source/ (raw uploads) → the project root (reel/compose uploads land there
 * as `reel_<ts>_<name>`).
 *
 * With the STALE-MUXED fallback: the parts join writes `muxed_<ts>.mp4` and
 * deletes the previous one, but clips (and reels copied from them) keep the
 * name they were created with. Their times stay valid — the joined timeline is
 * invariant across re-joins by construction, the audio master is rebuilt on the
 * same clock — so a `muxed_*.mp4` that no longer exists resolves to the current
 * `sync.muxedVideoPath` instead of 404ing. Without this a project that was
 * re-joined once shows no waveform and serves no audio for its own main clips.
 *
 * Pass `project` when the caller already parsed project.json (it is 500+ KB on
 * a real set and the envelope endpoint is hit once per clip).
 */
export async function resolveProjectMediaPath(
  projectId: string,
  safeName: string,
  project?: ProjectState | null,
): Promise<string | null> {
  for (const dir of [
    getProjectDir(projectId, 'audio'),
    getProjectDir(projectId, 'export'),
    getProjectDir(projectId, 'source'),
    getProjectDir(projectId),
  ]) {
    const cand = path.join(dir, safeName);
    try {
      await fs.access(cand);
      return cand;
    } catch { /* try next */ }
  }
  if (/^muxed_\d+\.(mp4|mov)$/i.test(safeName)) {
    const p = project ?? (await getProject(projectId));
    const current = p?.sync?.muxedVideoPath;
    if (current) {
      try {
        await fs.access(current);
        console.log(`[project-media] ${safeName} ya no existe — se sirve el vídeo unido actual ${path.basename(current)}`);
        return current;
      } catch { /* the current one is gone too */ }
    }
  }
  return null;
}
