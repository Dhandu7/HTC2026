import { describe, expect, it } from "vitest";
import { BlinkSelector, DwellSelector, TargetTracker } from "../src/input/selection";

describe("DwellSelector", () => {
  it("fires after dwellMs and respects refractory period", () => {
    const d = new DwellSelector(500, 300);
    expect(d.update(0, "a").selected).toBeNull();
    expect(d.update(400, "a").progress).toBeCloseTo(0.8);
    expect(d.update(500, "a").selected).toBe("a");
    expect(d.update(700, "a").selected).toBeNull();
    expect(d.update(1300, "a").selected).toBe("a");
  });
  it("resets when gaze leaves", () => {
    const d = new DwellSelector(500);
    d.update(0, "a");
    d.update(400, "b");
    expect(d.update(800, "b").selected).toBeNull();
    expect(d.update(900, "b").selected).toBe("b");
  });
  it("a brief slip off the key pauses the fill instead of restarting it", () => {
    const d = new DwellSelector(500, 300, 200);
    d.update(0, "a");
    d.update(300, "a");
    const slip = d.update(350, null); // gaze flickers off for 100 ms
    expect(slip.target).toBe("a");
    expect(slip.progress).toBeCloseTo(0.7); // frozen at 350 ms, when it slipped
    d.update(400, "b"); // ...or onto a neighbour
    expect(d.update(450, "a").progress).toBeCloseTo(0.7); // back after 100 ms away: still 70%
    expect(d.update(600, "a").selected).toBe("a"); // fired after 500 ms of actually looking
  });
  it("never fires a key while the gaze is elsewhere", () => {
    const d = new DwellSelector(500, 300, 200);
    d.update(0, "a");
    d.update(450, "a"); // 90%
    for (let t = 466; t < 660; t += 33) expect(d.update(t, "b").selected).toBeNull();
  });
  it("a real move switches key, counting from when the gaze arrived", () => {
    const d = new DwellSelector(500, 300, 200);
    d.update(0, "a");
    d.update(100, "b");
    expect(d.update(300, "b").target).toBe("b"); // away 200 ms: switched
    expect(d.update(599, "b").selected).toBeNull();
    expect(d.update(600, "b").selected).toBe("b"); // 500 ms after first reaching "b"
  });
});

describe("BlinkSelector", () => {
  const open = 0.05;
  const shut = 0.9;
  it("selects on a deliberate blink after aiming", () => {
    const b = new BlinkSelector(350, 1500, 150);
    b.update(0, "k", open, open);
    b.update(200, "k", open, open);
    b.update(220, "k", shut, shut);
    b.update(500, null, shut, shut);
    expect(b.update(650, "x", open, open).selected).toBe("k");
    expect(b.accepted).toBe(1);
  });
  it("rejects involuntary short blinks", () => {
    const b = new BlinkSelector(350, 1500, 150);
    b.update(0, "k", open, open);
    b.update(300, "k", shut, shut);
    expect(b.update(420, "k", open, open).selected).toBeNull();
    expect(b.rejectedShort).toBe(1);
  });
  it("rejects one-eye winks and very long closures", () => {
    const b = new BlinkSelector(350, 1500, 150);
    b.update(0, "k", open, open);
    b.update(300, "k", shut, open);
    expect(b.update(900, "k", open, open).selected).toBeNull();
    b.update(1000, "k", shut, shut);
    expect(b.update(3000, "k", open, open).selected).toBeNull();
    expect(b.rejectedLong).toBe(1);
  });
});

describe("TargetTracker", () => {
  const rects = [
    { id: "a", left: 0, top: 0, right: 100, bottom: 100 },
    { id: "b", left: 200, top: 0, right: 300, bottom: 100 },
  ];
  it("snaps near-misses and applies hysteresis", () => {
    const t = new TargetTracker(40, 90);
    expect(t.update(0, rects, 120, 50)).toBeNull();
    expect(t.update(100, rects, 120, 50)).toBe("a");
    expect(t.update(110, rects, 250, 50)).toBe("a");
    expect(t.update(220, rects, 250, 50)).toBe("b");
    expect(TargetTracker.hit(rects, 150, 50, 40)).toBeNull();
  });
});
