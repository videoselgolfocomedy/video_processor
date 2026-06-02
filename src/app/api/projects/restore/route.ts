import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import unzipper from 'unzipper';
import { Readable } from 'stream';
import { PROJECTS_DIR, PROJECT_DIRS } from '@/lib/constants';
import { slugify } from '@/lib/utils';
import { refreshProjectIndex } from '@/server/project-manager';
import type { ProjectState } from '@/types/project';

/** Match the naming used by project-manager.createProject. */
function newProjectFolderName(id: string, name: string): string {
  const slug = (slugify(name) || 'project').slice(0, 60);
  return `${slug}_${id.slice(0, 8)}`;
}

/**
 * POST /api/projects/restore → Restore project from backup zip
 *
 * Creates a new project from the backup zip.
 * Restores project.json, SRTs, compose media, fonts.
 * Returns info about what was restored and what files are missing.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Read the zip into a buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Parse zip
    const directory = await unzipper.Open.buffer(buffer);

    // Find and read project.json
    const projectJsonEntry = directory.files.find((f) => f.path === 'project.json');
    if (!projectJsonEntry) {
      return NextResponse.json({ error: 'No project.json found in backup' }, { status: 400 });
    }

    const projectJsonBuffer = await projectJsonEntry.buffer();
    const restoredProject = JSON.parse(projectJsonBuffer.toString('utf-8')) as ProjectState;

    // Find and read manifest
    const manifestEntry = directory.files.find((f) => f.path === 'manifest.json');
    type ManifestFileRef = {
      role: string;
      fileName: string;
      originalName?: string;
      size?: number;
      relativePath?: string;
      originalPath?: string;
    };
    type Manifest = {
      version?: string;
      // v2 fields (current)
      requiredFiles?: ManifestFileRef[];
      recommendedFiles?: ManifestFileRef[];
      regenerableFiles?: ManifestFileRef[];
      // v1 legacy field
      audioFiles?: { name: string; role: string; size?: number }[];
    };
    let manifest: Manifest | null = null;
    if (manifestEntry) {
      const manifestBuffer = await manifestEntry.buffer();
      manifest = JSON.parse(manifestBuffer.toString('utf-8'));
    }

    // Create new project with a new ID. The folder name uses the same
    // <slug>_<id8> convention as createProject() so the restored project
    // is human-readable on disk just like a freshly-created one.
    const newId = uuidv4();
    const restoredName = (restoredProject.name || 'project') + ' (restored)';
    const folderName = newProjectFolderName(newId, restoredName);
    const projectDir = path.join(PROJECTS_DIR, folderName);

    // Create all subdirectories
    await fs.mkdir(projectDir, { recursive: true });
    for (const subdir of Object.values(PROJECT_DIRS)) {
      await fs.mkdir(path.join(projectDir, subdir), { recursive: true });
    }

    // Update project with new ID and fix paths
    const newProject: ProjectState = {
      ...restoredProject,
      id: newId,
      name: restoredName,
      updatedAt: new Date().toISOString(),
      // Clear job statuses (not transferable)
      audio: {
        ...restoredProject.audio,
        demucsStatus: restoredProject.audio.demucsStatus === 'running' ? 'idle' : restoredProject.audio.demucsStatus,
        subtractionStatus: restoredProject.audio.subtractionStatus === 'running' ? 'idle' : restoredProject.audio.subtractionStatus,
        laughterStatus: restoredProject.audio.laughterStatus === 'running' ? 'idle' : restoredProject.audio.laughterStatus,
        demucsJobId: undefined,
        subtractionJobId: undefined,
        laughterJobId: undefined,
      },
      sync: {
        ...restoredProject.sync,
        status: restoredProject.sync.status === 'syncing' ? 'idle' : restoredProject.sync.status,
        muxedVideoPath: undefined, // Will need to be regenerated
      },
      transcription: {
        ...restoredProject.transcription,
        status: restoredProject.transcription.status === 'running' ? 'done' : restoredProject.transcription.status,
      },
      exports: [], // Clear exports
    };

    // Restore relative paths in project.json (replace ./ with new project dir)
    const projectJson = JSON.stringify(newProject);
    const fixedJson = projectJson.replace(/"\.\//g, `"${projectDir}/`);
    const fixedProject = JSON.parse(fixedJson) as ProjectState;

    // Save project.json
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify(fixedProject, null, 2),
      'utf-8'
    );

    // Extract included files (SRTs, compose media, fonts)
    const restoredFiles: string[] = [];
    for (const entry of directory.files) {
      if (entry.path === 'project.json' || entry.path === 'manifest.json') continue;
      if (entry.type === 'Directory') continue;

      const targetPath = path.join(projectDir, entry.path);
      const targetDir = path.dirname(targetPath);
      await fs.mkdir(targetDir, { recursive: true });

      const content = await entry.buffer();
      await fs.writeFile(targetPath, content);
      restoredFiles.push(entry.path);
    }

    // Build the file-copy report. Each entry has:
    // - originalPath: where the file lived on the source machine (helps the
    //   user locate it before copying)
    // - destinationPath: ABSOLUTE path on the new machine where it must land
    //   for the project to find it
    // - relativePath: project-relative version of destinationPath
    // - tier: required (must) | recommended (saves rework) | regenerable (can
    //   be skipped, mux step rebuilds it)
    type CopyTarget = {
      role: string;
      fileName: string;
      originalName?: string;
      size?: number;
      relativePath: string;
      originalPath?: string;
      destinationPath: string;
      tier: 'required' | 'recommended' | 'regenerable';
    };
    const buildTarget = (f: ManifestFileRef, tier: CopyTarget['tier']): CopyTarget => {
      // Older v1 backups didn't store relativePath; we infer it from role/role conventions.
      const relativePath = f.relativePath
        ?? (tier === 'required' ? `source/${f.fileName}` : `audio/${f.fileName}`);
      return {
        role: f.role,
        fileName: f.fileName,
        originalName: f.originalName,
        size: f.size,
        relativePath,
        originalPath: f.originalPath,
        destinationPath: path.join(projectDir, relativePath),
        tier,
      };
    };

    const requiredCopy: CopyTarget[] = (manifest?.requiredFiles ?? []).map((f) => buildTarget(f, 'required'));
    const recommendedCopy: CopyTarget[] = (manifest?.recommendedFiles ?? [])
      .map((f) => buildTarget(f, 'recommended'));
    // v1 backups: audioFiles → treat as recommended
    if ((!manifest?.recommendedFiles || manifest.recommendedFiles.length === 0) && manifest?.audioFiles?.length) {
      for (const af of manifest.audioFiles) {
        recommendedCopy.push(buildTarget({
          role: af.role,
          fileName: af.name,
          size: af.size,
          relativePath: `audio/${af.name}`,
        }, 'recommended'));
      }
    }
    const regenerableCopy: CopyTarget[] = (manifest?.regenerableFiles ?? []).map((f) => buildTarget(f, 'regenerable'));

    // Filter out anything that's already on disk (compose/* extras may have
    // been bundled in the zip and copied above; skip those from the missing list).
    const reallyMissing = async (t: CopyTarget) => {
      try { await fs.access(t.destinationPath); return false; } catch { return true; }
    };
    const requiredFiles = (await Promise.all(requiredCopy.map(async (t) => (await reallyMissing(t)) ? t : null))).filter(Boolean) as CopyTarget[];
    const recommendedFiles = (await Promise.all(recommendedCopy.map(async (t) => (await reallyMissing(t)) ? t : null))).filter(Boolean) as CopyTarget[];
    const regenerableFiles = (await Promise.all(regenerableCopy.map(async (t) => (await reallyMissing(t)) ? t : null))).filter(Boolean) as CopyTarget[];

    // Legacy field for any callers still reading missingFiles; populated only
    // with the truly required ones.
    const legacyMissingFiles = requiredFiles.map((f) => ({
      fileName: f.fileName,
      originalName: f.originalName,
      role: f.role,
    }));

    // Tell the project-manager cache about this new folder so subsequent
    // getProjectDir(newId) calls resolve to the right path without scanning.
    refreshProjectIndex();

    return NextResponse.json({
      projectId: newId,
      projectName: fixedProject.name,
      projectDir,
      restoredFiles,
      requiredFiles,
      recommendedFiles,
      regenerableFiles,
      // legacy alias
      missingFiles: legacyMissingFiles,
      message: requiredFiles.length > 0
        ? `Proyecto restaurado. Faltan ${requiredFiles.length} archivos imprescindibles + ${recommendedFiles.length} recomendados. Cópialos manualmente desde la máquina origen a las rutas indicadas.`
        : recommendedFiles.length > 0
          ? `Proyecto restaurado. ${recommendedFiles.length} archivos de audio recomendados pueden copiarse para evitar reprocesar (o se regeneran).`
          : 'Proyecto totalmente restaurado.',
    });
  } catch (err) {
    console.error('[restore] Error:', err);
    return NextResponse.json(
      { error: `Restore failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
