// Turns tracker frames (or the mouse, for development) into a smoothed on-screen
// gaze point. Owns calibration data and implicit recalibration.
import { GazeRegressor, type Sample } from "./regression";
import { PointFilter } from "./oneEuro";
import type { FaceFrame } from "./tracker";
import { checkHead, type HeadCheck, type HeadPos } from "./fixation";

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
const MAX_IMPLICIT = 240;

export class GazeEngine {
  source: "camera" | "mouse" = "mouse";
  /** Where calibration is saved; set per profile so each person keeps their own. */
  storageKey = KEY_CAL;
  private regressor = new GazeRegressor(1.0, 4);
  private filter = new PointFilter(0.8, 0.015);
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
  /** Head position (nose x/y, face height) during calibration, and a smoothed current one. */
  private headRef: HeadPos | null = null;
  private headNow: HeadPos | null = null;
  /** Drift correction from the last quick re-center, added to every estimate (px). */
  private offset = { x: 0, y: 0 };

  constructor() {
    window.addEventListener("mousemove", (e) => {
      if (this.source !== "mouse") return;
      this.emit({ t: performance.now(), x: e.clientX, y: e.clientY, valid: true, blinkL: 0, blinkR: 0, source: "mouse" });
    });
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
    const hp = f.headPos as HeadPos;
    this.headNow = this.headNow ? (this.headNow.map((v, i) => v * 0.85 + hp[i] * 0.15) as HeadPos) : [...hp];
    this.recent.push(f);
    while (this.recent.length && f.t - this.recent[0].t > 1500) this.recent.shift();
    const closed = f.blinkL > 0.45 && f.blinkR > 0.45;
    if (closed || !this.calibrated) {
      // Freeze the cursor while the eyes are closed: iris landmarks are garbage then.
      this.emit({ ...this.last, t: f.t, valid: this.calibrated && this.last.valid, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera" });
      return;
    }
    const p = this.regressor.predict(f.vector);
    const s = this.filter.filter({ x: p.x + this.offset.x, y: p.y + this.offset.y }, f.t);
    const c = clampToView(s.x, s.y, innerWidth, innerHeight);
    this.emit({ t: f.t, x: c.x, y: c.y, valid: true, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera", offscreen: c.offscreen });
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
      .map((f) => this.regressor.predict(f.vector));
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
    const raw = this.regressor.predict(features);
    this.offset = { x: x - raw.x, y: y - raw.y };
    this.filter.reset();
    return Math.hypot(this.offset.x, this.offset.y);
  }

  get driftOffset() {
    return { ...this.offset };
  }

  setCalibration(samples: Sample[], headRef?: HeadPos | null) {
    this.calSamples = samples;
    this.implicit = [];
    this.offset = { x: 0, y: 0 };
    if (headRef !== undefined) this.headRef = headRef;
    this.refit();
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(samples));
      if (this.headRef) localStorage.setItem(`${this.storageKey}.head`, JSON.stringify(this.headRef));
    } catch {
      /* storage full / disabled */
    }
  }

  /** Is the head still roughly where it was during calibration? null if unknown (no face / no reference). */
  headCheck(): HeadCheck | null {
    if (!this.headRef || !this.headNow || !this.faceVisible || this.source !== "camera") return null;
    return checkHead(this.headRef, this.headNow);
  }

  loadSavedCalibration(): boolean {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return false;
      const samples: Sample[] = JSON.parse(raw);
      if (samples[0]?.features.length !== this.recent.at(-1)?.vector.length) return false;
      const head = localStorage.getItem(`${this.storageKey}.head`);
      this.setCalibration(samples, head ? (JSON.parse(head) as HeadPos) : null);
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
    if (all.length >= 8) this.regressor.fit(all);
    this.filter.reset();
  }

  /** Predict without smoothing (used by validation). */
  predictRaw(features: number[]) {
    return this.regressor.predict(features);
  }
}
