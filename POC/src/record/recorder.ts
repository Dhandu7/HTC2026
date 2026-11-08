// Records a gaze session for offline replay: raw MediaPipe output per frame while the
// participant looks at known targets, plus (optionally) a local video. Nothing is
// uploaded; the files are downloaded to this machine.
import type { GazeEngine } from "../gaze/engine";
import type { FaceFrame, FaceTracker } from "../gaze/tracker";
import {
  COLLECT_MS,
  SESSION_FORMAT,
  SETTLE_MS,
  buildProtocol,
  f32ToB64,
  type RecordedFrame,
  type RecordedSession,
  type RecordedTarget,
  type SessionMeta,
} from "./format";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export interface RecordOptions {
  meta: SessionMeta;
  video: boolean;
}

/** Runs the protocol full-screen. Resolves with the number of frames recorded, or null if cancelled. */
export async function recordSession(
  engine: GazeEngine,
  tracker: FaceTracker,
  root: HTMLElement,
  opts: RecordOptions,
): Promise<number | null> {
  const protocol = buildProtocol(opts.meta.mode);
  root.innerHTML = `<div class="cal-msg"></div><div class="cal-dot" hidden></div>`;
  root.hidden = false;
  const dot = root.querySelector<HTMLDivElement>(".cal-dot")!;
  const msg = root.querySelector<HTMLDivElement>(".cal-msg")!;
  try {
    await document.documentElement.requestFullscreen?.();
  } catch {
    /* not allowed; continue windowed */
  }

  let cancelled = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancelled = true;
  };
  window.addEventListener("keydown", onKey);

  const targets: RecordedTarget[] = [];
  const frames: RecordedFrame[] = [];
  let blendNames: string[] = [];
  let current: { ti: number; collecting: boolean } | null = null;
  const off = engine.onRaw((f: FaceFrame | null) => {
    if (!current) return;
    if (f && !blendNames.length) blendNames = f.raw.blendNames;
    frames.push({
      t: f ? f.t : performance.now(),
      ti: current.ti,
      c: current.collecting,
      lm: f ? f32ToB64(f.raw.lm) : null,
      bs: f ? f32ToB64(f.raw.blend) : null,
      m: f ? f.raw.matrix : null,
      inferMs: f ? f.inferMs : 0,
    });
  });

  // Local video: paused between segments so the file stays small; timeline maps wall clock -> video time.
  let rec: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  const timeline: { t0: number; t1: number }[] = [];
  const stream = tracker.mediaStream;
  if (opts.video && stream && typeof MediaRecorder !== "undefined") {
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  }
  const videoOn = () => {
    if (!rec) return;
    if (rec.state === "inactive") rec.start(1000);
    else if (rec.state === "paused") rec.resume();
    timeline.push({ t0: performance.now(), t1: NaN });
  };
  const videoOff = () => {
    if (!rec || rec.state !== "recording") return;
    rec.pause();
    timeline[timeline.length - 1].t1 = performance.now();
  };

  const showPoint = async (ti: number) => {
    const p = targets[ti];
    dot.hidden = false;
    dot.style.left = `${p.x}px`;
    dot.style.top = `${p.y}px`;
    dot.classList.remove("collect");
    void dot.offsetWidth;
    dot.style.animationDuration = `${(SETTLE_MS + COLLECT_MS) / 1000}s`;
    dot.classList.add("collect");
    current = { ti, collecting: false };
    p.tShown = performance.now();
    await sleep(SETTLE_MS);
    p.tCollect0 = performance.now();
    current = { ti, collecting: true };
    await sleep(COLLECT_MS);
    p.tCollect1 = performance.now();
    current = null;
  };

  const runSegment = async (from: number, to: number) => {
    videoOn();
    for (let ti = from; ti < to; ti++) {
      if (cancelled) break;
      const p = protocol[ti];
      targets[ti] = { ...p, x: p.fx * innerWidth, y: p.fy * innerHeight, vw: innerWidth, vh: innerHeight, tShown: 0, tCollect0: 0, tCollect1: 0 };
      await showPoint(ti);
    }
    videoOff();
    dot.hidden = true;
  };

  try {
    msg.textContent = "Look at each dot until it shrinks away. Sit as you normally would. Esc cancels.";
    await sleep(2500);
    msg.textContent = "";
    // Group consecutive targets of the same segment/check into one run.
    let i = 0;
    let valEnd = 0;
    while (i < protocol.length && !cancelled) {
      let j = i;
      while (j < protocol.length && protocol[j].segment === protocol[i].segment && protocol[j].atMin === protocol[i].atMin) j++;
      const seg = protocol[i];
      if (seg.segment === "drift") {
        // Wait until the drift check is due, with a countdown. Keep seated; look anywhere.
        const due = valEnd + seg.atMin * 60_000;
        while (performance.now() < due && !cancelled) {
          const s = Math.ceil((due - performance.now()) / 1000);
          msg.textContent = `Drift check at +${seg.atMin} min in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}. Stay seated as you are; look anywhere. Esc ends the session early (data so far is kept).`;
          await sleep(250);
        }
        if (cancelled) break;
        msg.textContent = "";
      }
      await runSegment(i, j);
      if (seg.segment === "val") valEnd = performance.now();
      i = j;
    }
    // Cancelling during drift keeps cal+val; cancelling earlier discards the session.
    const done = targets.filter(Boolean);
    const hasVal = done.some((t) => t.segment === "val" && t.tCollect1);
    if (!hasVal) return null;

    const session: RecordedSession = {
      format: SESSION_FORMAT,
      createdAt: new Date().toISOString(),
      meta: opts.meta,
      env: {
        userAgent: navigator.userAgent,
        camera: tracker.cameraLabel,
        videoWidth: tracker.videoSize.width,
        videoHeight: tracker.videoSize.height,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio: devicePixelRatio,
      },
      blendNames,
      targets: done.filter((t) => t.tCollect1),
      frames: [],
      videoTimeline: rec ? timeline : null,
    };
    // Re-index frames against the kept targets.
    const keep = new Map<number, number>();
    targets.forEach((t, idx) => {
      if (t?.tCollect1) keep.set(idx, keep.size);
    });
    session.frames = frames.filter((f) => keep.has(f.ti)).map((f) => ({ ...f, ti: keep.get(f.ti)! }));

    const stamp = session.createdAt.replace(/[:.]/g, "-");
    const base = `gazesession-${opts.meta.participant.replace(/[^\w-]+/g, "_") || "anon"}-${stamp}`;
    download(new Blob([JSON.stringify(session)], { type: "application/json" }), `${base}.json`);
    if (rec) {
      const stopped = new Promise((r) => (rec!.onstop = r));
      rec.stop();
      await stopped;
      download(new Blob(chunks, { type: rec.mimeType || "video/webm" }), `${base}.webm`);
    }
    return session.frames.length;
  } finally {
    current = null;
    off();
    if (rec && rec.state !== "inactive") rec.stop();
    window.removeEventListener("keydown", onKey);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    root.hidden = true;
    root.innerHTML = "";
  }
}
