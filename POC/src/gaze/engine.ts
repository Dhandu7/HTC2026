// Turns tracker frames (or the mouse, for development) into a smoothed on-screen
// gaze point. Owns calibration data and implicit recalibration.
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
    this.recent.push(f);
    while (this.recent.length && f.t - this.recent[0].t > 1500) this.recent.shift();
    const closed = f.blinkL > 0.45 && f.blinkR > 0.45;
    if (closed || !this.calibrated) {
      // Freeze the cursor while the eyes are closed: iris landmarks are garbage then.
      this.emit({ ...this.last, t: f.t, valid: this.calibrated && this.last.valid, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera" });
      return;
    }
    const p = this.regressor.predict(f.vector);
    const s = this.filter.filter(p, f.t);
    this.emit({ t: f.t, x: s.x, y: s.y, valid: true, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera" });
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

  setCalibration(samples: Sample[]) {
    this.calSamples = samples;
    this.implicit = [];
    this.refit();
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(samples));
    } catch {
      /* storage full / disabled */
    }
  }

  loadSavedCalibration(): boolean {
    try {
      const raw = localStorage.getItem(this.storageKey);
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
    this.implicit.push({ features, x, y, w: 0.6 });
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
