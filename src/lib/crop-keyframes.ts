import type { CropKeyframe, CropRegion } from '@/types/project';

/**
 * Animated 9:16 crop ("keyframes de encuadre") — shared math for the reel
 * previews, the crop-rect overlay and the FFmpeg export, so all three agree.
 *
 * Semantics: with ≥1 keyframes, the effective crop at reel time t is the
 * LINEAR interpolation of centerX/centerY/scale between the surrounding
 * keyframes; constant before the first and after the last. With none, the
 * static cropRegion applies.
 */

/** Effective crop at a reel-timeline time. */
export function cropAtTime(
  base: CropRegion,
  keyframes: CropKeyframe[] | undefined,
  tMs: number,
): CropRegion {
  if (!keyframes || keyframes.length === 0) return base;
  const kfs = [...keyframes].sort((a, b) => a.timeMs - b.timeMs);
  if (tMs <= kfs[0].timeMs) return pick(kfs[0]);
  const last = kfs[kfs.length - 1];
  if (tMs >= last.timeMs) return pick(last);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (tMs >= a.timeMs && tMs <= b.timeMs) {
      const span = b.timeMs - a.timeMs;
      const f = span > 0 ? (tMs - a.timeMs) / span : 0;
      return {
        centerX: a.centerX + (b.centerX - a.centerX) * f,
        centerY: a.centerY + (b.centerY - a.centerY) * f,
        scale: a.scale + (b.scale - a.scale) * f,
      };
    }
  }
  return pick(last);
}

function pick(k: CropKeyframe): CropRegion {
  return { centerX: k.centerX, centerY: k.centerY, scale: k.scale };
}

/** Clamp a crop so the 9:16 window stays fully inside the source frame.
 *  Keyframed crops must be in-frame: the window constraints are linear in
 *  (center, scale), so if every keyframe satisfies them the interpolated
 *  window does too — keeping preview and export (zoompan pads with a black
 *  canvas instead of clamping into the source) pixel-identical. */
export function clampCropToFrame(crop: CropRegion, srcW: number, srcH: number): CropRegion {
  const halfH = crop.scale / 2;
  const halfW = (crop.scale * srcH * 9) / (16 * srcW) / 2;
  return {
    scale: crop.scale,
    centerX: Math.max(Math.min(halfW, 0.5), Math.min(1 - halfW, crop.centerX)),
    centerY: Math.max(Math.min(halfH, 0.5), Math.min(1 - halfH, crop.centerY)),
  };
}

/** Insert or replace a keyframe at tMs (merging within toleranceMs so a drag
 *  at the playhead updates the existing keyframe instead of stacking dupes).
 *  Returns a new sorted array. */
