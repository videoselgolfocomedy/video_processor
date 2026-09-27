'use client';

import { useMemo } from 'react';
import { levelerCurvePoints, levelerOutputDb } from '@/lib/leveler-curve';
import type { LevelStats } from '@/lib/level-stats';

/**
 * The leveler's input→output curve (dB in → dB out), drawn from the SAME
 * breakpoints the FFmpeg compand uses, with the raw track's measured levels
 * (typical / loud / peak) placed on it so you read directly "a −38 dB line
 * comes out at −20". Without a measured loudness it explains what is missing.
 */
export function LevelerCurve({
  meanLUFS, ratio, ceilingDb, noiseFloorDb, gated, kneeDb, raw, className,
}: {
  meanLUFS?: number;
  ratio: number;
  ceilingDb: number;
  noiseFloorDb?: number;
  /** The mesa gate runs before the leveler (leveled mode): knee under the floor. */
  gated?: boolean;
  kneeDb?: number;
  raw?: LevelStats | null;
  className?: string;
}) {
  const W = 300, H = 210, L = 34, B = 26, T = 8, Rm = 8;
  const min = -70, max = 0;
  const sx = (db: number) => L + ((db - min) / (max - min)) * (W - L - Rm);
  const sy = (db: number) => T + (1 - (db - min) / (max - min)) * (H - T - B);

  const model = useMemo(() => {
    if (meanLUFS == null) return null;
    const pts = levelerCurvePoints({ meanLUFS, ratio, ceilingDb, noiseFloorDb, gated, kneeDb });
    const path = [];
    for (let db = min; db <= max; db += 0.5) {
      path.push(`${path.length === 0 ? 'M' : 'L'}${sx(db).toFixed(1)},${sy(Math.max(min, Math.min(max, levelerOutputDb(db, pts)))).toFixed(1)}`);
    }
    const marks = raw
      ? ([
          ['típica', raw.typicalDb, '#e2e8f0'],
          ['fuerte', raw.loudDb, '#fbbf24'],
          ['pico', raw.peakDb, '#f87171'],
        ] as const).map(([name, inDb, color]) => ({
          name, color, inDb, outDb: levelerOutputDb(inDb, pts),
        }))
      : [];
    return { path: path.join(' '), marks, vHi: meanLUFS + 18, gLo: meanLUFS - 26 };
  }, [meanLUFS, ratio, ceilingDb, noiseFloorDb, gated, kneeDb, raw]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[320px]" role="img" aria-label="Curva del nivelador">
        {/* grid */}
        {[-60, -40, -20, 0].map((db) => (
          <g key={db}>
            <line x1={sx(db)} y1={T} x2={sx(db)} y2={H - B} stroke="rgba(148,163,184,0.15)" />
            <line x1={L} y1={sy(db)} x2={W - Rm} y2={sy(db)} stroke="rgba(148,163,184,0.15)" />
            <text x={sx(db)} y={H - B + 12} fontSize={9} fill="#94a3b8" textAnchor="middle">{db}</text>
            <text x={L - 4} y={sy(db) + 3} fontSize={9} fill="#94a3b8" textAnchor="end">{db}</text>
          </g>
        ))}
        <text x={(L + W - Rm) / 2} y={H - 2} fontSize={9} fill="#94a3b8" textAnchor="middle">entrada (mesa cruda) dBFS</text>
        <text x={9} y={(T + H - B) / 2} fontSize={9} fill="#94a3b8" textAnchor="middle" transform={`rotate(-90 9 ${(T + H - B) / 2})`}>salida dBFS</text>
        {/* identity */}
        <line x1={sx(min)} y1={sy(min)} x2={sx(max)} y2={sy(max)} stroke="rgba(148,163,184,0.45)" strokeDasharray="3 3" />
        {model ? (
          <>
            {/* ceiling + anchor guides */}
            <line x1={L} y1={sy(ceilingDb)} x2={W - Rm} y2={sy(ceilingDb)} stroke="rgba(52,211,153,0.35)" strokeDasharray="2 3" />
            <text x={W - Rm - 2} y={sy(ceilingDb) - 3} fontSize={9} fill="#34d399" textAnchor="end">techo {ceilingDb} dB</text>
            <line x1={sx(model.vHi)} y1={T} x2={sx(model.vHi)} y2={H - B} stroke="rgba(52,211,153,0.25)" strokeDasharray="2 3" />
            <text x={sx(model.vHi) + 2} y={T + 10} fontSize={8} fill="#34d399">voz más fuerte</text>
            <line x1={sx(model.gLo)} y1={T} x2={sx(model.gLo)} y2={H - B} stroke="rgba(148,163,184,0.3)" strokeDasharray="2 3" />
            <text x={sx(model.gLo) + 2} y={H - B - 4} fontSize={8} fill="#94a3b8">ruido: sin cambio</text>
            <path d={model.path} fill="none" stroke="#34d399" strokeWidth={2} />
            {model.marks.map((m, i) => (
              <g key={m.name}>
                <line x1={sx(m.inDb)} y1={sy(m.inDb)} x2={sx(m.inDb)} y2={sy(m.outDb)} stroke={m.color} strokeDasharray="2 2" opacity={0.7} />
                <circle cx={sx(m.inDb)} cy={sy(m.outDb)} r={3.5} fill={m.color} />
                {/* Labels stack downward per mark so near-identical points
                    (loud ≈ peak on a compressed set) stay readable. */}
                <text x={sx(m.inDb) + 6} y={sy(m.outDb) + 4 + i * 11} fontSize={9} fill={m.color}>
                  {m.name} {m.inDb.toFixed(0)}→{m.outDb.toFixed(0)}
                </text>
              </g>
            ))}
          </>
        ) : (
          <text x={(L + W - Rm) / 2} y={(T + H - B) / 2} fontSize={10} fill="#94a3b8" textAnchor="middle">
            la curva se ancla al LUFS medido — genera una vista previa o mezcla
          </text>
        )}
      </svg>
    </div>
  );
}
