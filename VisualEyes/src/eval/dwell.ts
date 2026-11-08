// Dwell-selection simulation on recorded sessions: runs the app's own cursor pipeline
// (smoothing, pointer-mode leash/clamp/off-screen cut-off), target tracker (snap + hysteresis)
// and dwell selector over the frames recorded while the participant pointed at each dot,
// with buttons laid out around that dot. This is the number a user feels: did pointing at
// the button select it?
import { PointFilter } from "../gaze/oneEuro";
import { POINTER_FILTER, POINTER_OFFSCREEN_PX, POINTER_STILL_RADIUS_PX } from "../gaze/engine";
import { DwellSelector, TargetTracker, type Rect } from "../input/selection";
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
  /** Pointer mode: ignore wobble below this radius (px); 0 = off. */
  leashPx: number;
  /** Pointer mode: pin the cursor to the screen. */
  clamp: boolean;
  /** Pointer mode: predictions this far (px) off the screen are invalid (nothing selected). Infinity = off. */
  offscreenPx: number;
  /** Freeze the cursor while both eyes are closed (off for the pointer). */
  freezeOnBlink: boolean;
}

const BASE = { snapPx: 36, switchMs: 90, gapFrac: 0.06 };
/** main.ts pointer mode: same tracker/dwell; engine.ts configurePointer(): PointFilter(1.0, 0.01), clamp, 10 px leash, 300 px off-screen cut-off, no blink freeze. */
export const POINTER_DWELL: Omit<DwellConfig, "layout"> = {
  ...BASE,
  dwellMs: 2000,
  minCutoff: POINTER_FILTER.minCutoff,
  beta: POINTER_FILTER.beta,
  leashPx: POINTER_STILL_RADIUS_PX,
  clamp: true,
  offscreenPx: POINTER_OFFSCREEN_PX,
  freezeOnBlink: false,
};

export interface DwellStats {
  /** Dots long enough to simulate (dot duration ≥ dwell + 0.5 s). */
  n: number;
  /** Share of dots where the first selection was the button under the dot. */
  correct: number;
  /** First selection was a neighbouring button. */
  wrong: number;
  /** Nothing selected before the dot disappeared. */
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
  const dwell = new DwellSelector(cfg.dwellMs);
  let last: { x: number; y: number } | null = null;
  let anchor: { x: number; y: number } | null = null;
  for (const f of p.timeline) {
    if (f.t > p.tEnd) break;
    let target: string | null = null;
    if (f.v && !(cfg.freezeOnBlink && f.closed)) {
      const q = predict(f.v);
      const px = q.x * p.vw;
      const py = q.y * p.vh;
      const off = cfg.offscreenPx;
      if (!(px < -off || px > p.vw + off || py < -off || py > p.vh + off)) {
        let s = filter.filter({ x: px, y: py }, f.t);
        if (cfg.clamp) s = { x: Math.min(Math.max(s.x, 0), p.vw - 1), y: Math.min(Math.max(s.y, 0), p.vh - 1) };
        if (cfg.leashPx > 0) {
          if (!anchor) anchor = { ...s };
          const d = Math.hypot(s.x - anchor.x, s.y - anchor.y);
          if (d > cfg.leashPx) {
            const k = (d - cfg.leashPx) / d;
            anchor.x += (s.x - anchor.x) * k;
            anchor.y += (s.y - anchor.y) * k;
          }
          s = { ...anchor };
        }
        last = s;
        target = tracker.update(f.t, rects, s.x, s.y);
      }
    } else if (f.v && f.closed && last) {
      // freezeOnBlink: eyes shut, hold the cursor where it was.
      target = tracker.update(f.t, rects, last.x, last.y);
    }
    const out = dwell.update(f.t, target);
    if (out.selected) return { kind: out.selected === "0,0" ? "correct" : "wrong", timeMs: f.t - p.tShown };
  }
  return { kind: "none", timeMs: NaN };
}

export function simulateDwell(points: PreparedPoint[], predict: Predictor, cfg: DwellConfig): DwellStats {
  const usable = points.filter((p) => p.timeline.length && p.tEnd - p.tShown >= cfg.dwellMs + 500);
  const rs = usable.map((p) => simulatePoint(p, predict, cfg));
  const n = rs.length || 1;
  const times = rs.filter((r) => r.kind === "correct").map((r) => r.timeMs);
  return {
    n: rs.length,
    correct: rs.length ? rs.filter((r) => r.kind === "correct").length / n : NaN,
    wrong: rs.length ? rs.filter((r) => r.kind === "wrong").length / n : NaN,
    none: rs.length ? rs.filter((r) => r.kind === "none").length / n : NaN,
    meanTimeMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : NaN,
  };
}
