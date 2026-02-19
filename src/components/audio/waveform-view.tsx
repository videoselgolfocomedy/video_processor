'use client';

import { useRef, useEffect, useCallback } from 'react';

interface WaveformViewProps {
  label?: string;
  color?: string;
  audioUrl?: string;
  height?: number;
}

export function WaveformView({
  label,
  color = '#3b82f6',
  audioUrl,
  height = 80,
}: WaveformViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawWaveform = useCallback(
    async (url: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      try {
        const audioCtx = new AudioContext();
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(buffer);
        const data = audioBuffer.getChannelData(0);

        const { width } = canvas.getBoundingClientRect();
        canvas.width = width * 2; // Retina
        canvas.height = height * 2;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;

        const samplesPerPixel = Math.floor(data.length / (width * 2));
        const mid = canvas.height / 2;

        ctx.beginPath();
        for (let x = 0; x < canvas.width; x++) {
          const start = x * samplesPerPixel;
          let min = 0;
          let max = 0;

          for (let j = 0; j < samplesPerPixel; j++) {
            const val = data[start + j] || 0;
            if (val < min) min = val;
            if (val > max) max = val;
          }

          ctx.moveTo(x, mid + min * mid);
          ctx.lineTo(x, mid + max * mid);
        }
        ctx.stroke();

        audioCtx.close();
      } catch {
        // Draw empty waveform
        ctx.fillStyle = '#374151';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    },
    [color, height]
  );

  useEffect(() => {
    if (audioUrl) {
      drawWaveform(audioUrl);
    }
  }, [audioUrl, drawWaveform]);

  return (
    <div className="space-y-1">
      {label && (
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      )}
      <canvas
        ref={canvasRef}
        className="w-full rounded-md bg-secondary"
        style={{ height: `${height}px` }}
      />
    </div>
  );
}
