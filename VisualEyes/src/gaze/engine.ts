// Turns tracker frames (or the mouse, for development) into a smoothed on-screen
// gaze point. Owns calibration data and implicit recalibration.
import { GazeRegressor, type Sample } from "./regression";
import { KernelGazeRegressor } from "./kernel";
import { kernelInput } from "./features";

export type GazeModel = "kernel" | "ridge";

/**
 * Kernel ridge (RBF, γ=0.03, λ=1) is the default: in dwell simulation on recorded sessions
 * (VisualEyes/recordings, `npm run replay`) it selected the right 6-chip button more often than
 * the quadratic ridge on every session (mean 77% vs 69%).
 */
function makeRegressor(model: GazeModel) {
  return model === "kernel" ? new KernelGazeRegressor(1, 0.03, 400) : new GazeRegressor(1.0, 4);
}
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
   * 0..1 trust in this point. Drops when the face is lost or the head has moved far from
   * where it was during calibration (position, distance or rotation). Mouse = 1.
   */
  confidence: number;
  /**
   * The estimate fell off the screen (x/y are then pinned to the nearest edge). Nothing should
   * be selected from such a point: it would land on an edge key the user isn't looking at.
   * (From Adeeb's LLM-and-text-modelling branch.)
   */
  offscreen?: boolean;
}

/** How far past the screen edge (px) the estimate may go before it counts as off-screen. */
const OFFSCREEN_MARGIN = 40;

/** Pin a point to the visible area and say whether it was outside it. */
export function clampToView(x: number, y: number, w: number, h: number, margin = OFFSCREEN_MARGIN) {
  const offscreen = x < -margin || y < -margin || x > w + margin || y > h + margin;
  return { x: Math.min(w, Math.max(0, x)), y: Math.min(h, Math.max(0, y)), offscreen };
}

/**
 * What to tell the user when they've moved away from the calibration pose, in their terms
 * (wording from Adeeb's branch). The camera image isn't mirrored: the user's left is the
 * image's right (larger x), and a lower head is larger y.
 */
export function postureAdvice(p: PoseRef, ref: PoseRef): string | null {
  const shiftX = (p.noseX - ref.noseX) / ref.faceH / 0.3;
  const shiftY = (p.noseY - ref.noseY) / ref.faceH / 0.3;
  const scale = Math.log(p.faceH / ref.faceH) / 0.25;
  const rot = Math.hypot(p.yaw - ref.yaw, p.pitch - ref.pitch) / 0.3;
  const worst = Math.max(Math.abs(shiftX), Math.abs(shiftY), Math.abs(scale), rot);
  if (worst < 1) return null;
  if (worst === Math.abs(scale)) return scale > 0 ? "Move back a little" : "Move a little closer";
  if (worst === Math.abs(shiftX)) return shiftX > 0 ? "Move a little to your right" : "Move a little to your left";
  if (worst === Math.abs(shiftY)) return shiftY > 0 ? "Raise your head a little" : "Lower your head a little";
  return "Turn your head back toward the screen";
}

/** Head pose summary: nose x/y and face height (frame fractions), yaw/pitch (rad). */
export interface PoseRef {
  noseX: number;
  noseY: number;
  faceH: number;
  yaw: number;
  pitch: number;
}

export function poseOf(f: { headPos: number[]; vector: number[] }): PoseRef {
  // vector = [irisX, irisY, lookH, lookV, yaw, pitch, openness]; headPos = [noseX, noseY, faceH]
  return { noseX: f.headPos[0], noseY: f.headPos[1], faceH: f.headPos[2], yaw: f.vector[4], pitch: f.vector[5] };
}

