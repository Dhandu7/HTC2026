// Accuracy / precision / hit-rate metrics for offline evaluation, reported the way the
// eye-tracking literature does: accuracy (offset of the mean gaze from the target)
// separately from precision (spread), both in px and degrees.
import { pxToDegrees, type ViewingGeometry } from "../gaze/accuracy";

export interface XY {
  x: number;
  y: number;
}

export interface PointPredictions {
  target: XY;
  /** Predictions for consecutive frames while the participant looked at target. */
  preds: XY[];
}

/** A grid layout filling the viewport; a hit = sample inside a cell-sized box centred on the target. */
export interface Layout {
  name: string;
  cols: number;
  rows: number;
}

export const LAYOUTS: Layout[] = [
  { name: "4-chip (2x2)", cols: 2, rows: 2 },
  { name: "6-chip (3x2)", cols: 3, rows: 2 },
  { name: "16-grid (4x4)", cols: 4, rows: 4 },
];

export interface EvalStats {
  nPoints: number;
  nSamples: number;
  /** Mean over points of |mean prediction − target|. */
  accuracyPx: number;
  accuracyDeg: number;
  /** Mean absolute horizontal / vertical offset of the per-point mean. */
  accuracyXPx: number;
  accuracyYPx: number;
  /** RMS distance of samples from their point's mean (SD precision). */
  precisionSdPx: number;
  precisionSdDeg: number;
  /** RMS of distances between consecutive samples (RMS-S2S precision). */
  precisionS2sPx: number;
  precisionS2sDeg: number;
  /** Mean per-sample distance to target (the app's existing "mean error"; mixes offset and noise). */
  meanSampleErrPx: number;
  meanSampleErrDeg: number;
  /** Fraction of samples that land inside a cell-sized box centred on the target, per layout. */
  hitRate: Record<string, number>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function evaluate(points: PointPredictions[], vw: number, vh: number, g: ViewingGeometry, layouts = LAYOUTS): EvalStats {
  const used = points.map((p) => ({ ...p, preds: p.preds.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y)) })).filter((p) => p.preds.length);
  const acc: number[] = [];
  const accX: number[] = [];
  const accY: number[] = [];
  const sampleErr: number[] = [];
  let sdSq = 0;
  let sdN = 0;
  let s2sSq = 0;
  let s2sN = 0;
  const hits: Record<string, number> = Object.fromEntries(layouts.map((l) => [l.name, 0]));
  for (const p of used) {
    const mx = mean(p.preds.map((q) => q.x));
    const my = mean(p.preds.map((q) => q.y));
    acc.push(Math.hypot(mx - p.target.x, my - p.target.y));
    accX.push(Math.abs(mx - p.target.x));
    accY.push(Math.abs(my - p.target.y));
    p.preds.forEach((q, i) => {
      sampleErr.push(Math.hypot(q.x - p.target.x, q.y - p.target.y));
      sdSq += (q.x - mx) ** 2 + (q.y - my) ** 2;
      sdN++;
      if (i > 0) {
        s2sSq += (q.x - p.preds[i - 1].x) ** 2 + (q.y - p.preds[i - 1].y) ** 2;
        s2sN++;
      }
      for (const l of layouts) {
        if (Math.abs(q.x - p.target.x) < vw / l.cols / 2 && Math.abs(q.y - p.target.y) < vh / l.rows / 2) hits[l.name]++;
      }
    });
  }
  const nSamples = sampleErr.length;
  const deg = (px: number) => pxToDegrees(px, g);
  const accuracyPx = mean(acc);
  const precisionSdPx = Math.sqrt(sdSq / (sdN || 1));
  const precisionS2sPx = Math.sqrt(s2sSq / (s2sN || 1));
  const meanSampleErrPx = mean(sampleErr);
  return {
    nPoints: used.length,
    nSamples,
    accuracyPx,
    accuracyDeg: deg(accuracyPx),
    accuracyXPx: mean(accX),
    accuracyYPx: mean(accY),
    precisionSdPx,
    precisionSdDeg: deg(precisionSdPx),
    precisionS2sPx,
    precisionS2sDeg: deg(precisionS2sPx),
    meanSampleErrPx,
    meanSampleErrDeg: deg(meanSampleErrPx),
    hitRate: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, nSamples ? v / nSamples : NaN])),
  };
}
