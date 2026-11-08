// Session recorder: numbers only (features, predictions, cursor, events). Never video or images.
// Everything stays in memory until the user exports it as a JSON file, so a session can be replayed
// offline to see exactly when and why the pointer goes wrong.

export const BASE_COLUMNS = [
  "t", // ms since recording start
  "phase", // 0 = using, 1 = calibration overlay open
  "rawX", "rawY", // model output before smoothing (px)
  "curX", "curY", // cursor after smoothing + clamp (px)
  "valid",
  "blinkL", "blinkR",
] as const;

export interface RecEvent {
  t: number;
  type: string;
  data?: unknown;
}

const MAX_FRAMES = 120_000; // about an hour at 30 fps

export class SessionRecorder {
  private t0 = performance.now();
  private rows: (number | null)[][] = [];
  private events: RecEvent[] = [];
  /** Names of the feature columns that follow BASE_COLUMNS in every row (depends on the tracker mode). */
  featureNames: string[] = [];
  capped = false;

  get frameCount() {
    return this.rows.length;
  }

  event(type: string, data?: unknown) {
    this.events.push({ t: Math.round(performance.now() - this.t0), type, data });
  }

  frame(base: Omit<Record<(typeof BASE_COLUMNS)[number], number>, "t">, features: number[]) {
    if (this.rows.length >= MAX_FRAMES) {
      this.capped = true;
      return;
    }
    const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
    const t = Math.round(performance.now() - this.t0);
    this.rows.push([t, ...BASE_COLUMNS.slice(1).map((c) => r(base[c as keyof typeof base])), ...features.map(r)]);
  }

  toJSON(extra: Record<string, unknown>) {
    return {
      format: "gazetype-session/2",
      note: "Numbers only. No video or images are recorded.",
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      window: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, screenW: screen.width, screenH: screen.height },
      columns: [...BASE_COLUMNS, ...this.featureNames],
      frames: this.rows,
      events: this.events,
      capped: this.capped,
      ...extra,
    };
  }
}
