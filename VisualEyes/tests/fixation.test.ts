import { describe, expect, it } from "vitest";
import { checkPosition, cleanFixation, scatteredDots } from "../src/gaze/fixation";

// Deterministic small jitter around a point.
const steadyFrames = (n: number, c: number[], jitter = 0.002) =>
  Array.from({ length: n }, (_, i) => c.map((v, j) => v + jitter * Math.sin(i * 1.7 + j)));

describe("cleanFixation", () => {
  it("keeps a steady look", () => {
    const r = cleanFixation(steadyFrames(25, [0.5, 0.1, 0.2, -0.1, 0, 0, 0.3]));
    expect(r.steady).toBe(true);
    expect(r.kept).toHaveLength(25);
  });
  it("drops a glance away and a half-blink glitch", () => {
    const frames = steadyFrames(25, [0.5, 0.1, 0.2, -0.1]);
    frames[7] = [0.8, 0.1, 0.6, -0.1]; // looked away
    frames[15] = [0.5, -0.4, 0.2, -0.6]; // eyelid half closed: vertical features jump
    const r = cleanFixation(frames);
    expect(r.kept).not.toContain(7);
    expect(r.kept).not.toContain(15);
    expect(r.kept).toHaveLength(23);
    expect(r.steady).toBe(true);
  });
  it("spots a dot whose look wandered, compared with the other dots", () => {
    const dots = [0, 1, 2, 3, 4].map((i) => cleanFixation(steadyFrames(25, [0.3 + i * 0.1, 0.1, 0.2, -0.1])));
    // Dot 5: half the time on the dot, half somewhere else.
    dots.push(cleanFixation([...steadyFrames(12, [0.5, 0.1, 0.2, -0.1]), ...steadyFrames(12, [0.8, 0.3, 0.6, 0.2])]));
    expect(scatteredDots(dots.map((d) => d.spread))).toEqual([5]);
  });
  it("flags too few frames (face lost, eyes closed)", () => {
    expect(cleanFixation(steadyFrames(4, [0.5, 0.1, 0.2, -0.1])).steady).toBe(false);
  });
});

describe("checkPosition", () => {
  const ref: [number, number, number] = [0.5, 0.45, 0.4];
  it("is fine near the calibration position", () => {
    expect(checkPosition(ref, [0.52, 0.47, 0.42]).ok).toBe(true);
  });
  it("asks the user to move back, or closer", () => {
    expect(checkPosition(ref, [0.5, 0.45, 0.5]).advice).toBe("Move back a little");
    expect(checkPosition(ref, [0.5, 0.45, 0.3]).advice).toBe("Move a little closer");
  });
  it("gives sideways directions in the user's own left/right", () => {
    // Moving to their left shows up as a larger x in the (unmirrored) camera image.
    expect(checkPosition(ref, [0.62, 0.45, 0.4]).advice).toBe("Move a little to your right");
    expect(checkPosition(ref, [0.38, 0.45, 0.4]).advice).toBe("Move a little to your left");
  });
  it("asks to raise or lower the chin", () => {
    expect(checkPosition(ref, [0.5, 0.56, 0.4]).advice).toBe("Raise your chin a little");
    expect(checkPosition(ref, [0.5, 0.34, 0.4]).advice).toBe("Lower your chin a little");
  });
});
