// Ridge regression from gaze features to screen coordinates.
// Features are z-scored, expanded with a small set of quadratic terms, then two
// independent ridge models (x and y) are solved in closed form.

export type Vec = number[];

export interface Sample {
  features: Vec;
  x: number;
  y: number;
  /** Sample weight; implicit-recalibration samples get < 1. */
  w?: number;
}

/** Solve (A) x = b for a small symmetric positive-definite A via Gaussian elimination with pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/**
 * Feature expansion. Base features (z-scored) are kept linearly; the first `quadCount`
 * of them (the gaze-direction terms) also get squares and pairwise products, which
 * captures the non-linearity of eye rotation -> screen position.
 */
export function expand(z: Vec, quadCount: number): Vec {
  const out = [1, ...z];
  const q = Math.min(quadCount, z.length);
  for (let i = 0; i < q; i++) for (let j = i; j < q; j++) out.push(z[i] * z[j]);
  return out;
}

export class GazeRegressor {
  private mean: Vec = [];
  private std: Vec = [];
  private wx: Vec = [];
  private wy: Vec = [];
  trained = false;

  constructor(
    public lambda = 1.0,
    private readonly quadCount = 4,
    /** Per-feature lower bound on the z-score std (same order as the feature vector). */
    private readonly stdFloor: Vec = [],
    /** Per-feature multiplier on the ridge penalty (same order as the feature vector). >1 = trust less. */
    public penaltyScale: Vec = [],
  ) {}

  fit(samples: Sample[]): void {
    if (samples.length < 4) throw new Error("need at least 4 calibration samples");
    const d = samples[0].features.length;
    this.mean = new Array(d).fill(0);
    this.std = new Array(d).fill(0);
    for (const s of samples) s.features.forEach((v, i) => (this.mean[i] += v / samples.length));
    for (const s of samples)
      s.features.forEach((v, i) => (this.std[i] += (v - this.mean[i]) ** 2 / samples.length));
    this.std = this.std.map((v, i) => Math.max(Math.sqrt(v), this.stdFloor[i] ?? 0) || 1);
    this.solveWeights(samples, null, 0);
  }

  /**
   * Personalise a pooled model: keep the prior's feature normalisation and pull the
   * weights toward the prior's ("ridge toward the prior"). `strength` plays the role of
   * lambda; the intercept stays free so a per-user offset is always learnable.
   */
  fitWithPrior(samples: Sample[], prior: GazeRegressor, strength: number): void {
    if (!prior.trained) throw new Error("prior is not trained");
    if (samples.length < 1) throw new Error("need at least 1 calibration sample");
    this.mean = [...prior.mean];
    this.std = [...prior.std];
    this.solveWeights(samples, prior, strength);
  }

  private solveWeights(samples: Sample[], prior: GazeRegressor | null, strength: number): void {
    const rows = samples.map((s) => expand(this.normalize(s.features), this.quadCount));
    const k = rows[0].length;
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
    const Xty = new Array(k).fill(0);
    const Xtx2 = new Array(k).fill(0);
    rows.forEach((r, n) => {
      const w = samples[n].w ?? 1;
      for (let i = 0; i < k; i++) {
        Xty[i] += w * r[i] * samples[n].x;
        Xtx2[i] += w * r[i] * samples[n].y;
        for (let j = 0; j < k; j++) XtX[i][j] += w * r[i] * r[j];
      }
    });
    // Don't regularise the intercept.
    // Column i (i>=1) is z-feature i-1 for i<=d, then quadratic terms (scale 1).
    const d = this.mean.length;
    const reg = prior ? strength : this.lambda;
    for (let i = 1; i < k; i++) {
      XtX[i][i] += reg * (i <= d ? (this.penaltyScale[i - 1] ?? 1) : 1);
      if (prior) {
        Xty[i] += reg * prior.wx[i];
        Xtx2[i] += reg * prior.wy[i];
      }
    }
    this.wx = solve(XtX, Xty);
    this.wy = solve(XtX, Xtx2);
    this.trained = true;
  }

  predict(features: Vec): { x: number; y: number } {
    if (!this.trained) return { x: NaN, y: NaN };
    const r = expand(this.normalize(features), this.quadCount);
    let x = 0;
    let y = 0;
    for (let i = 0; i < r.length; i++) {
      x += r[i] * this.wx[i];
      y += r[i] * this.wy[i];
    }
    return { x, y };
  }

  private normalize(f: Vec): Vec {
    // Clamp: the quadratic terms explode if a feature drifts well outside what calibration saw.
    return f.map((v, i) => Math.max(-4, Math.min(4, (v - this.mean[i]) / this.std[i])));
  }
}

/**
 * Pick the ridge strength by leave-one-dot-out cross-validation: fit without one dot's samples, measure the
 * error on that dot, and keep the lambda with the lowest median held-out error. Needs the samples to carry
 * exact target coordinates (a dot = a unique x,y).
 */
export function chooseLambda(
  samples: Sample[],
  quadCount: number,
  stdFloor: Vec,
  penaltyScale: Vec = [],
  lambdas = [0.1, 0.3, 1, 3, 10, 30],
): { lambda: number; medianErrPx: number } {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const k = `${s.x},${s.y}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  const keys = [...groups.keys()];
  let best = { lambda: 1, medianErrPx: Infinity };
  if (keys.length < 6) return best;
  for (const lambda of lambdas) {
    const errs: number[] = [];
    for (const k of keys) {
      const train = samples.filter((s) => `${s.x},${s.y}` !== k);
      if (train.length < 8) continue;
      const m = new GazeRegressor(lambda, quadCount, stdFloor, penaltyScale);
      m.fit(train);
      const held = groups.get(k)!;
      const e = held.map((h) => {
        const q = m.predict(h.features);
        return Math.hypot(q.x - h.x, q.y - h.y);
      });
      errs.push(e.reduce((a, b) => a + b, 0) / e.length);
    }
    errs.sort((a, b) => a - b);
    const med = errs[Math.floor(errs.length / 2)];
    if (med < best.medianErrPx) best = { lambda, medianErrPx: med };
  }
  return best;
}
