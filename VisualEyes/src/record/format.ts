// Recorded-session file format and the recording protocol. Pure (no DOM, no
// MediaPipe) so the browser recorder and the Node replay script share it.
import { extractFeatures, type GazeFeatures, type Pt } from "../gaze/features";

export const SESSION_FORMAT = "gazetype.session.v1";

/** Which part of the protocol a target belongs to. */
export type SegmentKind = "cal" | "val" | "drift";

export interface ProtocolTarget {
  segment: SegmentKind;
  /** Drift checks: minutes after the end of validation. 0 for cal/val. */
  atMin: number;
  /** Position as a fraction of the viewport. */
  fx: number;
  fy: number;
}

// 5x5 calibration grid. It contains the app's 9 calibration points
// (x 0.08/0.5/0.92, y 0.1/0.5/0.9), so replay can also simulate the app's 9-point protocol.
export const GRID_X = [0.08, 0.29, 0.5, 0.71, 0.92];
export const GRID_Y = [0.1, 0.3, 0.5, 0.7, 0.9];
export const APP_9 = new Set(["0.08,0.1", "0.5,0.1", "0.92,0.1", "0.08,0.5", "0.5,0.5", "0.92,0.5", "0.08,0.9", "0.5,0.9", "0.92,0.9"]);
export const CORNERS_5 = new Set(["0.08,0.1", "0.92,0.1", "0.5,0.5", "0.08,0.9", "0.92,0.9"]);
// Validation points sit midway between grid lines, so none coincides with a calibration point.
export const VAL_X = [0.185, 0.395, 0.605, 0.815];
export const VAL_Y = [0.2, 0.4, 0.6, 0.8];
/** Drift re-checks (minutes after validation ends) in the full protocol. */
export const DRIFT_MIN = [2, 5, 10];

export const SETTLE_MS = 800;
export const COLLECT_MS = 1500;

export type ProtocolMode = "full" | "short";

const key = (fx: number, fy: number) => `${fx},${fy}`;
export const pointKey = key;

function shuffled<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Targets in display order. Full: 25-point grid, 16 validation points, then the 16
 * validation points again at each drift check. Short (strangers, ~1 min): the app's
 * 9 points plus the 16 validation points.
 */
export function buildProtocol(mode: ProtocolMode, rnd: () => number = Math.random): ProtocolTarget[] {
  const grid = GRID_Y.flatMap((fy) => GRID_X.map((fx) => ({ fx, fy })));
  const cal = mode === "full" ? grid : grid.filter((p) => APP_9.has(key(p.fx, p.fy)));
  const val = VAL_Y.flatMap((fy) => VAL_X.map((fx) => ({ fx, fy })));
  const out: ProtocolTarget[] = [
    ...shuffled(cal, rnd).map((p) => ({ segment: "cal" as const, atMin: 0, ...p })),
    ...shuffled(val, rnd).map((p) => ({ segment: "val" as const, atMin: 0, ...p })),
  ];
  if (mode === "full")
    for (const m of DRIFT_MIN) out.push(...shuffled(val, rnd).map((p) => ({ segment: "drift" as const, atMin: m, ...p })));
  return out;
}

export interface SessionMeta {
  participant: string;
  glasses: boolean;
  lighting: string;
  notes: string;
  mode: ProtocolMode;
  /** Measured eye-to-screen distance in cm, 0 if not measured. */
  distanceCm: number;
  screenDiagonalIn: number;
  hfovDeg: number;
}

export interface RecordedTarget extends ProtocolTarget {
  /** Position in CSS px at display time, and the viewport size then. */
  x: number;
  y: number;
  vw: number;
  vh: number;
  /** performance.now() when the dot appeared and when collection started/ended. */
  tShown: number;
  tCollect0: number;
  tCollect1: number;
}

export interface RecordedFrame {
  t: number;
  /** Index into targets. */
  ti: number;
  /** True inside the collection window, false while the dot settles. */
  c: boolean;
  /** base64 Float32 landmarks (478*3), or null when no face was found. */
  lm: string | null;
  /** base64 Float32 blendshape scores in header.blendNames order. */
  bs: string | null;
  m: number[] | null;
  inferMs: number;
}

export interface RecordedSession {
  format: typeof SESSION_FORMAT;
  createdAt: string;
  meta: SessionMeta;
  env: {
    userAgent: string;
    camera: string;
    videoWidth: number;
    videoHeight: number;
    screenWidth: number;
    screenHeight: number;
    devicePixelRatio: number;
  };
  blendNames: string[];
  targets: RecordedTarget[];
  frames: RecordedFrame[];
  /** Wall-clock intervals (performance.now) covered by the local video, in order; null if no video. */
  videoTimeline: { t0: number; t1: number }[] | null;
}

// ---- base64 <-> Float32Array (btoa/atob exist in browsers and in Node) ----

export function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToF32(b64: string): Float32Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Video time (s) for a wall-clock time, given the recorded intervals. NaN if not covered. */
export function videoTimeAt(timeline: { t0: number; t1: number }[], t: number): number {
  let acc = 0;
  for (const seg of timeline) {
    if (t >= seg.t0 && t <= seg.t1) return (acc + t - seg.t0) / 1000;
    acc += seg.t1 - seg.t0;
  }
  return NaN;
}

/** Re-run the app's feature extraction on a recorded frame (null if no face). */
export function frameFeatures(s: RecordedSession, f: RecordedFrame): GazeFeatures | null {
  if (!f.lm) return null;
  const flat = b64ToF32(f.lm);
  const lm: Pt[] = [];
  for (let i = 0; i < flat.length; i += 3) lm.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] });
  const blend: Record<string, number> = {};
  if (f.bs) {
    const bs = b64ToF32(f.bs);
    s.blendNames.forEach((n, i) => (blend[n] = bs[i]));
  }
  return extractFeatures(lm, blend, f.m ?? undefined, s.env.videoWidth / s.env.videoHeight);
}
