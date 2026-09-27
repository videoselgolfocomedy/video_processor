import type { ProjectPart } from '@/types/project';

/**
 * One-line, human descriptions of what the part mix chain APPLIES to each
 * branch — shown under the processed waveforms so "what you see and hear in
 * the preview" is labeled with the exact settings that produced it. Mirrors
 * buildPartMixFilter (src/server/part-mix-chain.ts) — keep them in sync.
 */

export function describeBoardChain(part: ProjectPart): string {
  const steps: string[] = [];
  const ducks = (part.boardDuckRegions ?? []).filter((r) => r.enabled);
  if (ducks.length > 0) {
    const dbs = Array.from(new Set(ducks.map((r) => r.attenuationDb))).sort((a, b) => a - b);
    steps.push(`filtro je-je: ${ducks.length} zona(s) a ${dbs.map((d) => `${d} dB`).join(' / ')}`);
  } else {
    steps.push('filtro je-je: sin zonas');
  }
  if (part.boardSpeechLevel) {
    const anchor = part.boardLoudDb != null
      ? `, voz fuerte ${part.boardLoudDb.toFixed(1)} dB → techo${part.boardNoiseFloorDb != null ? ` (sala ${part.boardNoiseFloorDb.toFixed(0)} dB)` : ''}`
      : part.boardLUFS != null
      ? `, anclado en ${part.boardLUFS.toFixed(1)} LUFS${part.boardNoiseFloorDb != null ? ` (sala ${part.boardNoiseFloorDb.toFixed(0)} dB)` : ''}`
      : '';
    // The gate is opt-in (boardGate). Parts mixed while it was implicit read as
    // "ajustes cambiados" once — right: their next mix drops the closures.
    if (part.boardGate) {
      steps.push('puerta de mesa −24 dB solo cuando la mesa cae a su ruido de sala (retención 300 ms, cierre 250 ms)');
      // Only when there ARE zones: this string is compared byte for byte against
      // mixChainApplied.board, so an unconditional fragment would flag every
      // already-mixed part as "ajustes cambiados desde esta mezcla".
      const keepOpen = (part.boardKeepOpenRegions ?? []).filter((r) => r.enabled).length;
      if (keepOpen > 0) steps.push(`${keepOpen} zona(s) de mesa siempre abierta`);
    }
    steps.push(`nivelado ${part.boardLevelRatio ?? 2}:1 → techo ${part.boardLevelCeilingDb ?? -3} dB${anchor}${part.boardLevelKneeDb != null ? `, suelo de voz ${part.boardLevelKneeDb} dB` : ', suelo de voz = sala+4'}`);
    steps.push(`limitador ${Math.min((part.boardLevelCeilingDb ?? -3) + 1, -0.5)} dB`);
  } else {
    const g = part.boardGainDb ?? 0;
    steps.push(`manual: ganancia ${g >= 0 ? '+' : ''}${g} dB${(part.boardCompress ?? true) ? ' + compresor 4:1 (−25 dB)' : ''}`);
    if (g !== 0 || (part.boardCompress ?? true)) steps.push('limitador −0.4 dB');
  }
  const vol = part.boardVolume ?? 1;
  if (vol !== 1) steps.push(`vol ×${vol}`);
  return steps.join(' → ');
}

export function describeAmbientChain(part: ProjectPart): string {
  const steps: string[] = [];
  // "nivel manual": the zones are absolute levels that replace the curve — a
  // part mixed under the old additive meaning ("subida manual") reads as
  // changed and asks for a re-mix, which is right: its ramps and overlaps
  // sound different now.
  const boosts = (part.ambientBoostRegions ?? []).filter((r) => r.enabled);
  if (boosts.length > 0) steps.push(`${boosts.length} zona(s) de nivel manual`);
  const noRaise = (part.ambientNoRaiseRegions ?? []).filter((r) => r.enabled);
  if (noRaise.length > 0) steps.push(`${noRaise.length} zona(s) sin subida automática`);
  if (part.ambientDuckOnVoice) {
    const gap = part.ambientGapBoostDb ?? 0;
    steps.push(
      `con voz −${part.ambientVoiceDuckDb ?? 8} dB` +
      (gap > 0 ? `, en huecos +${gap} dB` : '') +
      ` (anticipa ${part.ambientVoiceAnticipateMs ?? 200} ms, ataque ${part.ambientVoiceAttackMs ?? 15} ms` +
      `, pausa mínima ${part.ambientVoiceHoldMs ?? 600} ms, vuelve ${part.ambientVoiceReleaseMs ?? 400} ms` +
      `, sube ${part.ambientPreRiseMs ?? 150} ms antes de acabar la voz` +
      ((part.ambientGateDb ?? 6) > 0 ? `, solo con público ≥ +${part.ambientGateDb ?? 6} dB` : ', sin puerta de público') +
      `)`,
    );
  } else {
    steps.push('sin ducking por voz');
  }
  const vol = part.ambientVolume ?? 0.7;
  steps.push(`vol ×${vol}`);
  return steps.join(' → ');
}

export function describeMixChain(part: ProjectPart): string {
  return `mesa procesada + ambiente procesado → limitador −0.4 dB` +
    ((part.boardVolume ?? 1) !== 1 || (part.ambientVolume ?? 0.7) !== 0.7
      ? ` (vol mesa ×${part.boardVolume ?? 1}, ambiente ×${part.ambientVolume ?? 0.7})`
      : '');
}

/** The chain descriptions the part's CURRENT settings would produce. */
export function chainNowOf(part: ProjectPart): { board: string; ambient: string; mix: string } {
  return { board: describeBoardChain(part), ambient: describeAmbientChain(part), mix: describeMixChain(part) };
}

/** True when the settings no longer match the mix that is on disk (what the
 *  part card shows as "⚠ ajustes cambiados desde esta mezcla"). */
export function mixSettingsChanged(part: ProjectPart): boolean {
  if (!part.mixChainApplied) return false;
  const now = chainNowOf(part);
  return part.mixChainApplied.board !== now.board
    || part.mixChainApplied.ambient !== now.ambient
    || part.mixChainApplied.mix !== now.mix;
}

/**
 * True when this part must be re-mixed before the parts can be joined.
 * Drawing a zone PATCHes the part and drops it from 'done' to 'aligned', so a
 * zone drawn BEFORE a reload leaves no trace in the editor's in-memory
 * `dirtyParts` — only in the status. The join copies every part and refuses
 * while any of them is unmixed, which is how "Aplicar" failed with
 * «Partes sin procesar: Parte 2» on a part the user had not touched that day.
 * A part mid-processing or without an alignment offset cannot be mixed from
 * here, so it is not claimed as re-mixable.
 */
export function partNeedsRemix(part: ProjectPart): boolean {
  if (part.status === 'processing' || part.alignmentOffsetMs == null) return false;
  return part.status !== 'done' || mixSettingsChanged(part);
}
