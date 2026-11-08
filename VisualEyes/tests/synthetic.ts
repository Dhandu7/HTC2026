// Synthetic recorded sessions for tests: landmarks driven by a known gaze mapping.
import { LM } from "../src/gaze/features";
import { SESSION_FORMAT, buildProtocol, f32ToB64, type ProtocolMode, type RecordedFrame, type RecordedSession } from "../src/record/format";

// ---------- synthetic sessions: landmarks driven by a known gaze mapping ----------

function fakeLandmarks(gx: number, gy: number, offX: number, offY = 0): Float32Array {
  const lm = new Float32Array(478 * 3).fill(0.5);
  const set = (i: number, x: number, y: number) => {
    lm[i * 3] = x + offX;
    lm[i * 3 + 1] = y + offY;
    lm[i * 3 + 2] = 0;
  };
  // gx, gy in [-1, 1]: iris moves within each eye.
  const eye = (e: typeof LM.leftEye | typeof LM.rightEye, cx: number, outerLeft: boolean) => {
    const w = 0.06;
    set(e.outer, outerLeft ? cx - w / 2 : cx + w / 2, 0.45);
    set(e.inner, outerLeft ? cx + w / 2 : cx - w / 2, 0.45);
    set(e.top, cx, 0.44);
    set(e.bottom, cx, 0.46);
    const ix = cx + gx * 0.012;
    const iy = 0.45 + gy * 0.004;
    set(e.iris, ix, iy);
    const r = 0.006;
    set(e.irisRing[0], ix + r, iy);
    set(e.irisRing[1], ix, iy - r);
    set(e.irisRing[2], ix - r, iy);
    set(e.irisRing[3], ix, iy + r);
  };
  eye(LM.leftEye, 0.43, true);
  eye(LM.rightEye, 0.57, false);
  set(LM.noseTip, 0.5, 0.52);
  set(LM.forehead, 0.5, 0.3);
  set(LM.chin, 0.5, 0.7);
  return lm;
}

const BLEND = ["eyeBlinkLeft", "eyeBlinkRight", "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight"];

/**
 * pointer "eye": the eyes rotate toward each dot, face still. pointer "pointer": the whole face
 * shifts toward each dot, eyes centred; check dots last 3.6 s so the 2 s dwell fits.
 */
export function fakeSession(participant: string, mode: ProtocolMode, person: { gain: number; bias: number }, seed = 1, pointer: "eye" | "pointer" = "eye"): RecordedSession {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const protocol = buildProtocol(mode, rnd);
  const vw = 1500;
  const vh = 900;
  const frames: RecordedFrame[] = [];
  let t0 = 0;
  const targets = protocol.map((p, ti) => {
    const nFrames = pointer === "pointer" && p.segment !== "cal" ? 110 : 20;
    const tShown = t0;
    t0 += nFrames * 33 + 200;
    for (let k = 0; k < nFrames; k++) {
      // Person-specific mapping from target to eye rotation, plus a little noise.
      const gx = (p.fx - 0.5) * 2 * person.gain + person.bias + (rnd() - 0.5) * 0.02;
      const gy = (0.5 - p.fy) * 2 * person.gain + (rnd() - 0.5) * 0.02;
      const bs = Float32Array.from([0.05, 0.05, Math.max(0, gy) * 0.5, Math.max(0, gy) * 0.5, Math.max(0, -gy) * 0.5, Math.max(0, -gy) * 0.5]);
      const lm = pointer === "pointer" ? fakeLandmarks(0, 0, gx * 0.05, -gy * 0.05) : fakeLandmarks(gx, gy, 0);
      frames.push({ t: tShown + k * 33, ti, c: k >= 4, lm: f32ToB64(lm), bs: f32ToB64(bs), m: null, inferMs: 5 });
    }
    return { ...p, x: p.fx * vw, y: p.fy * vh, vw, vh, tShown, tCollect0: tShown + 132, tCollect1: tShown + (nFrames - 1) * 33 };
  });
  return {
    format: SESSION_FORMAT,
    createdAt: "2026-11-07T00:00:00Z",
    meta: { participant, pointer, glasses: false, lighting: "synthetic", notes: "", mode, distanceCm: 60, screenDiagonalIn: 14, hfovDeg: 60 },
    env: { userAgent: "test", camera: "fake", videoWidth: 1280, videoHeight: 720, screenWidth: 1512, screenHeight: 982, devicePixelRatio: 2 },
    blendNames: BLEND,
    targets,
    frames,
    videoTimeline: null,
  };
}

