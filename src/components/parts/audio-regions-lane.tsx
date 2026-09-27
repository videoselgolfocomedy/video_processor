'use client';

import { Plus } from 'lucide-react';
import { RegionBands, RegionDrawLayer, RegionKindControls, RegionTrackWaveform, useAudioRegions } from '@/components/parts/audio-regions-context';
import { STEM_TRACK_HEIGHT } from '@/lib/track-heights';
import type { RegionKind } from '@/lib/audio-region-map';

const HEADER_W = 120;

/**
 * FALLBACK view of the audio regions when the mesa/ambiente stems are NOT
 * separated into their own tracks: one row per kind under the tracks, on the
 * timeline's own axis, drawing the SAME picture the stem tracks would (the
 * original signal in gray, the processed result in colour, the applied gain
 * as a line) with the attenuation / raise bands on top, the pencil always on,
 * and the region controls (dB, fades, ramp) in the header. Once the user
 * separates the stems the bands move onto those tracks and this lane hides —
 * the editor state is the same `AudioRegionsProvider` either way.
 */
export function AudioRegionsLane() {
  const ctx = useAudioRegions();
  if (!ctx || ctx.stemTracksPresent || ctx.wins.length === 0) return null;
  const rows: Array<{ kind: RegionKind; label: string; color: string; bg: string }> = [
    { kind: 'board', label: 'Mesa dB', color: 'text-emerald-300', bg: 'bg-emerald-950/50' },
    { kind: 'ambient', label: 'Ambiente dB', color: 'text-sky-300', bg: 'bg-sky-950/50' },
  ];
  return (
    <>
      {rows.map((row) => (
        <div key={row.kind} className="flex border-b border-border" style={{ height: STEM_TRACK_HEIGHT }}>
          <div className="flex flex-shrink-0 flex-col justify-between border-r border-border bg-card px-2 py-1" style={{ width: HEADER_W }}>
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <span className={`block truncate text-[10px] font-medium ${row.color}`}>{row.label}</span>
                <span
                  className="block truncate text-[8px] leading-tight text-muted-foreground"
                  title="Onda gris: el audio original (mesa cruda / cámara). Onda de color: lo que suena. Línea ámbar: la ganancia aplicada en dB respecto a la raya de 0 dB (je-je, nivelado, ducking, subidas, volumen). Arrastra sobre la fila para marcar una zona nueva; clic = 0,8 s ahí."
                >
                  gris · color · línea = dB
                </span>
              </div>
              <button
                type="button"
                className="p-0.5 text-muted-foreground hover:text-green-400"
                title="Añadir una zona en el cursor (o arrastra sobre la fila)"
                onClick={() => void ctx.add(row.kind)}
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
            <RegionKindControls kind={row.kind} />
          </div>
          <div className={`relative flex-1 overflow-hidden ${row.bg}`}>
            <RegionTrackWaveform kind={row.kind} />
            <RegionDrawLayer kind={row.kind} />
            {row.kind === 'board' && <RegionBands kind="autoGate" />}
            {row.kind === 'board' && <RegionBands kind="keepOpen" />}
            {row.kind === 'ambient' && <RegionBands kind="autoRaise" />}
            {row.kind === 'ambient' && <RegionBands kind="noRaise" />}
            <RegionBands kind={row.kind} />
          </div>
        </div>
      ))}
    </>
  );
}
