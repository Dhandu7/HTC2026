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
export function headPose(m: ArrayLike<number> | undefined): { yaw: number; pitch: number; roll: number } {
  if (!m || m.length < 16) return { yaw: 0, pitch: 0, roll: 0 };
  return {
    yaw: Math.asin(Math.max(-1, Math.min(1, -m[2]))),
    pitch: Math.atan2(m[6], m[10]),
    roll: Math.atan2(m[1], m[0]),
  };
}

/** Minimum std per feature (same order as `vector`), so near-constant head features can't get huge weights. */
export const STD_FLOOR = [0, 0, 0, 0, 0.04, 0.04, 0, 0.03, 0.03, 0.03];

export interface GazeFeatures {
  /** Vector fed to the regressor. The first 4 entries are the gaze-direction terms. Length 15; eye modes use the first 10. */
  vector: number[];
  blinkL: number;
  blinkR: number;
  /** Mean eyeLookDown blendshape (0..1), for diagnostics. */
  lookDown: number;
  /** Nose x/y and face height (frame fractions) — for head-movement warnings, not regression. */
  headPos: number[];
  /** Mean iris diameter as a fraction of frame width (for distance estimation). */
  irisDiameter: number;
}

export function extractFeatures(
  lm: Pt[],
  blend: Blendshapes,
  matrix: ArrayLike<number> | undefined,
  frameAspect: number,
): GazeFeatures {
  const L = irisInEye(lm, LM.leftEye, frameAspect);
  const R = irisInEye(lm, LM.rightEye, frameAspect);
  const pose = headPose(matrix);
  const g = (k: string) => blend[k] ?? 0;
  // Horizontal: toward the subject's left is +; vertical: up is +.
  const lookH = (g("eyeLookOutLeft") - g("eyeLookInLeft") + g("eyeLookInRight") - g("eyeLookOutRight")) / 2;
  const lookV = (g("eyeLookUpLeft") + g("eyeLookUpRight") - g("eyeLookDownLeft") - g("eyeLookDownRight")) / 2;
  // The inner-corner direction is opposite for the two eyes, so mirror the right eye's x.
  const irisX = (L.x + (1 - R.x)) / 2;
  const irisY = (L.y - R.y) / 2;
  const nose = lm[LM.noseTip];
  // Extra head geometry (used by head-pointer mode): where the nose sits relative to the eyes, and the eye midpoint.
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
    // Head translation/scale (nose x, nose y, face height as frame fractions) ARE regressor inputs, as the
    // last 3 entries. They barely vary during the dot calibration, so z-scoring alone gave them huge weights
    // (a 10.6 deg first run). Two guards: the regressor floors their std (see HEAD_STD_FLOOR), and calibration
    // adds a "look at a fixed dot while moving your head" phase so the model actually sees head movement.
    vector: [irisX, irisY, lookH, lookV, pose.yaw, pose.pitch, (L.openness + R.openness) / 2, nose.x, nose.y, faceH,
      // Indices 10..14: roll, nose-vs-eyes geometry (x, y), eye midpoint (x, y). Only head-pointer mode uses these.
      pose.roll, ((nose.x - eyeMidX) * frameAspect) / eyeDist, (nose.y - eyeMidY) / eyeDist, eyeMidX, eyeMidY],
    headPos: [nose.x, nose.y, faceH],
    // Looking down lowers the eyelids, which raises the raw blink score without a blink. Subtract the
    // look-down part so downward gaze isn't mistaken for a blink (that froze the cursor on the bottom row).
    blinkL: Math.max(0, g("eyeBlinkLeft") - 0.6 * g("eyeLookDownLeft")),
    blinkR: Math.max(0, g("eyeBlinkRight") - 0.6 * g("eyeLookDownRight")),
    lookDown: (g("eyeLookDownLeft") + g("eyeLookDownRight")) / 2,
    irisDiameter,
  };
}
