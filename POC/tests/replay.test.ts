import { describe, expect, it } from "vitest";
import { GazeRegressor } from "../src/gaze/regression";
import {
  b64ToF32,
  buildProtocol,
  f32ToB64,
  videoTimeAt,
} from "../src/record/format";
import { evaluate } from "../src/eval/metrics";
import { driftRows, personalRows, pooledRows, prepare } from "../src/eval/replay";
import { fakeSession } from "./synthetic";

const G = { screenDiagonalIn: 14, screenWidthPx: 1512, screenHeightPx: 982, distanceCm: 60 };

describe("format", () => {
  it("round-trips Float32 arrays through base64", () => {
    const a = Float32Array.from({ length: 1434 }, (_, i) => Math.sin(i) * 0.7);
    expect(Array.from(b64ToF32(f32ToB64(a)))).toEqual(Array.from(a));
  });

  it("builds the full and short protocols", () => {
    const full = buildProtocol("full");
    expect(full.filter((t) => t.segment === "cal")).toHaveLength(25);
    expect(full.filter((t) => t.segment === "val")).toHaveLength(16);
    expect(full.filter((t) => t.segment === "drift")).toHaveLength(48);
    const quick = buildProtocol("quick");
    expect(quick.filter((t) => t.segment === "cal")).toHaveLength(25);
    expect(quick.filter((t) => t.segment === "val")).toHaveLength(8);
    expect(quick.filter((t) => t.segment === "drift")).toHaveLength(0);
    const short = buildProtocol("short");
    expect(short.filter((t) => t.segment === "cal")).toHaveLength(9);
    expect(short.filter((t) => t.segment === "drift")).toHaveLength(0);
  });

  it("maps wall clock to video time across paused intervals", () => {
    const tl = [{ t0: 1000, t1: 3000 }, { t0: 10000, t1: 11000 }];
    expect(videoTimeAt(tl, 2000)).toBeCloseTo(1);
    expect(videoTimeAt(tl, 10500)).toBeCloseTo(2.5);
    expect(videoTimeAt(tl, 5000)).toBeNaN();
  });
});

describe("evaluate", () => {
  it("separates accuracy (offset) from precision (spread)", () => {
    // Samples alternate ±10 px in x around a point offset 30 px right of the target.
    const preds = Array.from({ length: 10 }, (_, i) => ({ x: 130 + (i % 2 ? 10 : -10), y: 100 }));
    const s = evaluate([{ target: { x: 100, y: 100 }, preds }], 1500, 1000, G);
    expect(s.accuracyPx).toBeCloseTo(30);
    expect(s.accuracyXPx).toBeCloseTo(30);
    expect(s.accuracyYPx).toBeCloseTo(0);
    expect(s.precisionSdPx).toBeCloseTo(10);
    expect(s.precisionS2sPx).toBeCloseTo(20);
    expect(s.hitRate["6-chip (3x2)"]).toBe(1);
  });
});

describe("GazeRegressor.fitWithPrior", () => {
  const mk = (bias: number) =>
    [-1, -0.5, 0, 0.5, 1].flatMap((a) => [-1, 0, 1].map((b) => ({ features: [a, b, a * b, 0.1 * a], x: 0.5 + 0.3 * a + bias, y: 0.5 + 0.3 * b })));
  it("follows the prior when strong, and learns a per-user offset through the free intercept", () => {
    const prior = new GazeRegressor(1, 2);
    prior.fit(mk(0));
    const few = mk(0.1).filter((_, i) => i % 5 === 0);
    const r = new GazeRegressor(1, 2);
    r.fitWithPrior(few, prior, 1e6);
    const p = r.predict([0.5, 0.5, 0.25, 0.05]);
    const q = prior.predict([0.5, 0.5, 0.25, 0.05]);
    expect(p.x - q.x).toBeCloseTo(0.1, 2);
    expect(p.y - q.y).toBeCloseTo(0, 2);
  });
});

describe("replay", () => {
  it("recovers gaze on held-out points of a synthetic full session", () => {
    const p = prepare(fakeSession("a", "full", { gain: 1, bias: 0 }), "a");
    expect(p.cal).toHaveLength(25);
    expect(p.val).toHaveLength(16);
    expect(p.lostFrac).toBe(0);
    const rows = personalRows(p);
    const best = rows.find((r) => r.calSet === "25pt" && r.source.startsWith("ridge λ=0.1"))!;
    expect(best.stats.accuracyPx).toBeLessThan(40);
    expect(best.stats.hitRate["6-chip (3x2)"]).toBeGreaterThan(0.95);
    expect(rows.some((r) => r.calSet === "13pt")).toBe(true);
    const drift = driftRows(p);
    expect([...new Set(drift.map((r) => r.testSet))]).toEqual(["+0 min", "+2 min", "+5 min", "+10 min"]);
    expect(drift.some((r) => r.source.endsWith("+ re-centre"))).toBe(true);
  });

  it("runs the leave-one-participant-out pooled comparison", () => {
    const team = [prepare(fakeSession("a", "full", { gain: 1, bias: 0 }, 3), "a"), prepare(fakeSession("b", "full", { gain: 1.05, bias: 0 }, 5), "b")];
    const stranger = prepare(fakeSession("s", "short", { gain: 1, bias: 0.15 }, 7), "s");
    const rows = pooledRows([...team, stranger]).filter((r) => r.participant === "s");
    const priorOnly = rows.find((r) => r.source.startsWith("prior only"))!;
    const offset = rows.find((r) => r.source === "prior + offset" && r.calSet === "9pt")!;
    // The stranger's eyes are shifted; a 9-point offset correction must beat the uncorrected prior.
    expect(offset.stats.accuracyPx).toBeLessThan(priorOnly.stats.accuracyPx);
    expect(rows.some((r) => r.source.startsWith("prior + fine-tune"))).toBe(true);
  });
});

describe("dwell simulation", () => {
  it("selects the button under each dot on a clean synthetic session", async () => {
    const { simulateDwell, APP_DWELL, buttonsAround } = await import("../src/eval/dwell");
    const { calPoints, ridge } = await import("../src/eval/replay");
    const p = prepare(fakeSession("a", "full", { gain: 1, bias: 0 }), "a");
    const predict = ridge(calPoints(p, "25pt"), 0.1)!;
    const d = simulateDwell(p.val, predict, { ...APP_DWELL, dwellMs: 300, layout: { name: "6", cols: 3, rows: 2 } });
    expect(d.correct).toBeGreaterThan(0.9);
    expect(buttonsAround(750, 450, 1500, 900, { name: "6", cols: 3, rows: 2 }, 0).some((r) => r.id === "0,0")).toBe(true);
  });
});
