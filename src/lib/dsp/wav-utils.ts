import fs from 'fs/promises';

export interface WavData {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  samples: Float32Array;
}

export async function readWav(filePath: string): Promise<WavData> {
  const buffer = await fs.readFile(filePath);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Parse WAV header
  // Skip RIFF header (12 bytes)
  let offset = 12;

  let sampleRate = 44100;
  let channels = 1;
  let bitDepth = 16;
  let dataStart = 0;
  let dataSize = 0;

  while (offset < buffer.length) {
    const chunkId = String.fromCharCode(
      buffer[offset],
      buffer[offset + 1],
      buffer[offset + 2],
      buffer[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitDepth = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataStart = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  // Read samples
  const bytesPerSample = bitDepth / 8;
  const numSamples = Math.floor(dataSize / bytesPerSample);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const sampleOffset = dataStart + i * bytesPerSample;
    if (bitDepth === 16) {
      samples[i] = view.getInt16(sampleOffset, true) / 32768;
    } else if (bitDepth === 24) {
      const val =
        buffer[sampleOffset] |
        (buffer[sampleOffset + 1] << 8) |
        (buffer[sampleOffset + 2] << 16);
      samples[i] = (val > 0x7fffff ? val - 0x1000000 : val) / 8388608;
    } else if (bitDepth === 32) {
      samples[i] = view.getFloat32(sampleOffset, true);
    }
  }

  return { sampleRate, channels, bitDepth, samples };
}

export function downsample(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return samples;

  const ratio = fromRate / toRate;
  const newLength = Math.floor(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    result[i] = samples[srcIndex];
  }

  return result;
}

export function toMono(samples: Float32Array, channels: number): Float32Array {
  if (channels === 1) return samples;

  const monoLength = Math.floor(samples.length / channels);
  const mono = new Float32Array(monoLength);

  for (let i = 0; i < monoLength; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      sum += samples[i * channels + ch];
    }
    mono[i] = sum / channels;
  }

  return mono;
}
