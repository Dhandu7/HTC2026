// Pure feature extraction from MediaPipe Face Landmarker output.
// Kept free of MediaPipe imports so it is unit-testable.

export interface Pt {
  x: number;
  y: number;
  z?: number;
}

export type Blendshapes = Record<string, number>;

// Landmark indices (MediaPipe 478-point mesh, subject's left/right).
export const LM = {
  leftEye: { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468, irisRing: [469, 470, 471, 472] },
  rightEye: { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473, irisRing: [474, 475, 476, 477] },
  noseTip: 1,
  forehead: 10,
  chin: 152,
} as const;

/** Iris centre relative to the eye: x along the corner-to-corner axis (0..1), y perpendicular, both in eye-widths. */
export function irisInEye(
  lm: Pt[],
  eye: { outer: number; inner: number; top: number; bottom: number; iris: number },
  aspect: number,
): { x: number; y: number; openness: number } {
  const a = { x: lm[eye.outer].x * aspect, y: lm[eye.outer].y };
  const b = { x: lm[eye.inner].x * aspect, y: lm[eye.inner].y };
  const i = { x: lm[eye.iris].x * aspect, y: lm[eye.iris].y };
  const ax = b.x - a.x;
  const ay = b.y - a.y;
  const w = Math.hypot(ax, ay) || 1e-6;
  const ux = ax / w;
  const uy = ay / w;
  const rx = i.x - a.x;
  const ry = i.y - a.y;
  const along = (rx * ux + ry * uy) / w;
  // Perpendicular offset relative to the corner midline.
  const perp = (-rx * uy + ry * ux) / w;
  const top = lm[eye.top];
  const bottom = lm[eye.bottom];
  const openness = Math.hypot((top.x - bottom.x) * aspect, top.y - bottom.y) / w;
  return { x: along, y: perp, openness };
}

/** Yaw/pitch/roll (radians) from MediaPipe's column-major 4x4 facial transformation matrix. */
export function facePose(m: ArrayLike<number> | undefined): { yaw: number; pitch: number; roll: number } {
  if (!m || m.length < 16) return { yaw: 0, pitch: 0, roll: 0 };
  return {
    yaw: Math.asin(Math.max(-1, Math.min(1, -m[2]))),
    pitch: Math.atan2(m[6], m[10]),
    roll: Math.atan2(m[1], m[0]),
  };
}

/** Minimum std per feature (same order as `vector`), so near-constant position features can't get huge weights. */
export const STD_FLOOR = [0, 0, 0, 0, 0.04, 0.04, 0, 0.03, 0.03, 0.03];

export interface GazeFeatures {
  /** Full feature vector (length 15, layout kept for recordings). Entries 0–3 and 6 are eye features the pointer ignores; pointerVector() picks the pointer inputs. */
  vector: number[];
  blinkL: number;
  blinkR: number;
  /** Mean eyeLookDown blendshape (0..1), for diagnostics. */
  lookDown: number;
  /** Face x/y and face height (frame fractions) — for seating-position warnings, not regression. */
  facePos: number[];
  /** Mean iris diameter as a fraction of frame width (for distance estimation). */
  irisDiameter: number;
}

/**
 * Pointer-tracker inputs, picked from the 15-entry `vector`: yaw, pitch, tipX, tipY, tipRelX,
 * tipRelY, roll, faceH, eyeMidX, eyeMidY. Shared by the app and the offline replay so both
 * feed the pointer model exactly the same thing.
 */
export const POINTER_INDEX = [4, 5, 7, 8, 11, 12, 10, 9, 13, 14] as const;
export const POINTER_FEATURE_NAMES = ["yaw", "pitch", "tipX", "tipY", "tipRelX", "tipRelY", "roll", "faceH", "eyeMidX", "eyeMidY"];
export const pointerVector = (v: number[]) => POINTER_INDEX.map((i) => v[i]);

export function extractFeatures(
  lm: Pt[],
  blend: Blendshapes,
  matrix: ArrayLike<number> | undefined,
  frameAspect: number,
): GazeFeatures {
  const L = irisInEye(lm, LM.leftEye, frameAspect);
  const R = irisInEye(lm, LM.rightEye, frameAspect);
  const pose = facePose(matrix);
  const g = (k: string) => blend[k] ?? 0;
  // Horizontal: toward the subject's left is +; vertical: up is +.
  const lookH = (g("eyeLookOutLeft") - g("eyeLookInLeft") + g("eyeLookInRight") - g("eyeLookOutRight")) / 2;
  const lookV = (g("eyeLookUpLeft") + g("eyeLookUpRight") - g("eyeLookDownLeft") - g("eyeLookDownRight")) / 2;
  // The inner-corner direction is opposite for the two eyes, so mirror the right eye's x.
  const irisX = (L.x + (1 - R.x)) / 2;
  const irisY = (L.y - R.y) / 2;
  const tip = lm[LM.noseTip];
  // Extra face geometry (used by pointer-tracker mode): where the face centre sits relative to the eyes, and the eye midpoint.
  const eyeMidX = (lm[LM.leftEye.outer].x + lm[LM.rightEye.outer].x) / 2;
  const eyeMidY = (lm[LM.leftEye.outer].y + lm[LM.rightEye.outer].y) / 2;
  const eyeDist = Math.hypot((lm[LM.rightEye.outer].x - lm[LM.leftEye.outer].x) * frameAspect, lm[LM.rightEye.outer].y - lm[LM.leftEye.outer].y) || 1e-6;
  const faceH = Math.abs(lm[LM.chin].y - lm[LM.forehead].y) || 1e-6;
  const ringDiam = (ring: readonly number[]) =>
    (Math.hypot((lm[ring[0]].x - lm[ring[2]].x) * frameAspect, lm[ring[0]].y - lm[ring[2]].y) +
      Math.hypot((lm[ring[1]].x - lm[ring[3]].x) * frameAspect, lm[ring[1]].y - lm[ring[3]].y)) /
    2;
  const irisDiameter = (ringDiam(LM.leftEye.irisRing) + ringDiam(LM.rightEye.irisRing)) / 2 / frameAspect;
  return {
    // Face translation/scale (face x, face y, face height as frame fractions) ARE regressor inputs, as the
    // last 3 entries. They barely vary during the dot calibration, so z-scoring alone gave them huge weights
    // (a 10.6 deg first run). Two guards: the regressor floors their std (see POS_STD_FLOOR), and calibration
    // adds a "look at a fixed dot while moving" phase so the model actually sees that movement.
    vector: [irisX, irisY, lookH, lookV, pose.yaw, pose.pitch, (L.openness + R.openness) / 2, tip.x, tip.y, faceH,
      // Indices 10..14: roll, centre-vs-eyes geometry (x, y), eye midpoint (x, y). Only pointer-tracker mode uses these.
      pose.roll, ((tip.x - eyeMidX) * frameAspect) / eyeDist, (tip.y - eyeMidY) / eyeDist, eyeMidX, eyeMidY],
    facePos: [tip.x, tip.y, faceH],
    // Looking down lowers the eyelids, which raises the raw blink score without a blink. Subtract the
    // look-down part so downward gaze isn't mistaken for a blink (that froze the cursor on the bottom row).
    blinkL: Math.max(0, g("eyeBlinkLeft") - 0.6 * g("eyeLookDownLeft")),
    blinkR: Math.max(0, g("eyeBlinkRight") - 0.6 * g("eyeLookDownRight")),
    lookDown: (g("eyeLookDownLeft") + g("eyeLookDownRight")) / 2,
    irisDiameter,
  };
}
