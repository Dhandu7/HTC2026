// Turns tracker frames (or the mouse, for development) into a smoothed on-screen
// gaze point. Owns calibration data and implicit recalibration.
import { GazeRegressor, chooseLambda, type Sample } from "./regression";
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
const KEY_CAL_NOSE = "gazetype.calibration.nose.v1";
// Nose-pointer feature order: yaw, pitch, noseX, noseY, noseRelX, noseRelY, roll, faceH, eyeMidX, eyeMidY.
// The floors stop a near-constant feature from getting a huge weight after z-scoring.
const NOSE_FLOOR = [0.02, 0.02, 0.01, 0.01, 0.02, 0.02, 0.02, 0.01, 0.01, 0.01];
const MAX_IMPLICIT = 240;

export class GazeEngine {
  source: "camera" | "mouse" = "mouse";
  /** Where calibration is saved; set per profile so each person keeps their own. */
  storageKey = KEY_CAL;
  /** Head-pointer calibrations use different features, so they are stored separately. */
  private get calKey() {
    if (!this.noseMode) return this.storageKey;
    return this.storageKey === KEY_CAL ? KEY_CAL_NOSE : `${this.storageKey}.nose`;
  }
  private regressor = new GazeRegressor(1.0, 4);
  private filter = new PointFilter(0.8, 0.015);
  private noseMode = false;
  // Nose pointer only: ignore wobble smaller than this many px, and trail the true point by that much when moving.
  private anchor: { x: number; y: number } | null = null;
  private stillRadiusPx = 10;

  /** Head/nose pointer: 10 head features, no blink freeze, light smoothing, cursor kept on screen. Call before calibrating. */
  configureNose() {
    this.noseMode = true;
    this.regressor = new GazeRegressor(1.0, 4, NOSE_FLOOR);
    this.filter = new PointFilter(1.0, 0.01);
    this.anchor = null;
  }

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
  /** Head position (nose x/y, face height) during calibration, and a smoothed current one. */
  private headRef: HeadPos | null = null;
  private headNow: HeadPos | null = null;
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
    this.dbg.frame = f;
    while (this.recent.length && f.t - this.recent[0].t > 1500) this.recent.shift();
    // The nose pointer doesn't use the eyes, so a blink must not freeze it.
    const closed = !this.noseMode && f.blinkL > 0.45 && f.blinkR > 0.45;
    if (closed || !this.calibrated) {
      // Freeze the cursor while the eyes are closed: iris landmarks are garbage then.
      this.emit({ ...this.last, t: f.t, valid: this.calibrated && this.last.valid, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera" });
      return;
    }
    const p = this.regressor.predict(f.vector);
    this.dbg.raw = p;
    // Drift correction from the last quick re-center.
    const q = { x: p.x + this.offset.x, y: p.y + this.offset.y };
    if (this.noseMode) {
      // Pointing far off the screen: hold the last point and mark it invalid so nothing is selected.
      const OFF = 300;
      if (q.x < -OFF || q.x > innerWidth + OFF || q.y < -OFF || q.y > innerHeight + OFF) {
        this.emit({ ...this.last, t: f.t, valid: false, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera", offscreen: true });
        return;
      }
      const n = this.leash(this.clamp(this.filter.filter(q, f.t)));
      this.emit({ t: f.t, x: n.x, y: n.y, valid: true, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera" });
      return;
    }
    const s = this.filter.filter(q, f.t);
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
    // Nose pointer: choose the ridge strength by leave-one-dot-out cross-validation instead of a fixed guess.
    if (this.noseMode) {
      const cv = chooseLambda(samples, 4, NOSE_FLOOR);
      if (Number.isFinite(cv.medianErrPx)) this.regressor.lambda = cv.lambda;
    }
    this.refit();
    try {
      localStorage.setItem(this.calKey, JSON.stringify(samples));
      if (this.headRef) localStorage.setItem(`${this.calKey}.head`, JSON.stringify(this.headRef));
    } catch {
      /* storage full / disabled */
    }
  }

  /** Is the head still roughly where it was during calibration? null if unknown (no face / no reference). */
  headCheck(): HeadCheck | null {
    // The head pointer moves the head on purpose, so "head moved since calibration" means nothing there.
    if (this.noseMode || !this.headRef || !this.headNow || !this.faceVisible || this.source !== "camera") return null;
    return checkHead(this.headRef, this.headNow);
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
      const head = localStorage.getItem(`${this.calKey}.head`);
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
    this.anchor = null;
  }

  /** Predict without smoothing (used by validation). */
  predictRaw(features: number[]) {
    return this.regressor.predict(features);
  }
}
