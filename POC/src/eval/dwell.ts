// Dwell-selection simulation on recorded sessions: runs the app's own smoothing filter,
// target tracker (snap + hysteresis) and dwell selector over the frames recorded while
// the participant looked at each test dot, with buttons laid out around that dot.
// This is the number a user feels: did looking at the button select it?
import { PointFilter } from "../gaze/oneEuro";
import { AccumulatingDwellSelector, DwellSelector, TargetTracker, type Rect } from "../input/selection";
import type { Layout } from "./metrics";
import type { PreparedPoint, Predictor } from "./replay";

export interface DwellConfig {
  layout: Layout;
  dwellMs: number;
  snapPx: number;
  switchMs: number;
  minCutoff: number;
  beta: number;
  /** Gap between buttons as a fraction of the cell size. */
  gapFrac: number;
  /** "reset": classic dwell (progress resets on leaving). "accumulate": evidence with decay. */
  selector?: "reset" | "accumulate";
  /** Evidence drain rate for "accumulate" (1 = drains as fast as it fills). */
  decay?: number;
}

/** The original dwell settings (TargetTracker(36, 90), classic 700 ms dwell). */
export const OLD_DWELL: Omit<DwellConfig, "layout"> = { dwellMs: 700, snapPx: 36, switchMs: 90, minCutoff: 0.8, beta: 0.015, gapFrac: 0.06, selector: "reset" };
/** What the app does now (main.ts: TargetTracker(36, 200), AccumulatingDwellSelector(700, 0.5); engine.ts: PointFilter(0.8, 0.015)). */
export const APP_DWELL: Omit<DwellConfig, "layout"> = { ...OLD_DWELL, switchMs: 200, selector: "accumulate", decay: 0.5 };

export interface DwellStats {
  n: number;
  /** Share of dots where the first selection was the button under the dot. */
  correct: number;
  /** First selection was a neighbouring button. */
  wrong: number;
  /** Nothing selected before the dot disappeared (~2.3 s in recordings). */
  none: number;
  /** Mean time from dot onset to a correct selection (ms). */
  meanTimeMs: number;
}

/** Buttons of one layout's cell size, tiled so that one button is centred on the dot. */
export function buttonsAround(tx: number, ty: number, vw: number, vh: number, layout: Layout, gapFrac: number): Rect[] {
  const w = vw / layout.cols;
  const h = vh / layout.rows;
  const bw = w * (1 - gapFrac);
  const bh = h * (1 - gapFrac);
  const rects: Rect[] = [];
  for (let i = -layout.cols; i <= layout.cols; i++)
    for (let j = -layout.rows; j <= layout.rows; j++) {
      const cx = tx + i * w;
      const cy = ty + j * h;
      if (cx < 0 || cx > vw || cy < 0 || cy > vh) continue;
      rects.push({ id: `${i},${j}`, left: cx - bw / 2, top: cy - bh / 2, right: cx + bw / 2, bottom: cy + bh / 2 });
    }
  return rects;
}

export type DwellResult = { kind: "correct" | "wrong" | "none"; timeMs: number };

export function simulatePoint(p: PreparedPoint, predict: Predictor, cfg: DwellConfig): DwellResult {
  const tx = p.fx * p.vw;
  const ty = p.fy * p.vh;
  const rects = buttonsAround(tx, ty, p.vw, p.vh, cfg.layout, cfg.gapFrac);
  const filter = new PointFilter(cfg.minCutoff, cfg.beta);
  const tracker = new TargetTracker(cfg.snapPx, cfg.switchMs);
  const dwell = cfg.selector === "accumulate" ? new AccumulatingDwellSelector(cfg.dwellMs, cfg.decay ?? 1) : new DwellSelector(cfg.dwellMs);
  let last: { x: number; y: number } | null = null;
  for (const f of p.timeline) {
    if (f.t > p.tEnd) break;
    let target: string | null = null;
    if (f.v && !f.closed) {
      const q = predict(f.v);
      last = filter.filter({ x: q.x * p.vw, y: q.y * p.vh }, f.t);
      target = tracker.update(f.t, rects, last.x, last.y);
    } else if (f.v && f.closed && last) {
      // Eyes shut: the app holds the cursor where it was.
      target = tracker.update(f.t, rects, last.x, last.y);
    }
    const out = dwell.update(f.t, target);
    if (out.selected) return { kind: out.selected === "0,0" ? "correct" : "wrong", timeMs: f.t - p.tShown };
  }
  return { kind: "none", timeMs: NaN };
}

export function simulateDwell(points: PreparedPoint[], predict: Predictor, cfg: DwellConfig): DwellStats {
  const rs = points.filter((p) => p.timeline.length).map((p) => simulatePoint(p, predict, cfg));
  const n = rs.length || 1;
  const times = rs.filter((r) => r.kind === "correct").map((r) => r.timeMs);
  return {
    n: rs.length,
    correct: rs.filter((r) => r.kind === "correct").length / n,
    wrong: rs.filter((r) => r.kind === "wrong").length / n,
    none: rs.filter((r) => r.kind === "none").length / n,
    meanTimeMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : NaN,
  };
}
