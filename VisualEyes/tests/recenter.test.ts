import { describe, expect, it } from "vitest";
import { BlinkBurstDetector } from "../src/input/gestures";
import { clampToView } from "../src/gaze/engine";

/** Feed a sequence of [durationMs, closed] segments at 30 fps; return the times a burst fired. */
function run(d: BlinkBurstDetector, segments: [number, boolean][], start = 0): number[] {
  const fired: number[] = [];
  let t = start;
  for (const [ms, closed] of segments) {
    const end = t + ms;
    for (; t < end; t += 33) if (d.update(t, closed ? 0.9 : 0.05, closed ? 0.9 : 0.05)) fired.push(t);
  }
  return fired;
}
const quickBlinks = (n: number, gap = 250): [number, boolean][] =>
  Array.from({ length: n }, () => [[150, true], [gap, false]] as [number, boolean][]).flat();

describe("BlinkBurstDetector", () => {
  it("fires on three quick blinks", () => {
    expect(run(new BlinkBurstDetector(), [[500, false], ...quickBlinks(3)])).toHaveLength(1);
  });
  it("ignores two blinks, and normal blinking spread out over time", () => {
    const d = new BlinkBurstDetector();
    expect(run(d, [[500, false], ...quickBlinks(2)])).toHaveLength(0);
    // 15 natural blinks, one every 3 s.
    expect(run(new BlinkBurstDetector(), quickBlinks(15, 2850))).toHaveLength(0);
  });
  it("doesn't count long deliberate blinks (used for blink selection)", () => {
    const long: [number, boolean][] = [[600, true], [200, false]];
    expect(run(new BlinkBurstDetector(), [[300, false], ...long, ...long, ...long])).toHaveLength(0);
  });
  it("a long closure in the middle cancels the burst", () => {
    expect(run(new BlinkBurstDetector(), [[300, false], ...quickBlinks(2), [800, true], [200, false], ...quickBlinks(1)])).toHaveLength(0);
  });
  it("waits before firing again", () => {
    const d = new BlinkBurstDetector();
    // Six quick blinks in a row: one re-center, not two.
    expect(run(d, [[300, false], ...quickBlinks(6)])).toHaveLength(1);
    // After the quiet period, it works again.
    expect(run(d, [[3500, false], ...quickBlinks(3)], 10_000)).toHaveLength(1);
  });
  it("ignores a single noisy frame of half-closed eyes", () => {
    const d = new BlinkBurstDetector();
    let fired = 0;
    for (let t = 0; t < 3000; t += 33) if (d.update(t, t % 330 === 0 ? 0.4 : 0.05, 0.05)) fired++;
    expect(fired).toBe(0);
  });
});

describe("clampToView", () => {
  it("leaves on-screen points alone", () => {
    expect(clampToView(100, 200, 1000, 800)).toEqual({ x: 100, y: 200, offscreen: false });
  });
  it("allows a small overshoot at the edge", () => {
    expect(clampToView(1020, -30, 1000, 800)).toEqual({ x: 1000, y: 0, offscreen: false });
  });
  it("pins far-off points to the edge and marks them lost", () => {
    expect(clampToView(-500, 2000, 1000, 800)).toEqual({ x: 0, y: 800, offscreen: true });
  });
});
