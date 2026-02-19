import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { INBOX_DIR, SUPPORTED_EXTENSIONS } from '@/lib/constants';

export interface InboxFile {
  name: string;
  size: number;
  modifiedAt: string;
  type: 'video' | 'audio';
}

export async function GET() {
  try {
    await fs.mkdir(INBOX_DIR, { recursive: true });
    const entries = await fs.readdir(INBOX_DIR, { withFileTypes: true });

    const files: InboxFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

      const stat = await fs.stat(path.join(INBOX_DIR, entry.name));
      const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
      files.push({
        name: entry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        type: isVideo ? 'video' : 'audio',
      });
    }

    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return NextResponse.json({ path: INBOX_DIR, files });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
