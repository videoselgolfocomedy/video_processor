'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { useSSE } from '@/hooks/use-sse';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Zap, CheckCircle } from 'lucide-react';
import type { SyncState } from '@/types/project';

interface SyncPanelProps {
  projectId: string;
  syncState: SyncState;
  hasMultipleTracks: boolean;
  onComplete: () => void;
}

export function SyncPanel({
  projectId,
  syncState,
  hasMultipleTracks,
  onComplete,
}: SyncPanelProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [manualOffset, setManualOffset] = useState(
    syncState.offsetMs?.toString() || ''
  );
  const { toast } = useToast();

  useSSE({
    jobId,
    onProgress: (prog) => setProgress(prog),
    onComplete: () => {
      setRunning(false);
      setJobId(null);
      onComplete();
      toast({ title: 'Audio sync complete' });
    },
    onError: (err) => {
      setRunning(false);
      setJobId(null);
      toast({ title: 'Sync failed', description: err, variant: 'destructive' });
    },
  });

  const handleAutoSync = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/sync`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to start sync');
      const data = await res.json();
      setJobId(data.jobId);
    } catch {
      setRunning(false);
      toast({ title: 'Failed to start sync', variant: 'destructive' });
    }
  }, [projectId, toast]);

  const handleManualAlign = useCallback(async () => {
    const offset = parseFloat(manualOffset);
    if (isNaN(offset)) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/audio/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMs: offset }),
      });
      if (!res.ok) throw new Error('Failed to apply offset');
      onComplete();
      toast({ title: `Applied offset: ${offset}ms` });
    } catch {
      toast({ title: 'Failed to apply offset', variant: 'destructive' });
    }
  }, [projectId, manualOffset, onComplete, toast]);

  if (!hasMultipleTracks) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Upload both camera and board audio to use sync
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Audio Synchronization</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Auto sync */}
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Automatically detect the offset between camera and board audio
            using cross-correlation.
          </p>

          {syncState.status === 'done' && syncState.offsetMs !== undefined && (
            <div className="flex items-center gap-2 rounded-md bg-secondary p-3 text-sm">
              <CheckCircle className="h-4 w-4 text-green-500" />
              <span>
                Offset: <strong>{syncState.offsetMs}ms</strong>
              </span>
              {syncState.confidence !== undefined && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Confidence: {Math.round(syncState.confidence * 100)}%
                </span>
              )}
            </div>
          )}

          {running && <Progress value={progress} className="h-2" />}

          <Button
            onClick={handleAutoSync}
            disabled={running}
          >
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Analyzing... {Math.round(progress)}%
              </>
            ) : (
              <>
                <Zap className="mr-2 h-4 w-4" />
                Auto Sync
              </>
            )}
          </Button>
        </div>

        {/* Manual adjustment */}
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Manual Offset Adjustment
          </p>
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="manual-offset" className="sr-only">
                Offset (ms)
              </Label>
              <Input
                id="manual-offset"
                type="number"
                placeholder="Offset in ms"
                value={manualOffset}
                onChange={(e) => setManualOffset(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={handleManualAlign}>
              Apply
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
