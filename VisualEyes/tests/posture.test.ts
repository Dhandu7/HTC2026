import { describe, expect, it } from "vitest";
import { clampToView, confidenceFromDeviation, medianPose, poseDeviation, postureAdvice, type PoseRef } from "../src/gaze/engine";
import { calibrationPoints } from "../src/ui/calibration";

const ref: PoseRef = { noseX: 0.5, noseY: 0.5, faceH: 0.4, yaw: 0, pitch: 0 };

describe("poseDeviation", () => {
  it("is 0 at the calibration pose and 1 at each tolerance edge", () => {
    expect(poseDeviation(ref, ref)).toBe(0);
    expect(poseDeviation({ ...ref, noseX: 0.5 + 0.3 * 0.4 }, ref)).toBeCloseTo(1);
    expect(poseDeviation({ ...ref, faceH: 0.4 * Math.exp(0.25) }, ref)).toBeCloseTo(1);
    expect(poseDeviation({ ...ref, yaw: 0.3 }, ref)).toBeCloseTo(1);
  });

  it("treats leaning back ~12% (seen in recordings) as ordinary", () => {
    const d = poseDeviation({ ...ref, faceH: 0.4 * 0.88 }, ref);
    expect(d).toBeLessThan(0.6);
    expect(confidenceFromDeviation(d)).toBeGreaterThan(0.95);
  });
});

describe("confidenceFromDeviation", () => {
  it("is full up to 0.5 tolerances and zero beyond 1.5", () => {
    expect(confidenceFromDeviation(0.5)).toBe(1);
    expect(confidenceFromDeviation(1)).toBeCloseTo(0.5);
    expect(confidenceFromDeviation(2)).toBe(0);
  });
});

describe("medianPose", () => {
  it("takes the per-component median", () => {
    const frames = [0.1, 0.2, 0.9].map((v) => ({ headPos: [v, 0.5, 0.4], vector: [0, 0, 0, 0, v, 0, 0] }));
    expect(medianPose(frames)!.noseX).toBe(0.2);
    expect(medianPose(frames)!.yaw).toBe(0.2);
  });
});

describe("calibrationPoints", () => {
  it("offers nested 9 / 13 / 25 point grids", () => {
    const p9 = calibrationPoints(9);
    const p13 = calibrationPoints(13);
    const p25 = calibrationPoints(25);
    expect([p9.length, p13.length, p25.length]).toEqual([9, 13, 25]);
    const k = (p: [number, number]) => p.join();
    expect(p9.every((p) => p13.map(k).includes(k(p)))).toBe(true);
    expect(p13.every((p) => p25.map(k).includes(k(p)))).toBe(true);
  });
});

describe("clampToView", () => {
  it("pins to the screen and flags points well outside it", () => {
    expect(clampToView(-10, 50, 100, 100)).toEqual({ x: 0, y: 50, offscreen: false });
    expect(clampToView(-100, 50, 100, 100).offscreen).toBe(true);
    expect(clampToView(50, 200, 100, 100)).toEqual({ x: 50, y: 100, offscreen: true });
  });
});

describe("postureAdvice", () => {
  it("says nothing near the calibration pose", () => {
    expect(postureAdvice({ ...ref, faceH: 0.42 }, ref)).toBeNull();
  });
  it("names the biggest change in the user's terms", () => {
    expect(postureAdvice({ ...ref, faceH: 0.4 * 1.4 }, ref)).toBe("Move back a little");
    expect(postureAdvice({ ...ref, faceH: 0.4 * 0.7 }, ref)).toBe("Move a little closer");
    // Image not mirrored: nose further right in the image = user moved to their left.
    expect(postureAdvice({ ...ref, noseX: 0.5 + 0.2 }, ref)).toBe("Move a little to your right");
    expect(postureAdvice({ ...ref, noseY: 0.5 + 0.2 }, ref)).toBe("Raise your head a little");
    expect(postureAdvice({ ...ref, yaw: 0.5 }, ref)).toBe("Turn your head back toward the screen");
  });
});
