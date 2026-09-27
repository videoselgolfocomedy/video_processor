'use client';

/**
 * Explanatory timeline of the voice-aware ambient gain (the PRE-COMPUTED
 * envelope, see src/server/ambient-gain-curve.ts). Shows the two cases that
 * matter and that a plain compressor gets wrong:
 *
 *   1. a SHORT gap between words → the ambient does NOT rise (it is treated
 *      as part of the phrase, because the gap is shorter than the minimum
 *      pause);
 *   2. the END of a phrase followed by a real laugh → the rise starts
 *      `preRise` ms BEFORE the voice ends, so the laugh swells under the last
 *      words instead of jumping in after them.
 *
 * Not to scale (short segments are widened to stay readable).
 */
export function AmbientDuckDiagram({
  depthDb, gapBoostDb, attackMs, holdMs, releaseMs, anticipateMs, preRiseMs, className,
}: {
  depthDb: number;
  gapBoostDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  anticipateMs: number;
  preRiseMs: number;
  className?: string;
}) {
  const W = 560, H = 232, L = 42, R = 10, T = 16, B = 62;
  const top = Math.max(gapBoostDb, 0) + 2;
  const bottom = -depthDb - 2;
  const sy = (db: number) => T + (1 - (db - bottom) / (top - bottom)) * (H - T - B);
  const yHi = sy(gapBoostDb), yLo = sy(-depthDb), y0 = sy(0);

  // Segment widths (ms → px, with minimums so 20 ms stays visible).
  const px = (ms: number, min: number) => Math.max(min, ms * 0.1);
  const wGap0 = 34;
  const wAtk = px(attackMs, 16);
  const wAntRest = Math.max(0, px(anticipateMs, anticipateMs > 0 ? 16 : 0) - wAtk);
  const wWord1 = 46;
  const wShort = 26;
  const wWord2 = 40;
  const wRise = px(releaseMs, 26);
  const wPreRise = Math.min(wRise, px(preRiseMs, preRiseMs > 0 ? 14 : 0));
  const wPause = 54;
  const wAtk2 = wAtk;
  const wWord3 = 24;
  const total = wGap0 + wAtk + wAntRest + wWord1 + wShort + wWord2 + wRise + wPause + wAtk2 + wWord3;
  const k = (W - L - R) / total;
  let x = L;
  const X = (w: number) => { const a = x; x += w * k; return [a, x] as const; };
  // NOTE: X() advances the cursor — the calls must stay in timeline order
  // even for the segments whose bounds we never reference (antRest, word2).
  const gap0 = X(wGap0);
  const atk = X(wAtk);
  X(wAntRest);
  const word1 = X(wWord1);
  const short = X(wShort);
  X(wWord2);
  const rise = X(wRise);
  const pause = X(wPause);
  const atk2 = X(wAtk2);
  const word3 = X(wWord3);
  const xVoiceEnd = rise[0] + wPreRise * k; // voice really ends preRise into the rise

  const path = [
    `M${gap0[0]},${yHi}`, `L${atk[0]},${yHi}`, `L${atk[1]},${yLo}`,
    `L${rise[0]},${yLo}`, `L${rise[1]},${yHi}`,
    `L${atk2[0]},${yHi}`, `L${atk2[1]},${yLo}`, `L${word3[1]},${yLo}`,
  ].join(' ');

  const bracket = (x0: number, x1: number, text: string, row: 0 | 1 | 2, color = '#94a3b8') =>
    x1 - x0 > 3 ? (
      <g key={`${text}-${row}`}>
        <line x1={x0} y1={H - B + 6 + row * 14} x2={x1} y2={H - B + 6 + row * 14} stroke={color} />
        <line x1={x0} y1={H - B + 3 + row * 14} x2={x0} y2={H - B + 9 + row * 14} stroke={color} />
        <line x1={x1} y1={H - B + 3 + row * 14} x2={x1} y2={H - B + 9 + row * 14} stroke={color} />
        <text x={(x0 + x1) / 2} y={H - B + 17 + row * 14} fontSize={8.5} fill={color} textAnchor="middle">{text}</text>
      </g>
    ) : null;

  const voice = (x0: number, x1: number, label?: string) => (
    <g key={`v${x0}`}>
      <rect x={x0} y={T} width={Math.max(3, x1 - x0)} height={H - T - B} fill="rgba(52,211,153,0.12)" stroke="rgba(52,211,153,0.45)" />
      {label && <text x={(x0 + x1) / 2} y={T + 10} fontSize={8.5} fill="#34d399" textAnchor="middle">{label}</text>}
    </g>
  );

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[560px]" role="img" aria-label="Diagrama del ducking del ambiente">
        <line x1={L} y1={y0} x2={W - R} y2={y0} stroke="rgba(148,163,184,0.3)" strokeDasharray="3 3" />
        <text x={L - 3} y={y0 + 3} fontSize={8.5} fill="#94a3b8" textAnchor="end">0 dB</text>
        <text x={L - 3} y={yHi + 3} fontSize={8.5} fill="#38bdf8" textAnchor="end">{gapBoostDb > 0 ? `+${gapBoostDb}` : '0'} dB</text>
        <text x={L - 3} y={yLo + 3} fontSize={8.5} fill="#38bdf8" textAnchor="end">−{depthDb} dB</text>

        {voice(word1[0], word1[1], 'palabra')}
        {voice(short[1], xVoiceEnd, 'última palabra')}
        {voice(atk2[1], word3[1], 'frase')}

        {/* short gap: explicitly NOT a rise */}
        <text x={(word1[1] + short[1]) / 2} y={yLo + 12} fontSize={8} fill="#fbbf24" textAnchor="middle">hueco corto</text>
        <text x={(word1[1] + short[1]) / 2} y={yLo + 21} fontSize={8} fill="#fbbf24" textAnchor="middle">no sube</text>

        <path d={path} fill="none" stroke="#38bdf8" strokeWidth={2.2} />
        <text x={gap0[0] + 1} y={yHi - 5} fontSize={8.5} fill="#38bdf8">ambiente</text>
        <text x={(pause[0] + pause[1]) / 2} y={yHi - 5} fontSize={8.5} fill="#38bdf8" textAnchor="middle">risa arriba</text>

        {bracket(atk[0], word1[0], `anticipa ${anticipateMs} ms`, 0)}
        {bracket(atk[0], atk[1], `ataque ${attackMs} ms`, 1)}
        {preRiseMs > 0 ? bracket(rise[0], xVoiceEnd, `sube ${preRiseMs} ms antes`, 0, '#38bdf8') : null}
        {bracket(rise[0], rise[1], `vuelve ${releaseMs} ms`, 1)}
        {bracket(xVoiceEnd, atk2[0], `pausa ≥ ${holdMs} ms con público`, 2)}
        <text x={W - R} y={H - 2} fontSize={8} fill="#64748b" textAnchor="end">no a escala</text>
      </svg>
    </div>
  );
}
