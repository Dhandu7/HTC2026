// Converts on-screen pixel error into visual angle (degrees), the unit the
// eye-tracking literature reports. Assumptions are explicit and user-editable.

export interface ViewingGeometry {
  /** Physical screen diagonal in inches. */
  screenDiagonalIn: number;
  /** Screen size in CSS pixels (window.screen.width/height). */
  screenWidthPx: number;
  screenHeightPx: number;
  /** Eye-to-screen distance in cm. */
  distanceCm: number;
}

export function cmPerPx(g: ViewingGeometry): number {
  return (g.screenDiagonalIn * 2.54) / Math.hypot(g.screenWidthPx, g.screenHeightPx);
}

export function pxToDegrees(px: number, g: ViewingGeometry): number {
  return (Math.atan2(px * cmPerPx(g), g.distanceCm) * 180) / Math.PI;
}

export function degreesToPx(deg: number, g: ViewingGeometry): number {
  return (Math.tan((deg * Math.PI) / 180) * g.distanceCm) / cmPerPx(g);
}

/** Average human iris diameter (mm) — roughly constant across adults (~11.7 ± 0.5). */
export const IRIS_MM = 11.7;

/**
 * Pinhole estimate of eye-to-camera distance from apparent iris size.
 * irisFraction = iris diameter / frame width. hfovDeg = camera horizontal field of view.
 */
export function estimateDistanceCm(irisFraction: number, hfovDeg = 60): number {
  if (!(irisFraction > 0)) return NaN;
  // focal length in "frame widths"
  const f = 0.5 / Math.tan((hfovDeg * Math.PI) / 360);
  return (f * IRIS_MM) / irisFraction / 10;
}

export interface ErrorStats {
  meanPx: number;
  medianPx: number;
  /** RMS sample-to-sample spread around each point's mean (precision). */
  precisionPx: number;
  meanDeg: number;
  precisionDeg: number;
  n: number;
}

export function summarizeErrors(
  points: { target: { x: number; y: number }; samples: { x: number; y: number }[] }[],
  g: ViewingGeometry,
): ErrorStats {
  const errs: number[] = [];
  let spreadSq = 0;
  let spreadN = 0;
  for (const p of points) {
    if (!p.samples.length) continue;
    const mx = p.samples.reduce((s, v) => s + v.x, 0) / p.samples.length;
    const my = p.samples.reduce((s, v) => s + v.y, 0) / p.samples.length;
    for (const s of p.samples) {
      errs.push(Math.hypot(s.x - p.target.x, s.y - p.target.y));
      spreadSq += (s.x - mx) ** 2 + (s.y - my) ** 2;
      spreadN++;
    }
  }
  const sorted = [...errs].sort((a, b) => a - b);
  const meanPx = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
  const medianPx = sorted[Math.floor(sorted.length / 2)] ?? NaN;
  const precisionPx = Math.sqrt(spreadSq / (spreadN || 1));
  return {
    meanPx,
    medianPx,
    precisionPx,
    meanDeg: pxToDegrees(meanPx, g),
    precisionDeg: pxToDegrees(precisionPx, g),
    n: errs.length,
  };
}
