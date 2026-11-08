// Offline replay of recorded sessions: rebuild features from raw landmarks, fit the app's own
// model on the calibration dots, and score it on held-out dots. Pure; the CLI is
// scripts/replay.ts. Mirrors main exactly: eye mode = 7 eye features, ridge λ=1; pointer mode =
// 10 pointer features, POINTER_FLOOR, λ by leave-one-dot-out CV, per-dot outlier trimming.
import { estimateDistanceCm, type ViewingGeometry } from "../gaze/accuracy";
import { GazeRegressor, chooseLambda, type Sample } from "../gaze/regression";
import { POINTER_FLOOR } from "../gaze/engine";
import { eyeVector, pointerVector } from "../gaze/features";
import { trimOutlierIdx } from "../ui/calibration";
import { frameFeatures, pointKey, type PointerMode, type RecordedSession } from "../record/format";
import { EYE_DWELL, POINTER_DWELL, simulateDwell, type DwellStats } from "./dwell";
import { LAYOUTS, evaluate, type EvalStats, type PointPredictions, type XY } from "./metrics";

/** Frames for one target, as model input vectors. Targets are in viewport fractions. */
export interface PreparedPoint {
  fx: number;
  fy: number;
  vw: number;
  vh: number;
  vectors: number[][];
  /** Every frame from the moment the dot appeared, in time order, for dwell simulation. */
  timeline: { t: number; v: number[] | null; closed: boolean }[];
  tShown: number;
  tEnd: number;
}

export interface PreparedSession {
  name: string;
  participant: string;
  pointer: PointerMode;
  /** Pointer the file was recorded with (differs from `pointer` when forced with asPointer). */
  recordedPointer: PointerMode;
  session: RecordedSession;
  geometry: ViewingGeometry;
  cal: PreparedPoint[];
  val: PreparedPoint[];
  /** Drift checks keyed by minutes after validation. */
  drift: Map<number, PreparedPoint[]>;
  /** Fraction of collection frames with no face (or, in eye mode, closed eyes). */
  lostFrac: number;
}

export interface PrepareOptions {
  /** Score with the pointer pipeline even if the file was recorded in eye mode (plumbing tests). */
  asPointer?: boolean;
}

const BLINK = 0.45;

export function prepare(session: RecordedSession, name: string, opts: PrepareOptions = {}): PreparedSession {
  const recordedPointer: PointerMode = session.meta.pointer ?? "eye";
  const pointer: PointerMode = opts.asPointer ? "pointer" : recordedPointer;
  const toVec = pointer === "pointer" ? pointerVector : eyeVector;
  const pts: PreparedPoint[] = session.targets.map((t) => ({ fx: t.fx, fy: t.fy, vw: t.vw, vh: t.vh, vectors: [], timeline: [], tShown: t.tShown, tEnd: t.tCollect1 }));
  const iris: number[] = [];
  let total = 0;
  let lost = 0;
  for (const f of session.frames) {
    const target = session.targets[f.ti];
    if (f.t < target.tShown) continue;
    const feats = frameFeatures(session, f);
    const closed = !!feats && feats.blinkL > BLINK && feats.blinkR > BLINK;
    pts[f.ti].timeline.push({ t: f.t, v: feats ? toVec(feats.vector) : null, closed });
    if (!f.c) continue;
    total++;
    // Same rule as the app's calibration: no face = no sample; eye mode also drops closed eyes.
    if (!feats || (pointer === "eye" && closed)) {
      lost++;
      continue;
    }
    pts[f.ti].vectors.push(toVec(feats.vector));
    if (Number.isFinite(feats.irisDiameter)) iris.push(feats.irisDiameter);
  }
  iris.sort((a, b) => a - b);
  const est = estimateDistanceCm(iris[Math.floor(iris.length / 2)], session.meta.hfovDeg || 60);
  const geometry: ViewingGeometry = {
    screenDiagonalIn: session.meta.screenDiagonalIn || 14,
    screenWidthPx: session.env.screenWidth,
    screenHeightPx: session.env.screenHeight,
    distanceCm: session.meta.distanceCm || (Number.isFinite(est) ? est : 60),
  };
  // A dot shown again (the app's re-check of the worst dots) replaces the earlier look.
  const calByKey = new Map<string, PreparedPoint>();
  const val: PreparedPoint[] = [];
  const drift = new Map<number, PreparedPoint[]>();
  session.targets.forEach((t, i) => {
    if (t.segment === "cal") calByKey.set(pointKey(t.fx, t.fy), pts[i]);
    else if (t.segment === "val") val.push(pts[i]);
    else (drift.get(t.atMin) ?? drift.set(t.atMin, []).get(t.atMin)!).push(pts[i]);
  });
  return {
    name,
    participant: session.meta.participant || name,
    pointer,
    recordedPointer,
    session,
    geometry,
    cal: [...calByKey.values()],
    val,
    drift,
    lostFrac: total ? lost / total : NaN,
  };
}

