import { describe, expect, it } from "vitest";
import { b64ToF32, buildProtocol, collectMsFor, f32ToB64, videoTimeAt } from "../src/record/format";
import { evaluate } from "../src/eval/metrics";
import { accuracyRows, dwellRows, mainModel, prepare, toSamples } from "../src/eval/replay";
import { buttonsAround } from "../src/eval/dwell";
import { POINTER_INDEX, pointerVector } from "../src/gaze/features";
import { trimOutlierIdx } from "../src/ui/calibration";
import { fakeSession } from "./synthetic";

const G = { screenDiagonalIn: 14, screenWidthPx: 1512, screenHeightPx: 982, distanceCm: 60 };

describe("format", () => {
  it("round-trips Float32 arrays through base64", () => {
    const a = Float32Array.from({ length: 1434 }, (_, i) => Math.sin(i) * 0.7);
    expect(Array.from(b64ToF32(f32ToB64(a)))).toEqual(Array.from(a));
  });

  it("builds the protocols", () => {
    expect(buildProtocol("full").filter((t) => t.segment === "drift")).toHaveLength(48);
    expect(buildProtocol("quick").filter((t) => t.segment === "val")).toHaveLength(8);
    expect(buildProtocol("short").filter((t) => t.segment === "cal")).toHaveLength(9);
  });

  it("keeps pointer-mode check dots up long enough for the 2 s dwell", () => {
    expect(collectMsFor("val", "pointer")).toBeGreaterThanOrEqual(2500);
    expect(collectMsFor("cal", "pointer")).toBe(collectMsFor("cal", "eye"));
  });

  it("maps wall clock to video time across paused intervals", () => {
    const tl = [{ t0: 1000, t1: 3000 }, { t0: 10000, t1: 11000 }];
    expect(videoTimeAt(tl, 2000)).toBeCloseTo(1);
    expect(videoTimeAt(tl, 10500)).toBeCloseTo(2.5);
  });
});

describe("shared feature mapping", () => {
  it("picks the 10 pointer features the app uses", () => {
    const v = Array.from({ length: 15 }, (_, i) => i * 10);
    expect(pointerVector(v)).toEqual([...POINTER_INDEX].map((i) => i * 10));
  });

  it("trims a glance away at one dot, like the app's calibration", () => {
    const vs = Array.from({ length: 20 }, (_, i) => [0.01 * (i % 3), 0.01 * (i % 2)]);
    vs[7] = [5, 5];
    expect(trimOutlierIdx(vs)).not.toContain(7);
  });
});

describe("evaluate", () => {
  it("separates accuracy (offset) from precision (spread)", () => {
    const preds = Array.from({ length: 10 }, (_, i) => ({ x: 130 + (i % 2 ? 10 : -10), y: 100 }));
    const s = evaluate([{ target: { x: 100, y: 100 }, preds }], 1500, 1000, G);
    expect(s.accuracyPx).toBeCloseTo(30);
    expect(s.precisionSdPx).toBeCloseTo(10);
    expect(s.hitRate["6-chip (3x2)"]).toBe(1);
  });
});

describe("replay, eye pointer", () => {
  it("uses main's eye model and scores held-out dots", () => {
    const s = prepare(fakeSession("a", "full", { gain: 1, bias: 0 }), "a");
    expect(s.pointer).toBe("eye");
    expect(mainModel(s)!.lambda).toBe(1);
    const rows = accuracyRows(s);
    expect(rows.map((r) => r.testSet)).toEqual(["check dots", "drift +2 min", "drift +5 min", "drift +10 min"]);
    expect(rows[0].stats.hitRate["6-chip (3x2)"]).toBeGreaterThan(0.9);
  });
});

describe("replay, pointer tracker", () => {
  const s = prepare(fakeSession("h", "quick", { gain: 1, bias: 0 }, 3, "pointer"), "h");

  it("records all 10 pointer features but fits the app's yaw + pitch straight-line model", () => {
    expect(s.pointer).toBe("pointer");
    expect(toSamples(s.cal)[0].features).toHaveLength(10);
    expect(mainModel(s)!.lambda).toBe(1);
  });

  it("points at held-out dots and selects them with the 2 s dwell", () => {
    expect(accuracyRows(s)[0].stats.hitRate["6-chip (3x2)"]).toBeGreaterThan(0.9);
    const six = dwellRows(s).find((r) => r.layout.startsWith("6"))!;
    expect(six.stats.n).toBe(8);
    expect(six.stats.correct).toBeGreaterThan(0.85);
  });

  it("can force the pointer pipeline on an eye recording (plumbing test)", () => {
    const forced = prepare(fakeSession("a", "quick", { gain: 1, bias: 0 }), "a", { asPointer: true });
    expect(forced.pointer).toBe("pointer");
    expect(forced.recordedPointer).toBe("eye");
  });

  it("lays buttons out around the dot", () => {
    expect(buttonsAround(750, 450, 1500, 900, { name: "6", cols: 3, rows: 2 }, 0).some((r) => r.id === "0,0")).toBe(true);
  });
});

describe("tracking loss", async () => {
  const { trackingLost } = await import("../src/eval/replay");
  it("flags a session whose face vanished on half the check dots, and keeps a clean one", () => {
    const raw = fakeSession("h", "quick", { gain: 1, bias: 0 }, 3, "pointer");
    expect(trackingLost(prepare(raw, "clean"))).toBe(false);
    const valIdx = raw.targets.map((t, i) => (t.segment === "val" ? i : -1)).filter((i) => i >= 0).slice(0, 4);
    const broken = { ...raw, frames: raw.frames.map((f) => (valIdx.includes(f.ti) ? { ...f, lm: null, bs: null } : f)) };
    const s = prepare(broken, "broken");
    expect(s.lostCheckDots).toBe(4);
    expect(trackingLost(s)).toBe(true);
  });
});