export function upsertCropKeyframe(
  keyframes: CropKeyframe[] | undefined,
  kf: CropKeyframe,
  toleranceMs = 80,
): CropKeyframe[] {
  const rest = (keyframes ?? []).filter((k) => Math.abs(k.timeMs - kf.timeMs) > toleranceMs);
  return [...rest, kf].sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Remap keyframe times from REEL-TIMELINE time to concatenated OUTPUT time.
 * The export joins the rv1 clips back-to-back, collapsing timeline gaps —
 * every other timed element (subtitles, overlays, audio ranges) is remapped
 * the same way in render-worker. Identity when clips are contiguous from 0.
 * Keyframes inside a gap clamp to the cut; before the first clip the mapped
 * time may go negative (fine: the piecewise expression still interpolates
 * the correct segment at t=0).
 */
export function remapCropKeyframesToClips(
  keyframes: CropKeyframe[] | undefined,
  clips: { timelineStartMs: number; timelineEndMs: number }[],
): CropKeyframe[] | undefined {
  if (!keyframes || keyframes.length === 0 || clips.length === 0) return keyframes;
  const kfs = [...keyframes].sort((a, b) => a.timeMs - b.timeMs);
  const fallback = pick(kfs[0]);

  let acc = 0;
  const map = [...clips]
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs)
    .map((c) => {
      const e = { start: c.timelineStartMs, end: c.timelineEndMs, out: acc };
      acc += c.timelineEndMs - c.timelineStartMs;
      return e;
    });

  // Sample the PREVIEW function at every time that matters in the output and
  // emit those as the exported keyframes. Inside a clip the timeline→output
  // map is a constant shift, so linear interpolation is identical on both
  // sides; only the cuts need extra points, because lerp does NOT commute
  // with a gap-collapsing map. At a collapsed gap the player jumps, so the
  // crop jumps too: one point 1 ms before the cut holding the pre-gap value.
  const out: CropKeyframe[] = [];
  const add = (outMs: number, timelineMs: number, tag: string) => {
    const v = cropAtTime(fallback, kfs, timelineMs);
    out.push({ id: `${tag}-${Math.round(outMs)}`, timeMs: Math.round(outMs), ...v });
  };

  map.forEach((m, i) => {
    const prev = i > 0 ? map[i - 1] : undefined;
    if (prev && prev.end < m.start) {
      // Gap collapsed here — freeze the pre-gap framing until the cut, then
      // resume with the post-gap framing.
      add(m.out - 1, prev.end, 'gapend');
      add(m.out, m.start, 'gapstart');
    }
    for (const k of kfs) {
      if (k.timeMs >= m.start && k.timeMs <= m.end) {
        out.push({ ...k, timeMs: Math.round(m.out + (k.timeMs - m.start)) });
      }
    }
  });

  // Keyframes before the first clip / after the last one still anchor the
  // animation (constant-before-first / after-last semantics).
  const first = map[0];
  const last = map[map.length - 1];
  for (const k of kfs) {
    if (k.timeMs < first.start) out.push({ ...k, timeMs: Math.round(k.timeMs - first.start) });
    else if (k.timeMs > last.end) {
      out.push({ ...k, timeMs: Math.round(last.out + (last.end - last.start) + (k.timeMs - last.end)) });
    }
  }

  // Dedupe by output time (last write wins) and sort.
  const byTime = new Map<number, CropKeyframe>();
  for (const k of out.sort((a, b) => a.timeMs - b.timeMs)) byTime.set(k.timeMs, k);
  const result = Array.from(byTime.values()).sort((a, b) => a.timeMs - b.timeMs);
  return result.length > 0 ? result : kfs;
}

/**
 * Tightest crop the ANIMATED export can actually render: zoompan hard-clamps
 * its z to 10, so a window smaller than padH/(workH·10) of the source height
 * would silently render wider than the preview. The UI clamps to this while
 * keyframes are active so preview and export always agree.
 */
export function minAnimatedCropScale(srcW: number, srcH: number, outW = 1080, outH = 1920): number {
  const workW = Math.max(2, Math.ceil(srcW / 2) * 2);
  const workH = Math.max(2, Math.ceil(srcH / 2) * 2);
  let padH = Math.ceil((workW * outH) / outW / 2) * 2;
  if (padH < workH) padH = workH;
  return padH / (workH * 10);
}

/* ── FFmpeg export ──────────────────────────────────────────────────────── */

/** Piecewise-linear FFmpeg expression over variable `it` (input frame time,
 *  seconds). Values are emitted with 6 decimals; commas escaped for
 *  filter_complex. */
function piecewiseExpr(points: { t: number; v: number }[]): string {
  if (points.length === 1) return points[0].v.toFixed(6);
  let expr = points[points.length - 1].v.toFixed(6);
  // Build right-to-left: if(lt(it,t1), lerp0, if(lt(it,t2), lerp1, ... last))
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i];
    const b = points[i + 1];
    const span = Math.max(0.001, b.t - a.t);
    const seg = `${a.v.toFixed(6)}+(${(b.v - a.v).toFixed(6)})*(it-${a.t.toFixed(3)})/${span.toFixed(3)}`;
    expr = `if(lt(it\\,${b.t.toFixed(3)})\\,${seg}\\,${expr})`;
  }
  // Before the first keyframe: constant first value.
  expr = `if(lt(it\\,${points[0].t.toFixed(3)})\\,${points[0].v.toFixed(6)}\\,${expr})`;
  return expr;
}

