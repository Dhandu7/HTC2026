// Records raw frames against on-screen targets so an in-app calibration can be saved as
// a replayable session (same format as the ● Record protocol).
import type { GazeEngine } from "../gaze/engine";
import type { FaceFrame, FaceTracker } from "../gaze/tracker";
import { SESSION_FORMAT, f32ToB64, type RecordedFrame, type RecordedSession, type RecordedTarget, type SegmentKind, type SessionMeta } from "./format";

export class SessionTape {
  private targets: RecordedTarget[] = [];
  private frames: RecordedFrame[] = [];
  private blendNames: string[] = [];
  private current: { ti: number; collecting: boolean } | null = null;
  private off: () => void;

  constructor(engine: GazeEngine) {
    this.off = engine.onRaw((f: FaceFrame | null) => {
      if (!this.current) return;
      if (f && !this.blendNames.length) this.blendNames = f.raw.blendNames;
      this.frames.push({
        t: f ? f.t : performance.now(),
        ti: this.current.ti,
        c: this.current.collecting,
        lm: f ? f32ToB64(f.raw.lm) : null,
        bs: f ? f32ToB64(f.raw.blend) : null,
        m: f ? f.raw.matrix : null,
        inferMs: f ? f.inferMs : 0,
      });
    });
  }

  /** The dot just appeared at viewport fraction (fx, fy). */
  show(segment: SegmentKind, fx: number, fy: number) {
    const t = performance.now();
    this.targets.push({ segment, atMin: 0, fx, fy, x: fx * innerWidth, y: fy * innerHeight, vw: innerWidth, vh: innerHeight, tShown: t, tCollect0: 0, tCollect1: 0 });
    this.current = { ti: this.targets.length - 1, collecting: false };
  }

  collectStart() {
    if (!this.current) return;
    this.targets[this.current.ti].tCollect0 = performance.now();
    this.current.collecting = true;
  }

  collectEnd() {
    if (!this.current) return;
    this.targets[this.current.ti].tCollect1 = performance.now();
    this.current = null;
  }

  stop() {
    this.current = null;
    this.off();
  }

  toSession(meta: SessionMeta, tracker: FaceTracker): RecordedSession {
    // Keep only completed targets and re-index frames against them.
    const keep = new Map<number, number>();
    this.targets.forEach((t, i) => t.tCollect1 && keep.set(i, keep.size));
    return {
      format: SESSION_FORMAT,
      createdAt: new Date().toISOString(),
      meta,
      env: {
        userAgent: navigator.userAgent,
        camera: tracker.cameraLabel,
        videoWidth: tracker.videoSize.width,
        videoHeight: tracker.videoSize.height,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio,
      },
      blendNames: this.blendNames,
      targets: this.targets.filter((t) => t.tCollect1),
      frames: this.frames.filter((f) => keep.has(f.ti)).map((f) => ({ ...f, ti: keep.get(f.ti)! })),
      videoTimeline: null,
    };
  }
}
