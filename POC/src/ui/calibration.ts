// Grid calibration (25 points by default, ~1 min) + 4-point validation. Validation
// reports accuracy in degrees (with the assumptions shown) and, because the viewing
// distance is unknown in a demo, the distance-free hit rate for 6-chip / 16-grid layouts.
//
// Recorded sessions (POC/recordings, `npm run replay`) showed 25 points is the only
// change that helped on every session: worst-session 6-chip hit rate 61-71% vs 37-44%
// with 9 points.
import type { GazeEngine } from "../gaze/engine";
import type { Sample } from "../gaze/regression";
import { summarizeErrors, type ErrorStats, type ViewingGeometry } from "../gaze/accuracy";
import { evaluate } from "../eval/metrics";
import type { FaceFrame } from "../gaze/tracker";
import type { SegmentKind } from "../record/format";
import type { SessionTape } from "../record/tape";

export type CalibrationSize = 9 | 13 | 25;

const GRID_X = [0.08, 0.29, 0.5, 0.71, 0.92];
const GRID_Y = [0.1, 0.3, 0.5, 0.7, 0.9];
const GRID_25: [number, number][] = GRID_Y.flatMap((y) => GRID_X.map((x) => [x, y] as [number, number]));
const IS_9 = (x: number, y: number) => [0.08, 0.5, 0.92].includes(x) && [0.1, 0.5, 0.9].includes(y);
const IS_INNER_4 = (x: number, y: number) => [0.29, 0.71].includes(x) && [0.3, 0.7].includes(y);

export function calibrationPoints(size: CalibrationSize): [number, number][] {
  if (size === 25) return GRID_25;
  return GRID_25.filter(([x, y]) => IS_9(x, y) || (size === 13 && IS_INNER_4(x, y)));
}

const VAL_POINTS: [number, number][] = [
  [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7],
];
// Settle raised from 650 ms: the eyes and head are still moving onto the dot early on.
const SETTLE_MS = 1000;
const COLLECT_MS = 900;

export interface CalibrationResult extends ErrorStats {
  /** Share of validation frames inside a cell-sized box around the target. Distance-independent. */
  hit6: number;
  hit16: number;
  points: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shuffle so the order doesn't sweep the screen (which invites head-turning along with it). */
function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Collect frames while the user looks at one dot. */
export function dotRunner(engine: GazeEngine, root: HTMLElement, tape?: SessionTape) {
  const dot = root.querySelector<HTMLDivElement>(".cal-dot")!;
  let frames: FaceFrame[] = [];
  let collecting = false;
  const off = engine.onRaw((f) => {
    if (collecting && f && !(f.blinkL > 0.45 && f.blinkR > 0.45)) frames.push(f);
  });
  const collectAt = async (p: [number, number], segment: SegmentKind = "cal", settleMs = SETTLE_MS, collectMs = COLLECT_MS) => {
    tape?.show(segment, p[0], p[1]);
    dot.style.left = `${p[0] * innerWidth}px`;
    dot.style.top = `${p[1] * innerHeight}px`;
    dot.classList.remove("collect");
    void dot.offsetWidth;
    dot.style.animationDuration = `${(settleMs + collectMs) / 1000}s`;
    dot.classList.add("collect");
    await sleep(settleMs);
    frames = [];
    collecting = true;
    tape?.collectStart();
    await sleep(collectMs);
    collecting = false;
    tape?.collectEnd();
    return frames;
  };
  return { collectAt, off };
}

export async function runCalibration(
  engine: GazeEngine,
  root: HTMLElement,
  geometry: () => ViewingGeometry,
  size: CalibrationSize = 25,
  tape?: SessionTape,
): Promise<CalibrationResult | null> {
  // No "keep still" demand: demo users won't. Calibrating in their natural posture lets
  // the model see the head movement it will meet later.
  root.innerHTML = `<div class="cal-msg">Follow each dot with your eyes until it disappears. Sit however is comfortable.</div><div class="cal-dot"></div>`;
  root.hidden = false;
  const msg = root.querySelector<HTMLDivElement>(".cal-msg")!;
  const { collectAt, off } = dotRunner(engine, root, tape);
  let cancelled = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancelled = true;
  };
  window.addEventListener("keydown", onKey);

  try {
    await sleep(1200);
    msg.textContent = "";
    const samples: Sample[] = [];
    const poseFrames: FaceFrame[] = [];
    for (const p of shuffled(calibrationPoints(size))) {
      if (cancelled) return null;
      const fs = await collectAt(p);
      poseFrames.push(...fs);
      for (const f of fs) samples.push({ features: f.vector, x: p[0] * innerWidth, y: p[1] * innerHeight });
    }
    if (samples.length < 30) {
      msg.textContent = "Not enough face data — check lighting and that your face is visible, then retry.";
      await sleep(2500);
      return null;
    }
    engine.setCalibration(samples, poseFrames);

    msg.textContent = "Checking accuracy…";
    const val: { target: { x: number; y: number }; samples: { x: number; y: number }[] }[] = [];
    for (const p of VAL_POINTS) {
      if (cancelled) return null;
      const fs = await collectAt(p, "val");
      val.push({ target: { x: p[0] * innerWidth, y: p[1] * innerHeight }, samples: fs.map((f) => engine.predictRaw(f.vector)) });
    }
    const g = geometry();
    const hits = evaluate(val.map((v) => ({ target: v.target, preds: v.samples })), innerWidth, innerHeight, g).hitRate;
    return { ...summarizeErrors(val, g), hit6: hits["6-chip (3x2)"], hit16: hits["16-grid (4x4)"], points: size };
  } finally {
    off();
    window.removeEventListener("keydown", onKey);
    root.hidden = true;
    root.innerHTML = "";
  }
}
