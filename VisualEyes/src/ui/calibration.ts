// 5x4 = 20-dot calibration + 4-point validation, about 1.5 min total. Validation reports
// accuracy in degrees with the assumptions shown, instead of an "accuracy %".
import type { GazeEngine } from "../gaze/engine";
import type { Sample } from "../gaze/regression";
import { summarizeErrors, type ErrorStats, type ViewingGeometry } from "../gaze/accuracy";
import type { FaceFrame } from "../gaze/tracker";
import type { HeadPos } from "../gaze/fixation";

// 5 columns x 4 rows of dots (20: enough for the model, short enough that your seat doesn't drift mid-calibration) across the screen, visited row by row in a serpentine so the head/eyes make short moves.
const COLS = 5;
const ROWS = 4;
const CAL_POINTS: [number, number][] = Array.from({ length: ROWS }, (_, r) => {
  const row = Array.from({ length: COLS }, (_, c) => [0.08 + (c * 0.84) / (COLS - 1), 0.1 + (r * 0.8) / (ROWS - 1)] as [number, number]);
  return r % 2 ? row.reverse() : row;
}).flat();
const VAL_POINTS: [number, number][] = [
  [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7],
];
// 2 s per dot: 0.7 s to move there and settle, 1.3 s of samples.
const SETTLE_MS = 700;
const COLLECT_MS = 1300;
const DOT_MS = SETTLE_MS + COLLECT_MS;
const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? NaN;

/** Drop frames whose first two features (yaw, pitch for the nose pointer) are outliers for this dot. */
function trimOutliers(fs: FaceFrame[]): FaceFrame[] {
  if (fs.length < 8) return fs;
  const keep = (i: number) => {
    const v = fs.map((f) => f.vector[i]);
    const m = median(v);
    const mad = median(v.map((x) => Math.abs(x - m))) || 1e-6;
    return (f: FaceFrame) => Math.abs(f.vector[i] - m) <= 3.5 * mad + 1e-4;
  };
  const kx = keep(0);
  const ky = keep(1);
  const out = fs.filter((f) => kx(f) && ky(f));
  return out.length >= 5 ? out : fs;
}

/** Validation result plus a direction check: correlation of predicted vs target position across the check dots. */
export type CalResult = ErrorStats & { dirX: number; dirY: number };

const corr = (a: number[], b: number[]) => {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / (Math.sqrt(saa * sbb) || 1);
};

export async function runCalibration(
  engine: GazeEngine,
  root: HTMLElement,
  geometry: () => ViewingGeometry,
  message = "Look at each dot until it disappears. Keep your head still and comfortable.",
): Promise<CalResult | null> {
  root.innerHTML = `<div class="cal-msg">${message}</div><div class="cal-dot"></div><div class="cal-progress"><div class="cal-bar"><i></i></div><span></span></div>`;
  root.hidden = false;
  const dot = root.querySelector<HTMLDivElement>(".cal-dot")!;
  const msg = root.querySelector<HTMLDivElement>(".cal-msg")!;
  const bar = root.querySelector<HTMLElement>(".cal-bar i")!;
  const progText = root.querySelector<HTMLElement>(".cal-progress span")!;
  const totalDots = CAL_POINTS.length + VAL_POINTS.length;
  const showProgress = (done: number, label: string) => {
    bar.style.width = `${(done / totalDots) * 100}%`;
    progText.textContent = `${label} · dot ${Math.min(done + 1, totalDots)} of ${totalDots} · about ${fmt((totalDots - done) * (DOT_MS / 1000))} left`;
  };
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
    msg.innerHTML = `${message}<small>${CAL_POINTS.length} dots, then ${VAL_POINTS.length} check dots: about ${fmt(totalDots * (DOT_MS / 1000))}. Each dot takes ${DOT_MS / 1000} seconds. A helper can press Esc to cancel.</small>`;
    showProgress(0, "Starting");
    await sleep(3500);
    msg.textContent = "";
    const pts: { p: [number, number]; frames: FaceFrame[] }[] = [];
    for (const [i, p] of CAL_POINTS.entries()) {
      if (cancelled) return null;
      showProgress(i, "Calibrating");
      pts.push({ p, frames: await collectAt(p) });
    }
    const build = () =>
      pts.flatMap((c) => trimOutliers(c.frames).map((f): Sample => ({ features: f.vector, x: c.p[0] * innerWidth, y: c.p[1] * innerHeight })));
    let samples = build();
    if (samples.length < 30) {
      msg.textContent = "Not enough face data — check lighting and that your face is visible, then retry.";
      await sleep(2500);
      return null;
    }
    // Where the head was while calibrating, so the app can warn if it moves away later (eye mode only).
    const headRefOf = () => {
      const kept = pts.flatMap((c) => trimOutliers(c.frames));
      return [0, 1, 2].map((j) => kept.reduce((a, f) => a + f.headPos[j], 0) / kept.length) as HeadPos;
    };
    engine.setCalibration(samples, headRefOf());

    // Quality pass: re-collect the dots the fit disagrees with most (head jerked, glanced away, tracker glitch).
    const resid = pts.map((c, i) => ({
      i,
      r: median(
        trimOutliers(c.frames).map((f) => {
          const q = engine.predictRaw(f.vector);
          return Math.hypot(q.x - c.p[0] * innerWidth, q.y - c.p[1] * innerHeight);
        }),
      ),
    }));
    const med = median(resid.map((x) => x.r));
    const bad = resid.filter((x) => x.r > Math.max(2.2 * med, 90)).sort((a, b) => b.r - a.r).slice(0, 4);
    for (const [n, b] of bad.entries()) {
      if (cancelled) return null;
      progText.textContent = `Re-checking dot ${n + 1} of ${bad.length} (the fit disagreed with it)`;
      const again = await collectAt(pts[b.i].p);
      if (again.length >= 8) pts[b.i].frames = again;
    }
    if (bad.length) {
      samples = build();
      engine.setCalibration(samples, headRefOf());
    }

    msg.textContent = "Checking accuracy…";
    const val: { target: { x: number; y: number }; samples: { x: number; y: number }[] }[] = [];
    for (const [i, p] of VAL_POINTS.entries()) {
      if (cancelled) return null;
      showProgress(CAL_POINTS.length + i, "Checking accuracy");
      const fs = trimOutliers(await collectAt(p));
      val.push({ target: { x: p[0] * innerWidth, y: p[1] * innerHeight }, samples: fs.map((f) => engine.predictRaw(f.vector)) });
    }
    const stats = summarizeErrors(val, geometry());
    // Mean prediction per check dot vs where the dot was. Strongly positive = the pointer follows your head/eyes the right way.
    const have = val.filter((v) => v.samples.length);
    const meanOf = (v: { samples: { x: number; y: number }[] }, k: "x" | "y") => v.samples.reduce((s, q) => s + q[k], 0) / v.samples.length;
    const dirX = have.length >= 3 ? corr(have.map((v) => meanOf(v, "x")), have.map((v) => v.target.x)) : NaN;
    const dirY = have.length >= 3 ? corr(have.map((v) => meanOf(v, "y")), have.map((v) => v.target.y)) : NaN;
    return { ...stats, dirX, dirY };
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
