'use client';

import type { CompositionClip } from '@/types/project';

/**
 * The clip's volume zones, drawn INSIDE the clip: a silhouette of the gain over
 * time (rising from the bottom when it boosts, dropping from the top when it
 * cuts, with the real ramps) plus a label. Purely a read-out — the zone is
 * created and edited in the clip's properties panel — so the whole overlay is
 * `pointer-events-none` and the clip underneath keeps every gesture it had
 * (move, trim, select). Zone times are the clip's file clock; the clip starts
 * at `sourceInMs`, so a zone at `startMs` sits `(startMs − sourceInMs) × zoom`
 * pixels into it.
 */
export function ClipGainBands({ clip, zoomLevel }: { clip: CompositionClip; zoomLevel: number }) {
  const regions = clip.gainRegions;
  if (!regions || regions.length === 0) return null;
  const clipStart = clip.sourceInMs ?? 0;
  const clipEnd = clip.sourceOutMs ?? clipStart;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {regions.map((r) => {
        const s = Math.min(r.startMs, r.endMs);
        const e = Math.max(r.startMs, r.endMs);
        if (e <= clipStart || s >= clipEnd) return null;
        const fi = Math.max(0, r.fadeInMs ?? 0);
        const fo = Math.max(0, r.fadeOutMs ?? 0);
        const left = (s - fi - clipStart) * zoomLevel;
        const width = (e + fo - (s - fi)) * zoomLevel;
        if (width < 1) return null;
        const rampIn = fi * zoomLevel;
        const rampOut = fo * zoomLevel;
        const up = r.db > 0;
        // How tall the plateau reaches: 30 % of the lane plus the dB, capped —
        // the same feel as the mesa/ambient zones, so +6 reads bigger than +2.
        const reach = Math.min(0.92, 0.3 + Math.abs(r.db) / 30);
        const top = up ? (1 - reach) * 100 : 0;
        const base = up ? 100 : 0;
        const plateau = up ? top : reach * 100;
        const pts = [
          `0,${base}`,
          `${rampIn.toFixed(1)},${plateau.toFixed(1)}`,
          `${Math.max(rampIn, width - rampOut).toFixed(1)},${plateau.toFixed(1)}`,
          `${width.toFixed(1)},${base}`,
        ].join(' ');
        return (
          <div key={r.id} className="absolute top-0 bottom-0" style={{ left, width }}>
            <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${Math.max(1, width)} 100`} preserveAspectRatio="none" aria-hidden>
              <polygon
                points={pts}
                fill={up ? 'rgba(52,211,153,0.28)' : 'rgba(248,113,113,0.28)'}
                stroke={up ? 'rgba(110,231,183,0.9)' : 'rgba(252,165,175,0.9)'}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {width > 34 && (
              <span className={`absolute left-0 top-0 px-0.5 text-[9px] font-semibold ${up ? 'text-emerald-100' : 'text-rose-100'}`}>
                {r.db > 0 ? '+' : ''}{r.db} dB
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
