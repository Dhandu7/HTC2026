// Eye gestures that work wherever the pointer is, so they still work when tracking has drifted.

/**
 * Detects a burst of quick blinks (default: 3 within 2 s) as a "re-center" command.
 * Each blink must be short (both eyes closed 30–450 ms), so a long deliberate blink
 * (used for blink-selection, ≥350 ms) or simply closing the eyes doesn't count, and a
 * long closure in the middle cancels the burst. Natural blinking is ~15–20 a minute,
 * so three inside two seconds is rare by accident.
 */
export class BlinkBurstDetector {
  private closedSince: number | null = null;
  private blinks: number[] = [];
  private quietUntil = -Infinity;

  constructor(
    public count = 3,
    public windowMs = 2000,
    public minClosedMs = 30,
    public maxClosedMs = 450,
    /** Closed above this blendshape score, open below `openThreshold` (hysteresis avoids flicker). */
    public closedThreshold = 0.5,
    public openThreshold = 0.35,
    /** Ignore further bursts for this long after one fires. */
    public refractoryMs = 3000,
  ) {}

  /** Feed one camera frame. Returns true on the frame the burst completes. */
  update(t: number, blinkL: number, blinkR: number): boolean {
    const closed = blinkL > this.closedThreshold && blinkR > this.closedThreshold;
    const open = blinkL < this.openThreshold && blinkR < this.openThreshold;
    if (this.closedSince === null) {
      if (closed) this.closedSince = t;
      return false;
    }
    if (!open) {
      // Still closed: a closure this long isn't a quick blink, so start over.
      if (t - this.closedSince > this.maxClosedMs) this.blinks = [];
      return false;
    }
    const dur = t - this.closedSince;
    this.closedSince = null;
    if (dur < this.minClosedMs || dur > this.maxClosedMs) {
      this.blinks = [];
      return false;
    }
    this.blinks.push(t);
    this.blinks = this.blinks.filter((b) => t - b <= this.windowMs);
    if (this.blinks.length >= this.count && t >= this.quietUntil) {
      this.blinks = [];
      this.quietUntil = t + this.refractoryMs;
      return true;
    }
    return false;
  }

  reset() {
    this.closedSince = null;
    this.blinks = [];
  }
}
