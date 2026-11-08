// Turns tracker frames (or the mouse, for development) into a smoothed on-screen pointer
// position. Owns calibration data and implicit recalibration. Pointer tracking only: the
// eye-tracker mode was removed (see the parked improve-eyetracking-confidence branch).
import { GazeRegressor, type Sample } from "./regression";
import { PointFilter } from "./oneEuro";
import type { FaceFrame } from "./tracker";

export interface GazePoint {
  t: number;
  x: number;
  y: number;
  valid: boolean;
  blinkL: number;
  blinkR: number;
  /** "camera" | "mouse" */
  source: string;
  /**
   * The estimate fell off the screen (x/y are then pinned to the nearest edge). Nothing should
   * be selected from such a point: it would land on an edge key the user isn't looking at.
   */
  offscreen?: boolean;
}

/** How far past the screen edge (px) the estimate may go before it counts as lost. */
const OFFSCREEN_MARGIN = 40;

/** Pin a point to the visible area and say whether it was outside it. */
export function clampToView(x: number, y: number, w: number, h: number, margin = OFFSCREEN_MARGIN) {
  const offscreen = x < -margin || y < -margin || x > w + margin || y > h + margin;
  return { x: Math.min(w, Math.max(0, x)), y: Math.min(h, Math.max(0, y)), offscreen };
}

const KEY_CAL = "gazetype.calibration.v1";
const KEY_CAL_POINTER = "gazetype.calibration.pointer.v1";
// Pointer-tracker feature order: yaw, pitch, tipX, tipY, tipRelX, tipRelY, roll, faceH, eyeMidX, eyeMidY.
// The floors stop a near-constant feature from getting a huge weight after z-scoring.
export const POINTER_FLOOR = [0.02, 0.02, 0.01, 0.01, 0.02, 0.02, 0.02, 0.01, 0.01, 0.01];
/**
 * Pointer model: a straight-line ridge fit on yaw and pitch only (entries 0 and 1 of the
 * 10-feature pointer vector), λ = 1. On the first two recorded pointer sessions it beat the
 * earlier 10-feature quadratic model (λ by cross-validation) on both: 6-chip hits 46% -> 65%
 * mean; dwell-correct 25% -> 75% on the one file with long enough dots. It squashes vertical
 * reach and the evidence is thin, so `npm run replay` keeps scoring both side by side on every
 * pointer recording ("simple" vs "original"); switch back if the data says so.
 * The full 10-feature vector is always recorded/exported.
 */
export type PointerModel = "simple" | "original";
export const SIMPLE_POINTER = { inputs: [0, 1] as const, quadCount: 0, lambda: 1 };
export const simplePointerInput = (v: number[]) => SIMPLE_POINTER.inputs.map((i) => v[i]);
export const SIMPLE_POINTER_FLOOR = SIMPLE_POINTER.inputs.map((i) => POINTER_FLOOR[i]);
/** Pointer-tracker cursor settings (also mirrored by the offline dwell simulation). */
export const POINTER_FILTER = { minCutoff: 1.0, beta: 0.01 } as const;
export const POINTER_STILL_RADIUS_PX = 10;
export const POINTER_OFFSCREEN_PX = 300;
const MAX_IMPLICIT = 240;

export class GazeEngine {
  source: "camera" | "mouse" = "mouse";
  /** Where calibration is saved; set per profile so each person keeps their own. */
  storageKey = KEY_CAL;
  /** Pointer calibrations are stored under their own key (per profile). */
  private get calKey() {
    return this.storageKey === KEY_CAL ? KEY_CAL_POINTER : `${this.storageKey}.pointer`;
  }
  // The pointer: simple yaw+pitch model, no blink freeze, light smoothing, cursor kept on screen.
  private regressor = new GazeRegressor(SIMPLE_POINTER.lambda, SIMPLE_POINTER.quadCount, SIMPLE_POINTER_FLOOR);
  private filter = new PointFilter(POINTER_FILTER.minCutoff, POINTER_FILTER.beta);
  // Ignore wobble smaller than this many px, and trail the true point by that much when moving.
  private anchor: { x: number; y: number } | null = null;
  private stillRadiusPx = POINTER_STILL_RADIUS_PX;

