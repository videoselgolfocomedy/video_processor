'use client';

import { useReelStore } from '@/stores/reel-store';
import { ReelVideoPlayer } from './reel-video-player';
import { ReelTrimBar } from './reel-trim-bar';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

interface ReelSetupViewProps {
  reelId: string;
  videoSrc?: string;
  audioSrc?: string;
}

export function ReelSetupView({ reelId, videoSrc, audioSrc }: ReelSetupViewProps) {
  const reel = useReelStore((s) => s.reels.find((r) => r.id === reelId));
  const baseDurationMs = useReelStore((s) => s.baseDurationMs);
  const enterTimelinePhase = useReelStore((s) => s.enterTimelinePhase);

  if (!reel) return null;

  // Extract filenames from src URLs for clip creation
  const videoFileName = videoSrc ? videoSrc.split('/').pop() : undefined;
  const audioFileName = audioSrc ? audioSrc.split('/').pop() : undefined;

  return (
    <div className="space-y-4 p-4">
      {/* Video Player with crop overlay */}
      <ReelVideoPlayer reelId={reelId} videoSrc={videoSrc} audioSrc={audioSrc} />

      {/* Trim Bar */}
      <ReelTrimBar reelId={reelId} baseDurationMs={baseDurationMs} />

      {/* Edit Reel button */}
      <div className="flex justify-center pt-2">
        <Button
          size="lg"
          onClick={() => enterTimelinePhase(reelId, videoFileName, audioFileName)}
          className="gap-2"
        >
          Edit Reel
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
