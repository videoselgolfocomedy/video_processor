import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import unzipper from 'unzipper';
import { Readable } from 'stream';
import { PROJECTS_DIR, PROJECT_DIRS } from '@/lib/constants';
import type { ProjectState } from '@/types/project';

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
    let manifest: { requiredFiles?: { role: string; fileName: string; originalName: string }[]; audioFiles?: { name: string; role: string }[] } | null = null;
    if (manifestEntry) {
      const manifestBuffer = await manifestEntry.buffer();
      manifest = JSON.parse(manifestBuffer.toString('utf-8'));
    }

    // Create new project with a new ID
    const newId = uuidv4();
    const projectDir = path.join(PROJECTS_DIR, newId);

    // Create all subdirectories
    await fs.mkdir(projectDir, { recursive: true });
    for (const subdir of Object.values(PROJECT_DIRS)) {
      await fs.mkdir(path.join(projectDir, subdir), { recursive: true });
    }

    // Update project with new ID and fix paths
    const newProject: ProjectState = {
      ...restoredProject,
      id: newId,
      name: restoredProject.name + ' (restored)',
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

    // Build list of missing files that the user needs to re-import
    const missingFiles: { fileName: string; originalName: string; role: string }[] = [];
    if (manifest?.requiredFiles) {
      for (const req of manifest.requiredFiles) {
        missingFiles.push({
          fileName: req.fileName,
          originalName: req.originalName,
          role: req.role,
        });
      }
    }

    return NextResponse.json({
      projectId: newId,
      projectName: fixedProject.name,
      restoredFiles,
      missingFiles,
      message: missingFiles.length > 0
        ? `Project restored. Import the source files in the Import page: ${missingFiles.map((f) => f.originalName).join(', ')}`
        : 'Project fully restored.',
    });
  } catch (err) {
    console.error('[restore] Error:', err);
    return NextResponse.json(
      { error: `Restore failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