  private clamp(p: { x: number; y: number }) {
    return { x: Math.min(Math.max(p.x, 0), innerWidth - 1), y: Math.min(Math.max(p.y, 0), innerHeight - 1) };
  }

  private leash(p: { x: number; y: number }) {
    const a = this.anchor;
    if (!a) return (this.anchor = { ...p });
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    if (d > this.stillRadiusPx) {
      const k = (d - this.stillRadiusPx) / d;
      a.x += (p.x - a.x) * k;
      a.y += (p.y - a.y) * k;
    }
    return { ...a };
  }
  /** Latest frame and unsmoothed prediction (for the session recorder). */
  dbg: { frame: FaceFrame | null; raw: { x: number; y: number } | null } = { frame: null, raw: null };
  private calSamples: Sample[] = [];
  private implicit: Sample[] = [];
  private recent: FaceFrame[] = [];
  private last: GazePoint = { t: 0, x: NaN, y: NaN, valid: false, blinkL: 0, blinkR: 0, source: "mouse" };
  private listeners = new Set<(g: GazePoint) => void>();
  private rawListeners = new Set<(f: FaceFrame | null) => void>();
  /** Smoothed iris diameter (fraction of frame width), for distance estimation. */
  irisDiameter = NaN;
  faceVisible = false;
  inferMs = 0;
  /** Drift correction from the last quick re-center, added to every estimate (px). */
  private offset = { x: 0, y: 0 };

  constructor() {
    let mouse: { x: number; y: number } | null = null;
    window.addEventListener("mousemove", (e) => {
      if (this.source !== "mouse") return;
      mouse = { x: e.clientX, y: e.clientY };
      this.emit({ t: performance.now(), x: e.clientX, y: e.clientY, valid: true, blinkL: 0, blinkR: 0, source: "mouse" });
    });
    document.addEventListener("mouseleave", () => (mouse = null));
    // A still mouse keeps "looking", like a camera that sends every frame, so hover-and-hold selects in mouse mode.
    setInterval(() => {
      if (this.source === "mouse" && mouse) this.emit({ t: performance.now(), x: mouse.x, y: mouse.y, valid: true, blinkL: 0, blinkR: 0, source: "mouse" });
    }, 50);
  }

  /** The fitted model's raw prediction (the pointer model sees yaw and pitch only). */
  private model(features: number[]) {
    return this.regressor.predict(simplePointerInput(features));
  }

  get calibrated() {
    return this.regressor.trained;
  }

