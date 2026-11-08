// Closed-loop Target test: the live pointer is visible and the user steers it onto a
// highlighted button until the app's own dwell selects something. Measures what using the app
// feels like (aim, see, correct), unlike the blind check dots in calibration. Raw frames are
// taped too, so the session can be replayed like any other.
import type { GazeEngine, GazePoint } from "../gaze/engine";
import type { FaceTracker } from "../gaze/tracker";
import { DwellSelector, TargetTracker, type Rect } from "../input/selection";
import type { RecordedSession, SessionMeta, TargetTrial } from "./format";
import { SessionTape } from "./tape";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TargetTestLayout {
  name: string;
  cols: number;
  rows: number;
  /** Buttons to test, as [col, row]; every corner is included on purpose. */
  cells: [number, number][];
}

/** 6 large buttons: all six. 4x4 grid: the four corners plus four inner/edge keys. */
export const TARGET_LAYOUTS: TargetTestLayout[] = [
  { name: "6-chip (3x2)", cols: 3, rows: 2, cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]] },
  { name: "16-grid (4x4)", cols: 4, rows: 4, cells: [[0, 0], [3, 0], [0, 3], [3, 3], [1, 1], [2, 2], [1, 3], [3, 1]] },
];

export interface TargetTestOptions {
  meta: SessionMeta;
  dwellMs: number;
  /** Give up on a trial after this long. */
  timeoutMs?: number;
}

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Runs the test full-screen. Resolves with the session (results + raw frames), or null if cancelled first. */
export async function runTargetTest(engine: GazeEngine, tracker: FaceTracker, root: HTMLElement, opts: TargetTestOptions): Promise<RecordedSession | null> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  root.innerHTML = `<div class="tt-msg"></div><div class="tt-grid"></div><div class="tt-cursor"></div>`;
  root.hidden = false;
  root.classList.add("target-test");
  const msg = root.querySelector<HTMLElement>(".tt-msg")!;
  const grid = root.querySelector<HTMLElement>(".tt-grid")!;
  const cursor = root.querySelector<HTMLElement>(".tt-cursor")!;
  let cancelled = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancelled = true;
  };
  window.addEventListener("keydown", onKey);
  const tape = new SessionTape(engine);
  const trials: TargetTrial[] = [];

  let onPoint: ((g: GazePoint) => void) | null = null;
  const offGaze = engine.onGaze((g) => {
    if (g.valid && Number.isFinite(g.x)) {
      cursor.style.transform = `translate(${g.x - 14}px, ${g.y - 14}px)`;
      cursor.hidden = false;
    }
    onPoint?.(g);
  });

  try {
    msg.textContent = "Steer the pointer onto the highlighted button and hold it there until it's selected. Esc stops.";
    await sleep(3000);
    for (const layout of TARGET_LAYOUTS) {
      grid.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
      grid.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;
      grid.innerHTML = Array.from({ length: layout.cols * layout.rows }, (_, i) => `<div class="tt-key" data-cell="${i % layout.cols},${Math.floor(i / layout.cols)}"></div>`).join("");
      msg.textContent = `${layout.name}: select the highlighted button.`;
      await sleep(1200);
      for (const [c, r] of shuffled(layout.cells)) {
        if (cancelled) break;
        const id = `${c},${r}`;
        const keys = [...grid.querySelectorAll<HTMLElement>(".tt-key")];
        keys.forEach((k) => k.classList.toggle("goal", k.dataset.cell === id));
        const rects: Rect[] = keys.map((k) => {
          const b = k.getBoundingClientRect();
          return { id: k.dataset.cell!, left: b.left, top: b.top, right: b.right, bottom: b.bottom };
        });
        const goal = rects.find((x) => x.id === id)!;
        const fx = (goal.left + goal.right) / 2 / innerWidth;
        const fy = (goal.top + goal.bottom) / 2 / innerHeight;
        tape.show("target", fx, fy);
        tape.collectStart();
        const tt = new TargetTracker(36, 90);
        const dwell = new DwellSelector(opts.dwellMs);
        const t0 = performance.now();
        const result = await new Promise<{ selected: string | null; t: number }>((resolve) => {
          const timer = setTimeout(() => resolve({ selected: null, t: performance.now() }), timeoutMs);
          onPoint = (g) => {
            const target = g.valid && !g.offscreen ? tt.update(g.t, rects, g.x, g.y) : null;
            const out = dwell.update(g.t, target);
            keys.forEach((k) => k.style.setProperty("--p", k.dataset.cell === out.target ? String(out.progress) : "0"));
            if (out.selected || cancelled) {
              clearTimeout(timer);
              resolve({ selected: out.selected, t: performance.now() });
            }
          };
        });
        onPoint = null;
        tape.collectEnd();
        if (cancelled && !result.selected) break;
        trials.push({
          layout: layout.name,
          target: id,
          fx,
          fy,
          outcome: result.selected === null ? "timeout" : result.selected === id ? "correct" : "wrong",
          selected: result.selected,
          timeMs: result.t - t0,
        });
        const key = keys.find((k) => k.dataset.cell === (result.selected ?? id));
        key?.classList.add(result.selected === id ? "ok" : "bad");
        await sleep(600);
        keys.forEach((k) => k.classList.remove("goal", "ok", "bad"));
        await sleep(300);
      }
      if (cancelled) break;
    }
    if (!trials.length) return null;
    const session = tape.toSession({ ...opts.meta, mode: "target" }, tracker);
    session.targetTest = { dwellMs: opts.dwellMs, timeoutMs, trials };
    return session;
  } finally {
    offGaze();
    tape.stop();
    window.removeEventListener("keydown", onKey);
    root.classList.remove("target-test");
    root.hidden = true;
    root.innerHTML = "";
  }
}
