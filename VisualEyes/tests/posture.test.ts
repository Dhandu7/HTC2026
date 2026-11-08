import { describe, expect, it } from "vitest";
import { confidenceFromDeviation, medianPose, poseDeviation, type PoseRef } from "../src/gaze/engine";
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
