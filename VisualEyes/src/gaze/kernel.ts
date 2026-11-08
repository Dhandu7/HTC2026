// Kernel ridge regression (RBF kernel) from gaze features to screen coordinates.
// Same interface as GazeRegressor. More flexible than the quadratic ridge, which helps
// when there are enough calibration points (25) to pin the shape down.
import type { Sample, Vec } from "./regression";

/** Cholesky solve of (A) X = B for symmetric positive-definite A, with several right-hand sides. */
export function choleskySolve(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      const Li = L[i];
      const Lj = L[j];
      for (let k = 0; k < j; k++) s -= Li[k] * Lj[k];
      if (i === j) Li[i] = Math.sqrt(Math.max(s, 1e-12));
      else Li[j] = s / Lj[j];
    }
  }
  return B.map((b) => {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
      y[i] = s / L[i][i];
    }
    const x = new Array<number>(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
      x[i] = s / L[i][i];
    }
    return x;
  });
}

export class KernelGazeRegressor {
  private mean: Vec = [];
  private std: Vec = [];
  private centres: Vec[] = [];
  private ax: number[] = [];
  private ay: number[] = [];
  private mx = 0;
  private my = 0;
  trained = false;

  /**
   * @param lambda ridge penalty
   * @param gamma RBF width on z-scored features: k(a,b) = exp(-gamma * |a-b|^2)
   * @param maxSamples training frames are thinned evenly to at most this many (cost is O(n^3))
   */
  constructor(
    private readonly lambda = 1,
    private readonly gamma = 0.1,
    private readonly maxSamples = 400,
  ) {}

  fit(all: Sample[]): void {
    if (all.length < 4) throw new Error("need at least 4 calibration samples");
    const step = Math.max(1, all.length / this.maxSamples);
    const samples: Sample[] = [];
    for (let i = 0; i < all.length; i += step) samples.push(all[Math.floor(i)]);
    const d = samples[0].features.length;
    this.mean = new Array(d).fill(0);
    this.std = new Array(d).fill(0);
    for (const s of samples) s.features.forEach((v, i) => (this.mean[i] += v / samples.length));
    for (const s of samples) s.features.forEach((v, i) => (this.std[i] += (v - this.mean[i]) ** 2 / samples.length));
    this.std = this.std.map((v) => Math.sqrt(v) || 1);
    this.centres = samples.map((s) => this.normalize(s.features));
    this.mx = samples.reduce((a, s) => a + s.x, 0) / samples.length;
    this.my = samples.reduce((a, s) => a + s.y, 0) / samples.length;
    const n = samples.length;
    const K = Array.from({ length: n }, () => new Array<number>(n));
    for (let i = 0; i < n; i++)
      for (let j = 0; j <= i; j++) {
        const k = this.kernel(this.centres[i], this.centres[j]);
        K[i][j] = K[j][i] = k;
      }
    // Sample weights (implicit samples < 1) scale the penalty per sample: lambda / w.
    for (let i = 0; i < n; i++) K[i][i] += this.lambda / (samples[i].w ?? 1);
    [this.ax, this.ay] = choleskySolve(K, [samples.map((s) => s.x - this.mx), samples.map((s) => s.y - this.my)]);
    this.trained = true;
  }

  predict(features: Vec): { x: number; y: number } {
    if (!this.trained) return { x: NaN, y: NaN };
    const z = this.normalize(features);
    let x = this.mx;
    let y = this.my;
    for (let i = 0; i < this.centres.length; i++) {
      const k = this.kernel(z, this.centres[i]);
      x += k * this.ax[i];
      y += k * this.ay[i];
    }
    return { x, y };
  }

  private kernel(a: Vec, b: Vec): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
    return Math.exp(-this.gamma * s);
  }

  private normalize(f: Vec): Vec {
    return f.map((v, i) => (v - this.mean[i]) / this.std[i]);
  }
}