  onGaze(fn: (g: GazePoint) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onRaw(fn: (f: FaceFrame | null) => void) {
    this.rawListeners.add(fn);
    return () => this.rawListeners.delete(fn);
  }

  private emit(g: GazePoint) {
    this.last = g;
    for (const l of this.listeners) l(g);
  }

  get lastPoint() {
    return this.last;
  }

  handleFrame = (f: FaceFrame | null) => {
    for (const l of this.rawListeners) l(f);
    if (this.source !== "camera") return;
    this.faceVisible = !!f;
    if (!f) {
      this.emit({ ...this.last, t: performance.now(), valid: false });
      return;
    }
    this.inferMs = this.inferMs * 0.9 + f.inferMs * 0.1;
    this.irisDiameter = Number.isFinite(this.irisDiameter) ? this.irisDiameter * 0.95 + f.irisDiameter * 0.05 : f.irisDiameter;
    this.recent.push(f);
    this.dbg.frame = f;
    while (this.recent.length && f.t - this.recent[0].t > 1500) this.recent.shift();
    // The pointer doesn't use the eyes, so a blink doesn't freeze it.
    if (!this.calibrated) {
      this.emit({ ...this.last, t: f.t, valid: false, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera" });
      return;
    }
    const p = this.model(f.vector);
    this.dbg.raw = p;
    // Drift correction from the last quick re-center.
    const q = { x: p.x + this.offset.x, y: p.y + this.offset.y };
    // Pointing far off the screen: hold the last point and mark it invalid so nothing is selected.
    const OFF = POINTER_OFFSCREEN_PX;
    if (q.x < -OFF || q.x > innerWidth + OFF || q.y < -OFF || q.y > innerHeight + OFF) {
      this.emit({ ...this.last, t: f.t, valid: false, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera", offscreen: true });
      return;
    }
    const n = this.leash(this.clamp(this.filter.filter(q, f.t)));
    this.emit({ t: f.t, x: n.x, y: n.y, valid: true, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera" });
  };

  /** Mean feature vector over open-eye frames in [t0, t1]. */
  meanFeatures(t0: number, t1: number): number[] | null {
    const fs = this.recent.filter((f) => f.t >= t0 && f.t <= t1 && !(f.blinkL > 0.45 && f.blinkR > 0.45));
    if (fs.length < 3) return null;
    const d = fs[0].vector.length;
    const m = new Array(d).fill(0);
    for (const f of fs) f.vector.forEach((v, i) => (m[i] += v / fs.length));
    return m;
  }

  /**
   * Open-eye frames in [t0, t1]: their mean features, plus how scattered their estimates are.
   * A large spread means the eyes moved, so it wasn't a steady look at one point.
   */
  fixation(t0: number, t1: number): { features: number[]; spreadPx: number } | null {
    const features = this.meanFeatures(t0, t1);
    if (!features) return null;
    const pts = this.recent
      .filter((f) => f.t >= t0 && f.t <= t1 && !(f.blinkL > 0.45 && f.blinkR > 0.45))
      .map((f) => this.model(f.vector));
    const mx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
    const my = pts.reduce((a, q) => a + q.y, 0) / pts.length;
    const spreadPx = Math.sqrt(pts.reduce((a, q) => a + (q.x - mx) ** 2 + (q.y - my) ** 2, 0) / pts.length);
    return { features, spreadPx };
  }

  /**
   * Quick re-center: the user looked at a known point (x, y). Drop the learned implicit samples
   * (selections made while the pointer was drifting would teach the model the wrong thing),
   * then shift every estimate so this look lands on the point. Returns the shift in px.
   */
  recenter(features: number[], x: number, y: number): number {
    this.implicit = [];
    this.refit();
    const raw = this.model(features);
    this.offset = { x: x - raw.x, y: y - raw.y };
    this.filter.reset();
    return Math.hypot(this.offset.x, this.offset.y);
  }

  get driftOffset() {
    return { ...this.offset };
  }

  setCalibration(samples: Sample[]) {
    this.calSamples = samples;
    this.implicit = [];
    this.offset = { x: 0, y: 0 };
    this.refit();
    try {
      localStorage.setItem(this.calKey, JSON.stringify(samples));
    } catch {
      /* storage full / disabled */
    }
  }

  get calibrationSamples() {
    return this.calSamples;
  }

  loadSavedCalibration(): boolean {
    try {
      const raw = localStorage.getItem(this.calKey);
      if (!raw) return false;
      const samples: Sample[] = JSON.parse(raw);
      if (samples[0]?.features.length !== this.recent.at(-1)?.vector.length) return false;
      this.setCalibration(samples);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Implicit recalibration: a selection the user did not undo tells us where they
   * were looking (the target centre). Add it as a down-weighted training sample.
   */
  addImplicitSample(features: number[], x: number, y: number) {
    if (!this.calSamples.length) return;
    // The model's own output gets the drift offset added later, so it should learn the target minus that offset.
    this.implicit.push({ features, x: x - this.offset.x, y: y - this.offset.y, w: 0.6 });
    if (this.implicit.length > MAX_IMPLICIT) this.implicit.shift();
    this.refit();
  }

  get implicitCount() {
    return this.implicit.length;
  }

  private refit() {
    const all = [...this.calSamples, ...this.implicit];
    if (all.length >= 8) this.regressor.fit(all.map((s) => ({ ...s, features: simplePointerInput(s.features) })));
    this.filter.reset();
    this.anchor = null;
  }

  /** Predict without smoothing (used by validation). */
  predictRaw(features: number[]) {
    return this.model(features);
  }
}
