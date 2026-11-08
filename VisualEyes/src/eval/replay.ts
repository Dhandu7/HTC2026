// Offline replay of recorded sessions: rebuild features from raw landmarks, fit the app's own
// model on the calibration dots, and score it on held-out dots. Pure; the CLI is
// scripts/replay.ts. Mirrors the app exactly: eye mode = 7 eye features, ridge λ=1; pointer mode =
// POINTER_MODEL (yaw + pitch, straight-line ridge, λ=1), per-dot outlier trimming.
import { estimateDistanceCm, type ViewingGeometry } from "../gaze/accuracy";
import { GazeRegressor, type Sample } from "../gaze/regression";
import { POINTER_FLOOR, SIMPLE_POINTER, SIMPLE_POINTER_FLOOR, simplePointerInput, type PointerModel } from "../gaze/engine";
import { chooseLambda } from "../gaze/regression";
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

/** The model the app fits in this pointer mode (pointer mode: the chosen pointer model, default "simple"). */
export function mainModel(s: PreparedSession, points = s.cal, pointerModel: PointerModel = "simple"): FittedModel | null {
  const samples = toSamples(points);
  if (samples.length < 8) return null;
  if (s.pointer === "pointer" && pointerModel === "simple") {
    const r = new GazeRegressor(SIMPLE_POINTER.lambda, SIMPLE_POINTER.quadCount, SIMPLE_POINTER_FLOOR);
    r.fit(samples.map((x) => ({ ...x, features: simplePointerInput(x.features) })));
    return { predict: (f) => r.predict(simplePointerInput(f)), lambda: SIMPLE_POINTER.lambda };
  }
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

/** Models to compare for a session: eye mode has one; pointer mode reports both pointer models side by side. */
function modelsFor(s: PreparedSession): [string, FittedModel | null][] {
  if (s.pointer !== "pointer") return [["eye", mainModel(s)]];
  return [
    ["simple", mainModel(s, s.cal, "simple")],
    ["original", mainModel(s, s.cal, "original")],
  ];
}

/** The app's model(s) scored on the check dots and on each drift check. */
export function accuracyRows(s: PreparedSession): ResultRow[] {
  if (!s.val.length) return [];
  return modelsFor(s).flatMap(([name, m]) => {
    if (!m) return [];
    const base = { session: s.name, participant: s.participant, pointer: s.pointer, source: `${name} (λ=${m.lambda})` };
    const rows: ResultRow[] = [{ ...base, testSet: "check dots", stats: score(s, s.val, m.predict) }];
    for (const [min, pts] of [...s.drift.entries()].sort((a, b) => a[0] - b[0])) rows.push({ ...base, testSet: `drift +${min} min`, stats: score(s, pts, m.predict) });
    return rows;
  });
}

/** Dwell simulation with the app's cursor and dwell settings for this pointer mode. */
export function dwellRows(s: PreparedSession): DwellRow[] {
  const cfg = s.pointer === "pointer" ? POINTER_DWELL : EYE_DWELL;
  const dots = [...s.val, ...[...s.drift.values()].flat()];
  return modelsFor(s).flatMap(([name, m]) =>
    m ? LAYOUTS.map((layout) => ({ session: s.name, pointer: s.pointer, source: name, layout: layout.name, stats: simulateDwell(dots, m.predict, { ...cfg, layout }) })) : [],
  );
}
