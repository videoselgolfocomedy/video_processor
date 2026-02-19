import { readWav, downsample, toMono } from '@/lib/dsp/wav-utils';
import { crossCorrelate, type CorrelationResult } from '@/lib/dsp/fft-correlation';
import { SYNC_SAMPLE_RATE } from '@/lib/constants';

export async function computeAudioSync(
  referencePath: string,
  alignPath: string
): Promise<CorrelationResult> {
  // Read both WAV files
  const refWav = await readWav(referencePath);
  const alignWav = await readWav(alignPath);

  // Convert to mono if needed
  let refSamples = toMono(refWav.samples, refWav.channels);
  let alignSamples = toMono(alignWav.samples, alignWav.channels);

  // Downsample both to 8kHz for faster correlation
  refSamples = downsample(refSamples, refWav.sampleRate, SYNC_SAMPLE_RATE);
  alignSamples = downsample(alignSamples, alignWav.sampleRate, SYNC_SAMPLE_RATE);

  // Cross-correlate
  const result = crossCorrelate(refSamples, alignSamples, SYNC_SAMPLE_RATE);

  return result;
}
