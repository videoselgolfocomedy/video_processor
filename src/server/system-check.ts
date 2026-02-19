import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execFileAsync = promisify(execFile);

export interface SystemStatus {
  ffmpeg: DependencyStatus;
  python: DependencyStatus;
  demucs: DependencyStatus;
  diskSpace: DiskSpaceStatus;
}

export interface DependencyStatus {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface DiskSpaceStatus {
  available: boolean;
  freeGB?: number;
  error?: string;
}

async function checkCommand(
  command: string,
  args: string[]
): Promise<DependencyStatus> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10000 });
    const version = stdout.trim().split('\n')[0];
    return { available: true, version, path: command };
  } catch {
    return { available: false, error: `${command} not found` };
  }
}

async function checkFFmpeg(): Promise<DependencyStatus> {
  // Try npm ffmpeg-static first
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStatic = require('ffmpeg-static') as string;
    const { stdout } = await execFileAsync(ffmpegStatic, ['-version'], {
      timeout: 10000,
    });
    const version = stdout.trim().split('\n')[0];
    return { available: true, version, path: ffmpegStatic };
  } catch {
    // Fall back to system ffmpeg
    return checkCommand('ffmpeg', ['-version']);
  }
}

async function checkPython(): Promise<DependencyStatus> {
  // Try python3 first, then python
  const result = await checkCommand('python3', ['--version']);
  if (result.available) return result;
  return checkCommand('python', ['--version']);
}

async function checkDemucs(): Promise<DependencyStatus> {
  try {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', 'import demucs; print(demucs.__version__)'],
      { timeout: 30000 }
    );
    return {
      available: true,
      version: stdout.trim() || 'installed',
    };
  } catch {
    return {
      available: false,
      error: 'Demucs not installed. Run: pip3 install demucs',
    };
  }
}

async function checkDiskSpace(): Promise<DiskSpaceStatus> {
  try {
    const { stdout } = await execFileAsync('df', ['-g', process.cwd()], {
      timeout: 5000,
    });
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const freeGB = parseInt(parts[3], 10);
      return { available: freeGB > 1, freeGB };
    }
    return { available: true };
  } catch {
    // Try alternative for Linux
    try {
      const stat = await fs.stat(process.cwd());
      return { available: true, freeGB: undefined };
      void stat;
    } catch {
      return { available: false, error: 'Could not check disk space' };
    }
  }
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const [ffmpeg, python, demucs, diskSpace] = await Promise.all([
    checkFFmpeg(),
    checkPython(),
    checkDemucs(),
    checkDiskSpace(),
  ]);

  return { ffmpeg, python, demucs, diskSpace };
}