export function medianPose(frames: { headPos: number[]; vector: number[] }[]): PoseRef | null {
  if (!frames.length) return null;
  const ps = frames.map(poseOf);
  const med = (k: keyof PoseRef) => {
    const v = ps.map((p) => p[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return { noseX: med("noseX"), noseY: med("noseY"), faceH: med("faceH"), yaw: med("yaw"), pitch: med("pitch") };
}

/**
 * How far a pose is from the calibration pose, in "tolerances" (1 = at the edge of what we
 * expect calibration to cover): 0.3 face-heights of sideways/vertical shift, a 25% change
 * in distance, or ~17° of rotation. Tuned loosely on two recorded sessions, where ordinary
 * settling after calibration (mostly leaning back ~12%) reached about 0.5 on this scale.
 */
export function poseDeviation(p: PoseRef, ref: PoseRef): number {
  const shift = Math.hypot(p.noseX - ref.noseX, p.noseY - ref.noseY) / ref.faceH;
  const scale = Math.abs(Math.log(p.faceH / ref.faceH));
  const rot = Math.hypot(p.yaw - ref.yaw, p.pitch - ref.pitch);
  return Math.max(shift / 0.3, scale / 0.25, rot / 0.3);
}

/** Full confidence up to half a tolerance, falling to 0 at 1.5 tolerances. */
export function confidenceFromDeviation(d: number): number {
  return Math.max(0, Math.min(1, 1.5 - d));
}

const KEY_CAL = "gazetype.calibration.v1";
const MAX_IMPLICIT = 240;

export class GazeEngine {
  source: "camera" | "mouse" = "mouse";
  private regressor: GazeRegressor | KernelGazeRegressor = makeRegressor("kernel");
  private model: GazeModel = "kernel";

  /** Switch the gaze model; refits on the current calibration if there is one. */
  setModel(model: GazeModel) {
    if (model === this.model) return;
    this.model = model;
    this.regressor = makeRegressor(model);
    this.refit();
  }
  private filter = new PointFilter(0.8, 0.015);
  private calSamples: Sample[] = [];
  private implicit: Sample[] = [];
  private recent: FaceFrame[] = [];
  private last: GazePoint = { t: 0, x: NaN, y: NaN, valid: false, blinkL: 0, blinkR: 0, source: "mouse", confidence: 0 };
  /** Median head pose during calibration. */
  private poseRef: PoseRef | null = null;
  /** Smoothed current pose deviation (tolerances). */
  poseDeviation = 0;
  /** Smoothed current pose, for posture advice. */
  private poseNow: PoseRef | null = null;

  /** Advice to get back to the calibration pose, or null if it's fine / unknown. */
  postureAdvice(): string | null {
    return this.poseRef && this.poseNow ? postureAdvice(this.poseNow, this.poseRef) : null;
  }
  private listeners = new Set<(g: GazePoint) => void>();
  private rawListeners = new Set<(f: FaceFrame | null) => void>();
  /** Smoothed iris diameter (fraction of frame width), for distance estimation. */
  irisDiameter = NaN;
  faceVisible = false;
  inferMs = 0;

  constructor() {
    window.addEventListener("mousemove", (e) => {
      if (this.source !== "mouse") return;
      this.emit({ t: performance.now(), x: e.clientX, y: e.clientY, valid: true, blinkL: 0, blinkR: 0, source: "mouse", confidence: 1 });
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
      this.emit({ ...this.last, t: performance.now(), valid: false, confidence: 0 });
      return;
    }
    this.inferMs = this.inferMs * 0.9 + f.inferMs * 0.1;
    this.irisDiameter = Number.isFinite(this.irisDiameter) ? this.irisDiameter * 0.95 + f.irisDiameter * 0.05 : f.irisDiameter;
    this.recent.push(f);
    while (this.recent.length && f.t - this.recent[0].t > 1500) this.recent.shift();
    const closed = f.blinkL > 0.45 && f.blinkR > 0.45;
    if (this.poseRef && !closed) {
      const pose = poseOf(f);
      const d = poseDeviation(pose, this.poseRef);
      this.poseDeviation = this.poseDeviation * 0.9 + d * 0.1;
      const prev = this.poseNow;
      this.poseNow = prev
        ? { noseX: prev.noseX * 0.9 + pose.noseX * 0.1, noseY: prev.noseY * 0.9 + pose.noseY * 0.1, faceH: prev.faceH * 0.9 + pose.faceH * 0.1, yaw: prev.yaw * 0.9 + pose.yaw * 0.1, pitch: prev.pitch * 0.9 + pose.pitch * 0.1 }
        : pose;
    }
    if (closed || !this.calibrated) {
      // Freeze the cursor while the eyes are closed: iris landmarks are garbage then.
      this.emit({ ...this.last, t: f.t, valid: this.calibrated && this.last.valid, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera" });
      return;
    }
    const p = this.predictRaw(f.vector);
    const s = this.filter.filter(p, f.t);
    const c = clampToView(s.x, s.y, innerWidth, innerHeight);
    const confidence = this.poseRef ? confidenceFromDeviation(this.poseDeviation) : 1;
    this.emit({ t: f.t, x: c.x, y: c.y, valid: true, blinkL: f.blinkL, blinkR: f.blinkR, source: "camera", confidence, offscreen: c.offscreen });
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

  setCalibration(samples: Sample[], poseFrames?: { headPos: number[]; vector: number[] }[], poseRef?: PoseRef | null) {
    this.calSamples = samples;
    this.implicit = [];
    this.poseRef = poseRef ?? (poseFrames ? medianPose(poseFrames) : null);
    this.poseDeviation = 0;
    this.poseNow = null;
    this.refit();
    try {
      localStorage.setItem(KEY_CAL, JSON.stringify({ samples, poseRef: this.poseRef }));
    } catch {
      /* storage full / disabled */
    }
  }

  loadSavedCalibration(): boolean {
    try {
      const raw = localStorage.getItem(KEY_CAL);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      // v1 stored a bare sample array; now { samples, poseRef }.
      const samples: Sample[] = Array.isArray(saved) ? saved : saved.samples;
      if (samples[0]?.features.length !== this.recent.at(-1)?.vector.length) return false;
      this.setCalibration(samples, undefined, Array.isArray(saved) ? null : saved.poseRef);
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
    if (all.length >= 8) this.regressor.fit(this.model === "kernel" ? all.map((s) => ({ ...s, features: kernelInput(s.features) })) : all);
    this.filter.reset();
  }

  /** Predict without smoothing (used by validation). */
  predictRaw(features: number[]) {
    return this.regressor.predict(this.model === "kernel" ? kernelInput(features) : features);
  }
}
