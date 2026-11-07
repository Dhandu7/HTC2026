// 9-point calibration + 4-point validation, ~25 s total. Validation reports
// accuracy in degrees with the assumptions shown, instead of an "accuracy %".
import type { GazeEngine } from "../gaze/engine";
import type { Sample } from "../gaze/regression";
import { summarizeErrors, type ErrorStats, type ViewingGeometry } from "../gaze/accuracy";
import type { FaceFrame } from "../gaze/tracker";

const CAL_POINTS: [number, number][] = [
  [0.08, 0.1], [0.5, 0.1], [0.92, 0.1],
  [0.08, 0.5], [0.5, 0.5], [0.92, 0.5],
  [0.08, 0.9], [0.5, 0.9], [0.92, 0.9],
];
const VAL_POINTS: [number, number][] = [
  [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7],
];
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
    const samples: Sample[] = [];
    for (const p of CAL_POINTS) {
      if (cancelled) return null;
      const fs = await collectAt(p);
      for (const f of fs) samples.push({ features: f.vector, x: p[0] * innerWidth, y: p[1] * innerHeight });
    }
    if (samples.length < 30) {
      msg.textContent = "Not enough face data — check lighting and that your face is visible, then retry.";
      await sleep(2500);
      return null;
    }
    engine.setCalibration(samples);

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
