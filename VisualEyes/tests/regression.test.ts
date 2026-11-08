import { describe, expect, it } from "vitest";
import { GazeRegressor, solve } from "../src/gaze/regression";
import { PointFilter } from "../src/gaze/oneEuro";
import { estimateDistanceCm, pxToDegrees, degreesToPx, summarizeErrors } from "../src/gaze/accuracy";
import { headPose } from "../src/gaze/features";
import { KernelGazeRegressor, choleskySolve } from "../src/gaze/kernel";

describe("solve", () => {
  it("solves a 3x3 system", () => {
    const x = solve([[4, 1, 0], [1, 3, 1], [0, 1, 2]], [1, 2, 3]);
    expect(4 * x[0] + x[1]).toBeCloseTo(1);
    expect(x[0] + 3 * x[1] + x[2]).toBeCloseTo(2);
    expect(x[1] + 2 * x[2]).toBeCloseTo(3);
  });
});

describe("GazeRegressor", () => {
  it("recovers a non-linear mapping from 9-point calibration data", () => {
    // Synthetic eye model: screen = f(iris) with quadratic distortion + noise-free nuisance feature.
    const toScreen = (a: number, b: number) => ({ x: 800 + 900 * a + 150 * a * a, y: 450 + 700 * b - 80 * a * b });
    const samples = [];
    for (const a of [-0.5, 0, 0.5]) for (const b of [-0.5, 0, 0.5]) for (let k = 0; k < 10; k++) {
      const ja = a + (k - 5) * 0.004;
      const jb = b + (k % 3 - 1) * 0.004;
      samples.push({ features: [ja, jb, ja * 0.3, jb * 0.2, 0.01 * k], ...toScreen(ja, jb) });
    }
    const r = new GazeRegressor(0.01, 4);
    r.fit(samples);
    const p = r.predict([0.25, -0.25, 0.075, -0.05, 0.05]);
    const t = toScreen(0.25, -0.25);
    expect(Math.hypot(p.x - t.x, p.y - t.y)).toBeLessThan(25);
  });
});

describe("PointFilter", () => {
  it("reduces jitter on a still point", () => {
    const f = new PointFilter();
    let maxDev = 0;
    for (let i = 0; i < 120; i++) {
      const noisy = { x: 500 + (i % 2 ? 30 : -30), y: 300 };
      const o = f.filter(noisy, i * 33);
      if (i > 30) maxDev = Math.max(maxDev, Math.abs(o.x - 500));
    }
    expect(maxDev).toBeLessThan(15);
  });
});

describe("accuracy", () => {
  const g = { screenDiagonalIn: 14, screenWidthPx: 1512, screenHeightPx: 982, distanceCm: 60 };
  it("round-trips degrees and px", () => {
    expect(pxToDegrees(degreesToPx(3, g), g)).toBeCloseTo(3);
  });
  it("3 degrees at 60cm is ~3.1cm", () => {
    const cmPx = (14 * 2.54) / Math.hypot(1512, 982);
    expect(degreesToPx(3, g) * cmPx).toBeCloseTo(3.14, 1);
  });
  it("estimates a plausible distance from iris size", () => {
    // iris ~ 2.1% of frame width at 60° HFOV ≈ 48cm
    const d = estimateDistanceCm(0.021, 60);
    expect(d).toBeGreaterThan(40);
    expect(d).toBeLessThan(60);
  });
  it("summarizes accuracy and precision", () => {
    const s = summarizeErrors([{ target: { x: 0, y: 0 }, samples: [{ x: 10, y: 0 }, { x: 10, y: 0 }] }], g);
    expect(s.meanPx).toBeCloseTo(10);
    expect(s.precisionPx).toBeCloseTo(0);
  });
});

describe("headPose", () => {
  it("is zero for identity", () => {
    const p = headPose([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(p.yaw).toBeCloseTo(0);
    expect(p.pitch).toBeCloseTo(0);
    expect(p.roll).toBeCloseTo(0);
  });
});

describe("KernelGazeRegressor", () => {
  it("solves SPD systems with several right-hand sides", () => {
    const [x, y] = choleskySolve([[4, 1], [1, 3]], [[1, 2], [3, 4]]);
    expect(4 * x[0] + x[1]).toBeCloseTo(1);
    expect(x[0] + 3 * x[1]).toBeCloseTo(2);
    expect(4 * y[0] + y[1]).toBeCloseTo(3);
  });

  it("fits a non-linear mapping on held-out points", () => {
    const f = (a: number, b: number) => ({ x: 800 + 900 * a + 300 * Math.sin(2 * a), y: 450 + 700 * b * (1 + 0.3 * a) });
    const samples = [];
    for (let a = -0.5; a <= 0.5; a += 0.25) for (let b = -0.5; b <= 0.5; b += 0.25) samples.push({ features: [a, b], ...f(a, b) });
    const k = new KernelGazeRegressor(0.01, 0.3);
    k.fit(samples);
    const p = k.predict([0.125, -0.125]);
    const t = f(0.125, -0.125);
    expect(Math.hypot(p.x - t.x, p.y - t.y)).toBeLessThan(30);
  });
});

describe("AccumulatingDwellSelector", () => {
  it("keeps progress through a brief slip off the target, and drains a passing neighbour", async () => {
    const { AccumulatingDwellSelector } = await import("../src/input/selection");
    const d = new AccumulatingDwellSelector(300, 0.5);
    let t = 0;
    const step = (target: string | null) => d.update((t += 33), target);
    for (let i = 0; i < 5; i++) step("b"); // pass over neighbour b
    for (let i = 0; i < 6; i++) step("a");
    step(null); // one-frame slip
    let fired: string | null = null;
    for (let i = 0; i < 6 && !fired; i++) fired = step("a").selected;
    expect(fired).toBe("a");
  });
});