/**
 * Build the animated-crop filter chain: pad the 16:9 work frame vertically to
 * the OUTPUT aspect (so zoompan's sampled region — which always matches the
 * input aspect — is 9:16), then zoompan with piecewise z/x/y expressions.
 *
 * Geometry (work frame W0×H0, padded height PH, output OW×OH):
 *   cropH(t) = H0·scale(t)          cropW(t) = cropH(t)·OW/OH
 *   z(t)  = PH / cropH(t)           (region = (W0/z, PH/z) = (cropW, cropH))
 *   x(t)  = centerX(t)·W0 − cropW(t)/2
 *   y(t)  = yOff + centerY(t)·H0 − cropH(t)/2       (yOff = (PH−H0)/2)
 *
 * Returns the filter string to append after the joined video stream, e.g.
 *   `pad=...,zoompan=...` (caller wires labels and fps normalization).
 */
export function buildAnimatedCropFilter(
  base: CropRegion,
  keyframes: CropKeyframe[],
  workW: number,
  workH: number,
  outW: number,
  outH: number,
  fps: number,
  padColor = 'black',
): string {
  const kfs = [...keyframes].sort((a, b) => a.timeMs - b.timeMs);
  const pts = kfs.map((k) => ({ t: k.timeMs / 1000, k }));

  // Padded canvas with the OUTPUT aspect, covering the work frame in BOTH
  // dimensions (a source narrower than the output aspect pads horizontally
  // instead — pad errors out if either padded dim were smaller than input).
  let padW = workW;
  let padH = Math.ceil((workW * outH) / outW / 2) * 2;
  if (padH < workH) {
    padH = workH;
    padW = Math.ceil((workH * outW) / outH / 2) * 2;
  }
  const xOff = Math.round((padW - workW) / 2);
  const yOff = Math.round((padH - workH) / 2);

  const sExpr = piecewiseExpr(pts.map(({ t, k }) => ({ t, v: clampScale(k.scale, workH, padH) })));
  const cxExpr = piecewiseExpr(pts.map(({ t, k }) => ({ t, v: k.centerX })));
  const cyExpr = piecewiseExpr(pts.map(({ t, k }) => ({ t, v: k.centerY })));

  const ratio = outW / outH; // cropW = cropH·ratio
  // z must stay ≥ 1 (guaranteed: scale ≤ padH/workH ⇒ z = padH/(H0·s) ≥ 1).
  // The sampled window is (padW/z, padH/z) = (cropH·ratio, cropH) — output
  // aspect by construction, so no distortion when scaled to outW×outH.
  const z = `${padH}/(${workH}*(${sExpr}))`;
  const x = `${xOff}+(${cxExpr})*${workW}-(${workH}*(${sExpr})*${ratio.toFixed(6)})/2`;
  const y = `${yOff}+(${cyExpr})*${workH}-(${workH}*(${sExpr}))/2`;

  return (
    `pad=${padW}:${padH}:${xOff}:${yOff}:color=${padColor},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${outW}x${outH}:fps=${fps}`
  );
}

/** Keep the crop window inside the padded frame (scale ≤ padH/workH ⇒ z ≥ 1)
 *  and within zoompan's hard z ≤ 10 clamp (scale ≥ padH/(workH·10) — about
 *  a 316% zoom on 16:9 sources; tighter crops would silently zoom out). */
function clampScale(scale: number, workH: number, padH: number): number {
  return Math.max(padH / (workH * 10), Math.min(scale, padH / workH));
}
