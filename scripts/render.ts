/**
 * @deprecated This Remotion-based render script is no longer used.
 * Rendering is now handled directly by FFmpeg with ASS subtitles in render-worker.ts.
 * Kept for reference only.
 *
 * Standalone Remotion render script.
 * Spawned as a child process from the API to avoid Webpack-in-Webpack conflicts.
 *
 * Usage: npx tsx scripts/render.ts --config <json-file>
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';

interface RenderConfig {
  projectId: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  crf: number;
  audioBitrate: string;
  videoSrc?: string;
  audioSrc?: string;
  segments: unknown[];
  subtitleStyle: Record<string, unknown>;
  durationInFrames: number;
  frameRange?: [number, number];
}

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  if (configIndex === -1 || !args[configIndex + 1]) {
    console.error('Usage: npx tsx scripts/render.ts --config <json-file>');
    process.exit(1);
  }

  const configPath = args[configIndex + 1];
  const config: RenderConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Report progress via stdout JSON lines — flush immediately
  function reportProgress(percent: number, message: string) {
    const clamped = Math.min(100, Math.max(0, percent));
    process.stdout.write(JSON.stringify({ type: 'progress', percent: clamped, message }) + '\n');
  }

  // Start a local HTTP server to serve media files to Remotion's headless browser
  // (Chrome blocks both file:// URLs and bare local paths)
  const fileServer = http.createServer((req, res) => {
    const filePath = decodeURIComponent(req.url || '');
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.aac': 'audio/aac',
    };

    // Support range requests for video seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  await new Promise<void>((resolve) => fileServer.listen(0, '127.0.0.1', resolve));
  const serverPort = (fileServer.address() as AddressInfo).port;

  function toLocalUrl(filePath?: string): string | undefined {
    if (!filePath) return undefined;
    return `http://127.0.0.1:${serverPort}${encodeURI(filePath)}`;
  }

  const videoUrl = toLocalUrl(config.videoSrc);
  const audioUrl = toLocalUrl(config.audioSrc);

  reportProgress(5, 'Loading Remotion...');

  try {
    // Dynamic imports to avoid loading Remotion at module level
    const { bundle } = await import('@remotion/bundler');
    const { renderMedia, selectComposition } = await import('@remotion/renderer');

    reportProgress(10, 'Bundling compositions...');

    let lastBundleReport = 0;
    const bundled = await bundle({
      entryPoint: path.resolve(process.cwd(), 'src/remotion/index.ts'),
      onProgress: (p: number) => {
        // p can be > 1 in some Remotion versions (step count); clamp to 0-1
        const normalized = Math.min(1, Math.max(0, p));
        const now = Date.now();
        // Throttle: report at most every 1s
        if (now - lastBundleReport > 1000) {
          lastBundleReport = now;
          reportProgress(10 + normalized * 20, `Bundling... ${Math.round(normalized * 100)}%`);
        }
      },
    });

    reportProgress(30, 'Selecting composition...');

    const inputProps = {
      videoSrc: videoUrl,
      audioSrc: audioUrl,
      segments: config.segments,
      subtitleStyle: config.subtitleStyle,
    };

    const composition = await selectComposition({
      serveUrl: bundled,
      id: config.width > config.height ? 'StandupFull' : 'StandupShort',
      inputProps,
    });

    // Override composition dimensions
    composition.width = config.width;
    composition.height = config.height;
    composition.fps = config.fps;
    composition.durationInFrames = config.durationInFrames;

    reportProgress(35, 'Starting render...');

    await renderMedia({
      composition,
      serveUrl: bundled,
      codec: 'h264',
      outputLocation: config.outputPath,
      inputProps,
      crf: config.crf,
      ...(config.frameRange ? { frameRange: config.frameRange } : {}),
      onProgress: ({ progress }) => {
        const percent = 35 + progress * 60;
        reportProgress(percent, `Rendering... ${Math.round(progress * 100)}%`);
      },
    });

    reportProgress(95, 'Finalizing...');

    process.stdout.write(
      JSON.stringify({
        type: 'complete',
        outputPath: config.outputPath,
      }) + '\n'
    );
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        type: 'error',
        error: (err as Error).message,
      }) + '\n'
    );
    process.exit(1);
  } finally {
    fileServer.close();
  }
}

main();
