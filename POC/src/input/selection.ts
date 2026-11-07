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

/**
 * Classic dwell: hold gaze on a target for `dwellMs`. Re-arms after a refractory gap.
 *
 * Webcam gaze flickers: the estimate often slips off a key (or onto a neighbour) for a frame
 * or two. Leaving for less than `graceMs` only pauses the fill instead of restarting it; the
 * fill never advances while the gaze is elsewhere, so a key can't fire when you're not on it.
 * A real move (away for `graceMs` or more) switches target, and the new key's fill counts
 * from when the gaze first arrived there.
 */
export class DwellSelector {
  private current: string | null = null;
  private since = 0;
  private firedAt = -Infinity;
  /** When the gaze left `current` (null while on it). */
  private awayFrom: number | null = null;
  private pending: string | null = null;
  private pendingSince = 0;

  constructor(
    public dwellMs = 800,
    public refractoryMs = 400,
    public graceMs = 200,
  ) {}

  private progressAt(t: number): number {
    const start = Math.max(this.since, this.firedAt + this.refractoryMs);
    return Math.max(0, Math.min(1, (t - start) / this.dwellMs));
  }

  update(t: number, target: string | null): SelectorOutput {
    if (target === this.current) {
      if (this.awayFrom !== null) {
        this.since += t - this.awayFrom; // pause the fill for the time spent away
        this.awayFrom = null;
        this.pending = null;
      }
    } else if (this.current === null) {
      this.current = target;
      this.since = t;
    } else {
      if (this.awayFrom === null) this.awayFrom = t;
      if (target !== this.pending) {
        this.pending = target;
        this.pendingSince = t;
      }
      if (t - this.awayFrom < this.graceMs) {
        // Brief slip: keep showing the current key's fill, frozen where it was.
        return { selected: null, progress: this.progressAt(this.awayFrom), target: this.current };
      }
      this.current = target;
      this.since = this.pendingSince;
      this.awayFrom = null;
      this.pending = null;
    }
    if (!this.current) return { selected: null, progress: 0, target: null };
    const progress = this.progressAt(t);
    if (progress >= 1) {
      this.firedAt = t;
      this.since = t;
      return { selected: this.current, progress: 1, target: this.current };
    }
    return { selected: null, progress, target: this.current };
  }

  reset() {
    this.current = null;
    this.firedAt = -Infinity;
    this.awayFrom = null;
    this.pending = null;
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
