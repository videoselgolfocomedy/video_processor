'use client';

import { useMemo } from 'react';
import { levelerCurve, levelerCurvePoints, levelerOutputDb, LEVELER_SILENCE_DEPTH_MAX } from '@/lib/leveler-curve';
import type { LevelStats } from '@/lib/level-stats';

const fmtGain = (db: number) => `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(0)} dB`;
const fmtDb = (db: number) => `${db < 0 ? '−' : ''}${Math.abs(db).toFixed(0)}`;

/**
 * The leveler's input→output curve (dB in → dB out), drawn from the SAME
 * breakpoints the FFmpeg compand uses, with the raw track's measured levels
 * (room / typical / loud / peak) placed on it so you read directly "a −38 dB
 * line comes out at −20". The input axis is split into the three zones the
 * curve treats differently (pauses · ramp · voice) and the legend under the
 * drawing spells each one out with its numbers. Without a measured loudness
 * it explains what is missing.
 */
export function LevelerCurve({
  meanLUFS, ratio, ceilingDb, noiseFloorDb, gated, kneeDb, silenceDepthDb, raw, className,
}: {
  meanLUFS?: number;
  ratio: number;
  ceilingDb: number;
  noiseFloorDb?: number;
  /** The mesa gate runs before the leveler (leveled mode): knee under the floor. */
  gated?: boolean;
  kneeDb?: number;
  silenceDepthDb?: number;
  raw?: LevelStats | null;
  className?: string;
}) {
  const W = 420, H = 270, L = 36, B = 40, T = 10, Rm = 10;
  const min = -80, max = 0;
  const sx = (db: number) => L + ((Math.max(min, Math.min(max, db)) - min) / (max - min)) * (W - L - Rm);
  const sy = (db: number) => T + (1 - (Math.max(min, Math.min(max, db)) - min) / (max - min)) * (H - T - B);

  const model = useMemo(() => {
    if (meanLUFS == null) return null;
    const opts = { meanLUFS, ratio, ceilingDb, noiseFloorDb, gated, kneeDb };
    const info = levelerCurve({ ...opts, silenceDepthDb });
    const trace = (pts: Array<[number, number]>) => {
      const path = [];
      for (let db = min; db <= max; db += 0.5) {
        path.push(`${path.length === 0 ? 'M' : 'L'}${sx(db).toFixed(1)},${sy(levelerOutputDb(db, pts)).toFixed(1)}`);
      }
      return path.join(' ');
    };
    const soft = info.silenceGainDb > 0;
    // The old hard knee, for comparison, only while the soft one is in effect.
    const hardPath = soft ? trace(levelerCurvePoints({ ...opts, silenceDepthDb: LEVELER_SILENCE_DEPTH_MAX })) : null;
    const marks = ([
      ...(noiseFloorDb != null ? [['sala', noiseFloorDb, '#38bdf8'] as const] : []),
      ...(raw ? [
        ['típica', raw.typicalDb, '#e2e8f0'] as const,
        ['fuerte', raw.loudDb, '#fbbf24'] as const,
        ['pico', raw.peakDb, '#f87171'] as const,
      ] : []),
    ]).map(([name, inDb, color]) => ({ name, color, inDb, outDb: levelerOutputDb(inDb, info.pts) }));
    return { ...info, path: trace(info.pts), hardPath, soft, marks };
  }, [meanLUFS, ratio, ceilingDb, noiseFloorDb, gated, kneeDb, silenceDepthDb, raw]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoneY = H - B + 24;
  return (
    <div className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[460px]" role="img" aria-label="Curva del nivelador">
        {/* zones of the input axis */}
        {model && (
          <>
            <rect x={sx(min)} y={T} width={sx(model.gLo) - sx(min)} height={H - T - B} fill="rgba(56,189,248,0.07)" />
            <rect x={sx(model.gLo)} y={T} width={sx(model.vLo) - sx(model.gLo)} height={H - T - B} fill="rgba(251,191,36,0.10)" />
            <rect x={sx(model.vLo)} y={T} width={sx(model.vHi) - sx(model.vLo)} height={H - T - B} fill="rgba(52,211,153,0.07)" />
            <text x={(sx(min) + sx(model.gLo)) / 2} y={zoneY} fontSize={9} fill="#38bdf8" textAnchor="middle">pausas / sala</text>
            <text x={(sx(model.gLo) + sx(model.vLo)) / 2} y={zoneY + 10} fontSize={9} fill="#fbbf24" textAnchor="middle">rampa</text>
            <text x={(sx(model.vLo) + sx(model.vHi)) / 2} y={zoneY} fontSize={9} fill="#34d399" textAnchor="middle">voz (se nivela)</text>
            {sx(max) - sx(model.vHi) > 40 && (
              <text x={(sx(model.vHi) + sx(max)) / 2} y={zoneY} fontSize={9} fill="#f87171" textAnchor="middle">golpes</text>
            )}
          </>
        )}
        {/* grid */}
        {[-80, -60, -40, -20, 0].map((db) => (
          <g key={db}>
            <line x1={sx(db)} y1={T} x2={sx(db)} y2={H - B} stroke="rgba(148,163,184,0.15)" />
            <line x1={L} y1={sy(db)} x2={W - Rm} y2={sy(db)} stroke="rgba(148,163,184,0.15)" />
            <text x={sx(db)} y={H - B + 11} fontSize={9} fill="#94a3b8" textAnchor="middle">{db}</text>
            <text x={L - 4} y={sy(db) + 3} fontSize={9} fill="#94a3b8" textAnchor="end">{db}</text>
          </g>
        ))}
        <text x={W - Rm} y={H - 2} fontSize={9} fill="#94a3b8" textAnchor="end">entrada (mesa cruda) dBFS →</text>
        <text x={9} y={(T + H - B) / 2} fontSize={9} fill="#94a3b8" textAnchor="middle" transform={`rotate(-90 9 ${(T + H - B) / 2})`}>salida dBFS</text>
        {/* identity */}
        <line x1={sx(min)} y1={sy(min)} x2={sx(max)} y2={sy(max)} stroke="rgba(148,163,184,0.45)" strokeDasharray="3 3" />
        <text x={sx(-48)} y={sy(-48) + 14} fontSize={8} fill="#94a3b8">sin cambio (diagonal)</text>
        {model ? (
          <>
            <line x1={L} y1={sy(ceilingDb)} x2={W - Rm} y2={sy(ceilingDb)} stroke="rgba(52,211,153,0.35)" strokeDasharray="2 3" />
            <text x={L + 3} y={sy(ceilingDb) - 3} fontSize={9} fill="#34d399">techo {ceilingDb} dB</text>
            {model.hardPath && <path d={model.hardPath} fill="none" stroke="rgba(248,113,113,0.7)" strokeWidth={1.2} strokeDasharray="4 3" />}
            <path d={model.path} fill="none" stroke="#34d399" strokeWidth={2} />
            {/* the gain left in the pauses, as the distance to "sin cambio" */}
            {model.soft && (() => {
              const x = sx(Math.max(min + 6, model.gLo - 8));
              const inDb = Math.max(min + 6, model.gLo - 8);
              return (
                <g>
                  <line x1={x} y1={sy(inDb)} x2={x} y2={sy(inDb + model.silenceGainDb)} stroke="#38bdf8" strokeWidth={1} />
                  <text x={x + 3} y={(sy(inDb) + sy(inDb + model.silenceGainDb)) / 2 + 3} fontSize={9} fill="#38bdf8">{fmtGain(model.silenceGainDb)}</text>
                </g>
              );
            })()}
            {model.marks.map((m, i) => (
              <g key={m.name}>
                <line x1={sx(m.inDb)} y1={sy(m.inDb)} x2={sx(m.inDb)} y2={sy(m.outDb)} stroke={m.color} strokeDasharray="2 2" opacity={0.7} />
                <circle cx={sx(m.inDb)} cy={sy(m.outDb)} r={3.5} fill={m.color} />
                {/* Labels stack downward per mark so near-identical points
                    (loud ≈ peak on a compressed set) stay readable. */}
                <text x={sx(m.inDb) + 6} y={sy(m.outDb) + 14 + i * 11} fontSize={9} fill={m.color}>
                  {m.name} {fmtDb(m.inDb)}→{fmtDb(m.outDb)}
                </text>
              </g>
            ))}
          </>
        ) : (
          <text x={(L + W - Rm) / 2} y={(T + H - B) / 2} fontSize={10} fill="#94a3b8" textAnchor="middle">
            la curva se ancla a la voz medida — genera una vista previa o mezcla
          </text>
        )}
      </svg>
      {model && (
        <ul className="mt-1 max-w-[460px] space-y-0.5 text-[10px] leading-tight text-muted-foreground">
          <li><span className="text-emerald-400">━ curva aplicada</span>: cuanto más por encima de la diagonal punteada («sin cambio»), más se sube ese nivel.</li>
          <li>
            <span className="text-emerald-400">Voz</span> (entrada {fmtDb(model.vLo)} … {fmtDb(model.vHi)} dB): la más fuerte va al techo ({ceilingDb} dB) y
            la más floja sale a {fmtDb(model.vLo + model.kneeGainDb)} dB ({fmtGain(model.kneeGainDb)}). Las flojas suben más que las fuertes ({ratio}:1).
          </li>
          <li>
            <span className="text-amber-300">Rampa</span> (entrada {fmtDb(model.gLo)} … {fmtDb(model.vLo)} dB): la subida pasa
            de {fmtGain(model.kneeGainDb)} a {fmtGain(model.silenceGainDb)}. Es el final de las palabras al apagarse.
          </li>
          <li>
            <span className="text-sky-400">Pausas / sala</span> (por debajo de {fmtDb(model.gLo)} dB):{' '}
            {model.soft
              ? <>se quedan con {fmtGain(model.silenceGainDb)} fijos, {(model.kneeGainDb - model.silenceGainDb).toFixed(0)} dB menos que la voz: queda un fondo de sala continuo en vez de un corte.</>
              : gated
                ? <>sin subida — la puerta de mesa ya decide el silencio.</>
                : <>sin subida (corte total): la pausa vuelve a su nivel crudo.</>}
          </li>
          {model.hardPath && (
            <li><span className="text-red-400">┅ curva anterior</span> (sin fondo): la pausa caía hasta la diagonal, {model.silenceGainDb.toFixed(0)} dB más abajo — el efecto «mute».</li>
          )}
          {model.marks.length > 0 && (
            <li>Puntos: niveles medidos de la mesa cruda (entrada→salida en dB){noiseFloorDb != null ? <>; <span className="text-sky-400">sala</span> = ruido entre frases</> : null}.</li>
          )}
        </ul>
      )}
    </div>
  );
}