export type Predictor = (features: number[]) => XY;

/** Calibration samples after the app's per-dot outlier trimming, in viewport fractions. */
export function toSamples(points: PreparedPoint[]): Sample[] {
  return points.flatMap((p) => trimOutlierIdx(p.vectors).map((i) => ({ features: p.vectors[i], x: p.fx, y: p.fy })));
}

export interface FittedModel {
  predict: Predictor;
  lambda: number;
}

/** The model main fits in this pointer mode. */
export function mainModel(s: PreparedSession, points = s.cal): FittedModel | null {
  const samples = toSamples(points);
  if (samples.length < 8) return null;
  if (s.pointer === "pointer") {
    const cv = chooseLambda(samples, 4, POINTER_FLOOR);
    const lambda = Number.isFinite(cv.medianErrPx) ? cv.lambda : 1;
    const r = new GazeRegressor(lambda, 4, POINTER_FLOOR);
    r.fit(samples);
    return { predict: (f) => r.predict(f), lambda };
  }
  const r = new GazeRegressor(1.0, 4);
  r.fit(samples);
  return { predict: (f) => r.predict(f), lambda: 1 };
}

export function score(s: PreparedSession, points: PreparedPoint[], predict: Predictor): EvalStats {
  // Predictions are in viewport fractions; convert to px with each target's viewport.
  const pp: PointPredictions[] = points.map((p) => ({
    target: { x: p.fx * p.vw, y: p.fy * p.vh },
    preds: p.vectors.map((v) => {
      const q = predict(v);
      return { x: q.x * p.vw, y: q.y * p.vh };
    }),
  }));
  return evaluate(pp, points[0]?.vw ?? 1, points[0]?.vh ?? 1, s.geometry);
}

export interface ResultRow {
  session: string;
  participant: string;
  pointer: PointerMode;
  source: string;
  testSet: string;
  stats: EvalStats;
}

export interface DwellRow {
  session: string;
  pointer: PointerMode;
  source: string;
  layout: string;
  stats: DwellStats;
}

/** Main's model scored on the check dots and on each drift check. */
export function accuracyRows(s: PreparedSession): ResultRow[] {
  const m = mainModel(s);
  if (!m || !s.val.length) return [];
  const source = `main ${s.pointer} model (λ=${m.lambda})`;
  const base = { session: s.name, participant: s.participant, pointer: s.pointer, source };
  const rows: ResultRow[] = [{ ...base, testSet: "check dots", stats: score(s, s.val, m.predict) }];
  for (const [min, pts] of [...s.drift.entries()].sort((a, b) => a[0] - b[0])) rows.push({ ...base, testSet: `drift +${min} min`, stats: score(s, pts, m.predict) });
  return rows;
}

/** Dwell simulation with main's cursor and dwell settings for this pointer mode. */
export function dwellRows(s: PreparedSession): DwellRow[] {
  const m = mainModel(s);
  if (!m) return [];
  const cfg = s.pointer === "pointer" ? POINTER_DWELL : EYE_DWELL;
  const dots = [...s.val, ...[...s.drift.values()].flat()];
  return LAYOUTS.map((layout) => ({ session: s.name, pointer: s.pointer, source: `main ${s.pointer} (dwell ${cfg.dwellMs} ms)`, layout: layout.name, stats: simulateDwell(dots, m.predict, { ...cfg, layout }) }));
}
