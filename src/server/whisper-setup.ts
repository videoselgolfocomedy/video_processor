import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

const WHISPER_DIR = path.join(process.cwd(), '.whisper');
const WHISPER_BIN = path.join(WHISPER_DIR, 'whisper.cpp', 'main');
const MODELS_DIR = path.join(WHISPER_DIR, 'models');

export interface WhisperStatus {
  installed: boolean;
  binary?: string;
  models: string[];
}

export async function checkWhisperStatus(): Promise<WhisperStatus> {
  try {
    await fs.access(WHISPER_BIN);

    // List available models
    const models: string[] = [];
    try {
      const entries = await fs.readdir(MODELS_DIR);
      for (const entry of entries) {
        if (entry.startsWith('ggml-') && entry.endsWith('.bin')) {
          const modelName = entry.replace('ggml-', '').replace('.bin', '');
          models.push(modelName);
        }
      }
    } catch {
      // Models dir may not exist
    }

    return { installed: true, binary: WHISPER_BIN, models };
  } catch {
    // Check for system whisper-cpp
    try {
      await execFileAsync('which', ['whisper-cpp'], { timeout: 5000 });
      return { installed: true, binary: 'whisper-cpp', models: [] };
    } catch {
      // Check for OpenAI whisper CLI
      try {
        await execFileAsync('which', ['whisper'], { timeout: 5000 });
        return { installed: true, binary: 'whisper', models: [] };
      } catch {
        return { installed: false, models: [] };
      }
    }
  }
}

export function getWhisperBinary(): string {
  // Try local whisper.cpp first, then system whisper
  return WHISPER_BIN;
}

export function getModelPath(model: string): string {
  return path.join(MODELS_DIR, `ggml-${model}.bin`);
}
