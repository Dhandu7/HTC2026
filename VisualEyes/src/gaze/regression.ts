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
    private readonly lambda = 1.0,
    private readonly quadCount = 4,
  ) {}

  fit(samples: Sample[]): void {
    if (samples.length < 4) throw new Error("need at least 4 calibration samples");
    const d = samples[0].features.length;
    this.mean = new Array(d).fill(0);
    this.std = new Array(d).fill(0);
    for (const s of samples) s.features.forEach((v, i) => (this.mean[i] += v / samples.length));
    for (const s of samples)
      s.features.forEach((v, i) => (this.std[i] += (v - this.mean[i]) ** 2 / samples.length));
    this.std = this.std.map((v) => Math.sqrt(v) || 1);

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
    for (let i = 1; i < k; i++) XtX[i][i] += this.lambda;
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
    return f.map((v, i) => (v - this.mean[i]) / this.std[i]);
  }
}
