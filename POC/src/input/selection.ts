// Selection state machines. Pure: fed with timestamps, the currently fixated
// target id, and eye-closure state. They emit "select" events and progress.

export type SelectionMode = "dwell" | "blink" | "click";

export interface SelectorOutput {
  /** Target id selected on this frame, if any. */
  selected: string | null;
  /** 0..1 progress toward selecting `target` (dwell fill or blink hold). */
  progress: number;
  target: string | null;
}

/** Classic dwell: hold gaze on a target for `dwellMs`. Re-arms after leaving or a refractory gap. */
export class DwellSelector {
  private current: string | null = null;
  private since = 0;
  private firedAt = -Infinity;
  constructor(
    public dwellMs = 800,
    public refractoryMs = 400,
  ) {}

  update(t: number, target: string | null): SelectorOutput {
    if (target !== this.current) {
      this.current = target;
      this.since = t;
    }
    if (!target) return { selected: null, progress: 0, target: null };
    const start = Math.max(this.since, this.firedAt + this.refractoryMs);
    const progress = Math.max(0, Math.min(1, (t - start) / this.dwellMs));
    if (progress >= 1) {
      this.firedAt = t;
      this.since = t;
      return { selected: target, progress: 1, target };
    }
    return { selected: null, progress, target };
  }

  reset() {
    this.current = null;
    this.firedAt = -Infinity;
  }
}

/**
 * Dwell with evidence accumulation: each target collects dwell time while gazed at and
 * loses it at `decay` × real time while not. A cursor that flickers off a button for a
 * few frames keeps most of its progress, and a brief pass over a neighbour on the way in
 * drains away instead of firing. Same interface as DwellSelector.
 */
export class AccumulatingDwellSelector {
  private evidence = new Map<string, number>();
  private lastT: number | null = null;
  private firedAt = -Infinity;
  constructor(
    public dwellMs = 800,
    public decay = 1,
    public refractoryMs = 400,
  ) {}

  update(t: number, target: string | null): SelectorOutput {
    const dt = this.lastT === null ? 0 : Math.min(t - this.lastT, 200);
    this.lastT = t;
    for (const [k, v] of this.evidence) {
      if (k === target) continue;
      const nv = v - dt * this.decay;
      if (nv <= 0) this.evidence.delete(k);
      else this.evidence.set(k, nv);
    }
    if (!target) return { selected: null, progress: 0, target: null };
    if (t - this.firedAt < this.refractoryMs) return { selected: null, progress: 0, target };
    const e = (this.evidence.get(target) ?? 0) + dt;
    if (e >= this.dwellMs) {
      this.evidence.clear();
      this.firedAt = t;
      return { selected: target, progress: 1, target };
    }
    this.evidence.set(target, e);
    return { selected: null, progress: e / this.dwellMs, target };
  }

  reset() {
    this.evidence.clear();
    this.lastT = null;
    this.firedAt = -Infinity;
  }
}

/**
 * Dwell-free selection by deliberate blink. Look at a target (short "aim" fixation),
 * then close both eyes for longer than an involuntary blink (default 350–1500 ms).
 * Involuntary blinks (< minClosedMs) are counted and ignored — that rejection count
 * is reported so false-trigger behaviour is measured rather than assumed.
 */
export class BlinkSelector {
  private aimTarget: string | null = null;
  private aimSince = 0;
  private closedSince: number | null = null;
  private lockedTarget: string | null = null;
  rejectedShort = 0;
  rejectedLong = 0;
  accepted = 0;

  constructor(
    public minClosedMs = 350,
    public maxClosedMs = 1500,
    public minAimMs = 150,
    public closedThreshold = 0.5,
  ) {}

  update(t: number, target: string | null, blinkL: number, blinkR: number): SelectorOutput {
    const closed = blinkL > this.closedThreshold && blinkR > this.closedThreshold;
    if (!closed) {
      let selected: string | null = null;
      if (this.closedSince !== null) {
        const dur = t - this.closedSince;
        if (dur < this.minClosedMs) this.rejectedShort++;
        else if (dur > this.maxClosedMs) this.rejectedLong++;
        else if (this.lockedTarget) {
          selected = this.lockedTarget;
          this.accepted++;
        }
        this.closedSince = null;
        this.lockedTarget = null;
      }
      if (target !== this.aimTarget) {
        this.aimTarget = target;
        this.aimSince = t;
      }
      return { selected, progress: 0, target };
    }
    // Eyes closed: the gaze estimate is meaningless now, so lock the last aimed target.
    if (this.closedSince === null) {
      this.closedSince = t;
      this.lockedTarget = this.aimTarget && t - this.aimSince >= this.minAimMs ? this.aimTarget : null;
    }
    const dur = t - this.closedSince;
    const progress = this.lockedTarget ? Math.min(1, dur / this.minClosedMs) : 0;
    return { selected: null, progress, target: this.lockedTarget };
  }

  reset() {
    this.aimTarget = null;
    this.closedSince = null;
    this.lockedTarget = null;
  }
}

export interface Rect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Maps a (noisy) gaze point to a target with "gravity" and hysteresis:
 * points inside a rect, or within `snapPx` of its edge, count for it; switching
 * targets requires the new one to win for `switchMs`.
 */
export class TargetTracker {
  private current: string | null = null;
  private candidate: string | null = null;
  private candidateSince = 0;
  constructor(
    public snapPx = 40,
    public switchMs = 90,
  ) {}

  static hit(rects: Rect[], x: number, y: number, snapPx: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const r of rects) {
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = r.id;
      }
    }
    return bestD <= snapPx ? best : null;
  }

  update(t: number, rects: Rect[], x: number, y: number): string | null {
    const raw = Number.isFinite(x) ? TargetTracker.hit(rects, x, y, this.snapPx) : null;
    if (raw === this.current) {
      this.candidate = null;
      return this.current;
    }
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.candidateSince = t;
    }
    if (t - this.candidateSince >= this.switchMs) {
      this.current = raw;
      this.candidate = null;
    }
    return this.current;
  }

  reset() {
    this.current = null;
    this.candidate = null;
  }
}
