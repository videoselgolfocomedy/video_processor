'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, Rewind, FastForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDuration } from '@/lib/utils';

interface AudioPlayerProps {
  src: string;
  label?: string;
}

export function AudioPlayer({ src, label }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime * 1000);
    const onDurationChange = () => setDuration(audio.duration * 1000);
    const onEnded = () => setPlaying(false);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  // Reset when src changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
  }, [src]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play();
    }
    setPlaying(!playing);
  }, [playing]);

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  }, []);

  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      audio.currentTime = (percent * duration) / 1000;
    },
    [duration]
  );

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="space-y-2">
      {label && (
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      )}
      <audio ref={audioRef} src={src} preload="metadata" />

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => skip(-30)} title="-30s">
          <SkipBack className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => skip(-5)} title="-5s">
          <Rewind className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={togglePlay}>
          {playing ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => skip(5)} title="+5s">
          <FastForward className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => skip(30)} title="+30s">
          <SkipForward className="h-3 w-3" />
        </Button>

        <span className="min-w-[52px] text-xs tabular-nums text-muted-foreground ml-1">
          {formatDuration(currentTime)}
        </span>

        {/* Progress bar */}
        <div
          className="flex-1 cursor-pointer rounded-full bg-secondary"
          onClick={handleSeek}
        >
          <div className="h-1.5 relative rounded-full">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <span className="min-w-[52px] text-right text-xs tabular-nums text-muted-foreground">
          {formatDuration(duration)}
        </span>
      </div>
    </div>
  );
}
