// 13-point calibration + 4-point validation, ~30 s total. Validation reports
// accuracy in degrees with the assumptions shown, instead of an "accuracy %".
//
// Sample quality: at each dot, frames that disagree with the rest (a glance away, a
// half-blink) are dropped; a dot with too few good frames, or looked at much less steadily
// than the others, is shown again once.
import type { GazeEngine } from "../gaze/engine";
import type { Sample } from "../gaze/regression";
import { summarizeErrors, type ErrorStats, type ViewingGeometry } from "../gaze/accuracy";
import type { FaceFrame } from "../gaze/tracker";
import { cleanFixation, scatteredDots, type HeadPos } from "../gaze/fixation";

// The outer 3x3 covers the screen; the inner four sit where the keyboard's middle keys are,
// so the model is most accurate where people actually look.
const CAL_POINTS: [number, number][] = [
  [0.08, 0.1], [0.5, 0.1], [0.92, 0.1],
  [0.08, 0.5], [0.5, 0.5], [0.92, 0.5],
  [0.08, 0.9], [0.5, 0.9], [0.92, 0.9],
  [0.29, 0.3], [0.71, 0.3], [0.29, 0.7], [0.71, 0.7],
];
// Held out: never on a calibration dot, so the accuracy check isn't flattered.
const VAL_POINTS: [number, number][] = [
  [0.5, 0.3], [0.29, 0.5], [0.71, 0.5], [0.5, 0.7],
];
/** At most this many dots are shown a second time because they were looked at unsteadily. */
const MAX_REDO = 3;
const SETTLE_MS = 650;
const COLLECT_MS = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCalibration(
  engine: GazeEngine,
  root: HTMLElement,
  geometry: () => ViewingGeometry,
): Promise<ErrorStats | null> {
  root.innerHTML = `<div class="cal-msg">Look at each dot until it disappears. Keep your head still and comfortable.</div><div class="cal-dot"></div>`;
  root.hidden = false;
  const dot = root.querySelector<HTMLDivElement>(".cal-dot")!;
  const msg = root.querySelector<HTMLDivElement>(".cal-msg")!;
  let frames: FaceFrame[] = [];
  let collecting = false;
  const off = engine.onRaw((f) => {
    if (collecting && f && !(f.blinkL > 0.45 && f.blinkR > 0.45)) frames.push(f);
  });
  let cancelled = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancelled = true;
  };
  window.addEventListener("keydown", onKey);

  const place = (p: [number, number]) => {
    dot.style.left = `${p[0] * innerWidth}px`;
    dot.style.top = `${p[1] * innerHeight}px`;
    dot.classList.remove("collect");
    void dot.offsetWidth;
    dot.classList.add("collect");
  };

  const collectAt = async (p: [number, number]) => {
    place(p);
    await sleep(SETTLE_MS);
    frames = [];
    collecting = true;
    await sleep(COLLECT_MS);
    collecting = false;
    return frames;
  };

  try {
    await sleep(1200);
    msg.textContent = "";
    // Look at a dot; keep only the frames that agree with each other. One immediate retry if too few did.
    const lookAt = async (p: [number, number]) => {
      let best: { frames: FaceFrame[]; spread: number[]; steady: boolean } | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) msg.textContent = "Look at the dot again";
        const fs = await collectAt(p);
        const c = cleanFixation(fs.map((f) => f.vector));
        const got = { frames: c.kept.map((i) => fs[i]), spread: c.spread, steady: c.steady };
        if (!best || got.frames.length > best.frames.length) best = got;
        if (c.steady) break;
      }
      msg.textContent = "";
      return best!;
    };
    const looks = [];
    for (const p of CAL_POINTS) {
      if (cancelled) return null;
      looks.push(await lookAt(p));
    }
    // Dots looked at much less steadily than the rest get one more go.
    for (const i of scatteredDots(looks.map((l) => l.spread)).slice(0, MAX_REDO)) {
      if (cancelled) return null;
      const again = await lookAt(CAL_POINTS[i]);
      if (again.steady) looks[i] = again;
    }
    const samples: Sample[] = [];
    looks.forEach((l, i) => {
      for (const f of l.frames) samples.push({ features: f.vector, x: CAL_POINTS[i][0] * innerWidth, y: CAL_POINTS[i][1] * innerHeight });
    });
    if (samples.length < 30) {
      msg.textContent = "Not enough face data — check lighting and that your face is visible, then retry.";
      await sleep(2500);
      return null;
    }
    // Where the head was while calibrating, so the app can warn if it moves away later.
    const kept = looks.flatMap((l) => l.frames);
    const headRef = [0, 1, 2].map((j) => kept.reduce((a, f) => a + f.headPos[j], 0) / kept.length) as HeadPos;
    engine.setCalibration(samples, headRef);

    msg.textContent = "Checking accuracy…";
    const val: { target: { x: number; y: number }; samples: { x: number; y: number }[] }[] = [];
    for (const p of VAL_POINTS) {
      if (cancelled) return null;
      const fs = await collectAt(p);
      val.push({ target: { x: p[0] * innerWidth, y: p[1] * innerHeight }, samples: fs.map((f) => engine.predictRaw(f.vector)) });
    }
    return summarizeErrors(val, geometry());
  } finally {
    off();
    window.removeEventListener("keydown", onKey);
    root.hidden = true;
    root.innerHTML = "";
  }
}

export interface RecenterResult {
  ok: boolean;
  /** How far the pointer was shifted (px). */
  shiftPx?: number;
  reason?: "no-face" | "unsteady";
}

/**
 * Quick re-center (~1.5 s): one dot in the middle of the screen. Fixes drift without a full
 * calibration, and works however far off the pointer is, because the user just looks at the dot.
 */
export async function runRecenter(engine: GazeEngine, root: HTMLElement): Promise<RecenterResult> {
  const x = innerWidth / 2;
  const y = innerHeight / 2;
  root.innerHTML = `<div class="cal-msg recenter-msg">Look at the dot</div><div class="cal-dot collect" style="left:${x}px;top:${y}px"></div>`;
  root.hidden = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(SETTLE_MS);
      const t0 = performance.now();
      await sleep(COLLECT_MS);
      const fix = engine.fixation(t0, performance.now());
      if (!fix) return { ok: false, reason: "no-face" };
      // A steady look keeps estimates within a few degrees; a big spread means the eyes were moving.
      if (fix.spreadPx < Math.min(innerWidth, innerHeight) * 0.12) {
        return { ok: true, shiftPx: engine.recenter(fix.features, x, y) };
      }
      root.querySelector(".cal-msg")!.textContent = "Keep looking at the dot";
    }
    return { ok: false, reason: "unsteady" };
  } finally {
    root.hidden = true;
    root.innerHTML = "";
  }
}
