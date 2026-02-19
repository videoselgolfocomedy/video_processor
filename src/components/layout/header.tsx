'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Film, CheckCircle, XCircle, Loader2, Settings } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface SystemStatus {
  ffmpeg: { available: boolean; version?: string; error?: string };
  python: { available: boolean; version?: string; error?: string };
  demucs: { available: boolean; version?: string; error?: string };
  diskSpace: { available: boolean; freeGB?: number; error?: string };
}

function StatusDot({ available, label, detail }: { available: boolean | null; label: string; detail?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 text-xs">
            {available === null ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : available ? (
              <CheckCircle className="h-3 w-3 text-green-500" />
            ) : (
              <XCircle className="h-3 w-3 text-red-500" />
            )}
            <span className="text-muted-foreground">{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>{detail || (available ? 'Available' : 'Not found')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function Header() {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    fetch('/api/system/check')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-card px-4">
      <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
        <Film className="h-5 w-5 text-primary" />
        <h1 className="text-sm font-semibold">Standup Video Editor</h1>
      </Link>
      <div className="flex items-center gap-4">
        <div className="hidden sm:flex items-center gap-4">
          <StatusDot
            available={status?.ffmpeg.available ?? null}
            label="FFmpeg"
            detail={status?.ffmpeg.version || status?.ffmpeg.error}
          />
          <StatusDot
            available={status?.python.available ?? null}
            label="Python"
            detail={status?.python.version || status?.python.error}
          />
          <StatusDot
            available={status?.demucs.available ?? null}
            label="Demucs"
            detail={status?.demucs.version || status?.demucs.error}
          />
          {status?.diskSpace && (
            <StatusDot
              available={status.diskSpace.available}
              label={status.diskSpace.freeGB ? `${status.diskSpace.freeGB}GB free` : 'Disk'}
              detail={status.diskSpace.error || `${status.diskSpace.freeGB}GB available`}
            />
          )}
        </div>
        <Link
          href="/settings"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Settings className="h-4 w-4" />
          <span className="hidden sm:inline">Config</span>
        </Link>
      </div>
    </header>
  );
}
