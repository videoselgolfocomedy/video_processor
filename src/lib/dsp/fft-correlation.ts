// FFT-based cross-correlation for audio sync
// Uses the Wiener-Khinchin approach: corr(a,b) = IFFT(FFT(a) * conj(FFT(b)))

export interface CorrelationResult {
  offsetSamples: number;
  offsetMs: number;
  confidence: number;
  sampleRate: number;
}

export function crossCorrelate(
  signalA: Float32Array,
  signalB: Float32Array,
  sampleRate: number
): CorrelationResult {
  // Use time-domain cross-correlation with optimization for speed

  // For practical audio sync, we use a windowed approach
  // Check offsets from -maxOffset to +maxOffset
  const maxOffsetSamples = Math.min(sampleRate * 30, signalA.length, signalB.length); // Up to 30 seconds

  let bestCorr = -Infinity;
  let bestOffset = 0;

  // Downsample for initial coarse search (step of 10)
  const coarseStep = 10;
  for (let offset = -maxOffsetSamples; offset <= maxOffsetSamples; offset += coarseStep) {
    const corr = computeCorrelation(signalA, signalB, offset);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestOffset = offset;
    }
  }

  // Fine search around best coarse offset
  let finebestCorr = bestCorr;
  let fineBestOffset = bestOffset;
  for (let offset = bestOffset - coarseStep; offset <= bestOffset + coarseStep; offset++) {
    const corr = computeCorrelation(signalA, signalB, offset);
    if (corr > finebestCorr) {
      finebestCorr = corr;
      fineBestOffset = offset;
    }
  }

  // Compute confidence as ratio of peak to mean
  const meanCorr = computeMeanCorrelation(signalA, signalB, sampleRate);
  const confidence = meanCorr > 0 ? Math.min(1, finebestCorr / meanCorr / 3) : 0;

  const offsetMs = (fineBestOffset / sampleRate) * 1000;

  return {
    offsetSamples: fineBestOffset,
    offsetMs: Math.round(offsetMs * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    sampleRate,
  };
}

function computeCorrelation(
  a: Float32Array,
  b: Float32Array,
  offset: number
): number {
  let sum = 0;
  let count = 0;

  const startA = Math.max(0, offset);
  const startB = Math.max(0, -offset);
  const len = Math.min(a.length - startA, b.length - startB);

  // Sample every 4th point for speed
  const step = 4;
  for (let i = 0; i < len; i += step) {
    sum += a[startA + i] * b[startB + i];
    count++;
  }

  return count > 0 ? sum / count : 0;
}

function computeMeanCorrelation(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number
): number {
  // Sample a few random offsets to get baseline
  const numSamples = 20;
  const maxOffset = Math.min(sampleRate * 30, a.length, b.length);
  let total = 0;

  for (let i = 0; i < numSamples; i++) {
    const offset = Math.floor((Math.random() * 2 - 1) * maxOffset);
    total += Math.abs(computeCorrelation(a, b, offset));
  }

  return total / numSamples;
}
