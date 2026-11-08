// Offline replay of recorded sessions: rebuild features from raw landmarks, fit gaze
// sources on calibration targets, and score them on held-out targets. Pure; the CLI is
// scripts/replay.ts.
import { estimateDistanceCm, type ViewingGeometry } from "../gaze/accuracy";
import { GazeRegressor, type Sample } from "../gaze/regression";
import { KernelGazeRegressor } from "../gaze/kernel";
import { APP_DWELL, OLD_DWELL, simulateDwell, type DwellStats } from "./dwell";
import { medianPose, poseDeviation, poseOf, type PoseRef } from "../gaze/engine";
import { APP_9, APP_13, CORNERS_5, frameFeatures, pointKey, type RecordedSession } from "../record/format";
import { LAYOUTS, evaluate, type EvalStats, type PointPredictions, type XY } from "./metrics";

/** Frames for one target, as feature vectors. Targets are in viewport fractions so sessions can be pooled. */
export interface PreparedPoint {
  fx: number;
  fy: number;
  vw: number;
  vh: number;
  vectors: number[][];
  /** Head pose per frame (same order as vectors). */
  poses: PoseRef[];
  /**
   * Every frame from the moment the dot appeared (settle + collection), in time order, for
   * dwell simulation. v = null: no face; closed: both eyes shut (the app freezes the cursor).
   */
  timeline: { t: number; v: number[] | null; closed: boolean }[];
  /** performance.now() when the dot appeared and when it disappeared. */
  tShown: number;
  tEnd: number;
}

export interface PreparedSession {
  name: string;
  participant: string;
  session: RecordedSession;
  geometry: ViewingGeometry;
  cal: PreparedPoint[];
  val: PreparedPoint[];
  /** Drift checks keyed by minutes after validation. */
  drift: Map<number, PreparedPoint[]>;
  /** Fraction of collection frames with no face or closed eyes. */
  lostFrac: number;
}

const BLINK = 0.45;

export interface PrepareOptions {
  /** Use only frames at least this long after the dot appeared (ms), for calibration targets. */
  trainFromMs?: number;
  /** Same, for validation and drift targets. */
  testFromMs?: number;
}

export function prepare(session: RecordedSession, name: string, opts: PrepareOptions = {}): PreparedSession {
  const pts = session.targets.map((t) => ({ fx: t.fx, fy: t.fy, vw: t.vw, vh: t.vh, vectors: [] as number[][], poses: [] as PoseRef[], timeline: [] as PreparedPoint["timeline"], tShown: t.tShown, tEnd: t.tCollect1 }));
  const iris: number[] = [];
  let total = 0;
  let lost = 0;
  for (const f of session.frames) {
    if (f.t >= session.targets[f.ti].tShown) {
      const tf = frameFeatures(session, f);
      pts[f.ti].timeline.push({ t: f.t, v: tf ? tf.vector : null, closed: !!tf && tf.blinkL > BLINK && tf.blinkR > BLINK });
    }
    if (!f.c) continue;
    const target = session.targets[f.ti];
    const fromMs = target.segment === "cal" ? opts.trainFromMs : opts.testFromMs;
    if (fromMs !== undefined && f.t - target.tShown < fromMs) continue;
    total++;
    const feats = frameFeatures(session, f);
    // Same rule as the app: drop frames with no face or both eyes closed.
    if (!feats || (feats.blinkL > BLINK && feats.blinkR > BLINK)) {
      lost++;
      continue;
    }
    pts[f.ti].vectors.push(feats.vector);
    pts[f.ti].poses.push(poseOf(feats));
    if (Number.isFinite(feats.irisDiameter)) iris.push(feats.irisDiameter);
  }
  iris.sort((a, b) => a - b);
  const medianIris = iris[Math.floor(iris.length / 2)];
  const est = estimateDistanceCm(medianIris, session.meta.hfovDeg || 60);
  const geometry: ViewingGeometry = {
    screenDiagonalIn: session.meta.screenDiagonalIn || 14,
    screenWidthPx: session.env.screenWidth,
    screenHeightPx: session.env.screenHeight,
    distanceCm: session.meta.distanceCm || (Number.isFinite(est) ? est : 60),
  };
  const drift = new Map<number, PreparedPoint[]>();
  session.targets.forEach((t, i) => {
    if (t.segment !== "drift") return;
    if (!drift.has(t.atMin)) drift.set(t.atMin, []);
    drift.get(t.atMin)!.push(pts[i]);
  });
  return {
    name,
    participant: session.meta.participant || name,
    session,
    geometry,
    cal: pts.filter((_, i) => session.targets[i].segment === "cal"),
    val: pts.filter((_, i) => session.targets[i].segment === "val"),
    drift,
    lostFrac: total ? lost / total : NaN,
  };
}

export type Predictor = (features: number[]) => XY;

export type CalSet = "25pt" | "13pt" | "9pt" | "5pt";

export function calPoints(s: PreparedSession, set: CalSet): PreparedPoint[] {
  if (set === "25pt") return s.cal;
  const keep = set === "13pt" ? APP_13 : set === "9pt" ? APP_9 : CORNERS_5;
  return s.cal.filter((p) => keep.has(pointKey(p.fx, p.fy)));
}

export function toSamples(points: PreparedPoint[]): Sample[] {
  return points.flatMap((p) => p.vectors.map((features) => ({ features, x: p.fx, y: p.fy })));
}

export function ridge(points: PreparedPoint[], lambda: number): Predictor | null {
  const samples = toSamples(points);
  if (samples.length < 8) return null;
  const r = new GazeRegressor(lambda, 4);
  r.fit(samples);
  return (f) => r.predict(f);
}

/** RBF kernel ridge; γ=0.03, λ=1 was the best overall setting on the first three recordings. */
export function kernel(points: PreparedPoint[], lambda = 1, gamma = 0.03): Predictor | null {
  const samples = toSamples(points);
  if (samples.length < 8) return null;
  const k = new KernelGazeRegressor(lambda, gamma, 400);
  k.fit(samples);
  return (f) => k.predict(f);
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
  const vw = points[0]?.vw ?? 1;
  const vh = points[0]?.vh ?? 1;
  return evaluate(pp, vw, vh, s.geometry);
}

export interface ResultRow {
  section: "personal" | "drift" | "pooled";
  session: string;
  participant: string;
  source: string;
  calSet: string;
  testSet: string;
  stats: EvalStats;
  /** Median head-pose deviation from the calibration pose over the test frames (tolerances). */
  poseDev?: number;
}

function medianDeviation(points: PreparedPoint[], ref: PoseRef | null): number {
  if (!ref) return NaN;
  const d = points.flatMap((p) => p.poses.map((q) => poseDeviation(q, ref))).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : NaN;
}

/** The validation point nearest the screen centre, used to simulate a one-dot re-centre. */
function centreIndex(points: PreparedPoint[]): number {
  let best = 0;
  points.forEach((p, i) => {
    const d = Math.hypot(p.fx - 0.5, p.fy - 0.5);
    const b = points[best];
    const db = Math.hypot(b.fx - 0.5, b.fy - 0.5);
    if (d < db - 1e-9 || (Math.abs(d - db) < 1e-9 && p.fx + p.fy < b.fx + b.fy)) best = i;
  });
  return best;
}

export const LAMBDAS = [0.1, 1, 10, 100];
export const PRIOR_STRENGTHS = [1, 10, 100];

/** Per-session evaluation: each calibration set × lambda, scored on the validation points. */
export function personalRows(s: PreparedSession): ResultRow[] {
  const rows: ResultRow[] = [];
  const sets: CalSet[] = s.cal.length >= 25 ? ["25pt", "13pt", "9pt", "5pt"] : ["9pt", "5pt"];
  for (const set of sets)
    for (const lambda of LAMBDAS) {
      const p = ridge(calPoints(s, set), lambda);
      if (!p) continue;
      rows.push({
        section: "personal",
        session: s.name,
        participant: s.participant,
        source: `ridge λ=${lambda}`,
        calSet: set,
        testSet: "val",
        stats: score(s, s.val, p),
      });
    }
  for (const set of sets) {
    const p = kernel(calPoints(s, set));
    if (p) rows.push({ section: "personal", session: s.name, participant: s.participant, source: "kernel γ=0.03 λ=1", calSet: set, testSet: "val", stats: score(s, s.val, p) });
  }
  return rows;
}

/**
 * Drift: fit once on the densest calibration set, score validation then every drift check.
 * Each check is also scored after a simulated re-centre (offset from the point nearest the
 * centre, scored on the other points; the plain row uses the same other points).
 */
export function driftRows(s: PreparedSession, lambda = 1): ResultRow[] {
  if (!s.drift.size) return [];
  const set: CalSet = s.cal.length >= 25 ? "25pt" : "9pt";
  const p = ridge(calPoints(s, set), lambda);
  if (!p) return [];
  const ref = medianPose(calPoints(s, set).flatMap((q) => q.vectors.map((v, i) => ({ vector: v, headPos: [q.poses[i].noseX, q.poses[i].noseY, q.poses[i].faceH] }))));
  const base = { section: "drift" as const, session: s.name, participant: s.participant, calSet: set };
  const checks: [string, PreparedPoint[]][] = [["+0 min", s.val], ...[...s.drift.entries()].sort((a, b) => a[0] - b[0]).map(([m, pts]) => [`+${m} min`, pts] as [string, PreparedPoint[]])];
  const rows: ResultRow[] = [];
  for (const [label, pts] of checks) {
    const ci = centreIndex(pts);
    const centre = pts[ci];
    const rest = pts.filter((_, i) => i !== ci);
    const poseDev = medianDeviation(pts, ref);
    rows.push({ ...base, source: `ridge λ=${lambda}`, testSet: label, stats: score(s, rest, p), poseDev });
    if (!centre.vectors.length) continue;
    let dx = 0;
    let dy = 0;
    for (const v of centre.vectors) {
      const q = p(v);
      dx += (centre.fx - q.x) / centre.vectors.length;
      dy += (centre.fy - q.y) / centre.vectors.length;
    }
    rows.push({ ...base, source: `ridge λ=${lambda} + re-centre`, testSet: label, stats: score(s, rest, (v) => { const q = p(v); return { x: q.x + dx, y: q.y + dy }; }), poseDev });
  }
  return rows;
}

/**
 * Pooled prior test (leave one participant out): train on everyone else's calibration
 * data, then compare personal-only vs prior-only vs prior + a few of this person's points.
 */
export function pooledRows(all: PreparedSession[], lambda = 1): ResultRow[] {
  const people = [...new Set(all.map((s) => s.participant))];
  if (people.length < 2) return [];
  const rows: ResultRow[] = [];
  for (const held of all) {
    const others = all.filter((s) => s.participant !== held.participant);
    const priorSamples = others.flatMap((s) => toSamples(s.cal));
    if (priorSamples.length < 8) continue;
    const prior = new GazeRegressor(lambda, 4);
    prior.fit(priorSamples);
    const base = { section: "pooled" as const, session: held.name, participant: held.participant, testSet: "val" };
    const add = (source: string, calSet: string, p: Predictor | null) => p && rows.push({ ...base, source, calSet, stats: score(held, held.val, p) });

    add(`prior only (${others.length} sessions)`, "none", (f) => prior.predict(f));
    for (const set of ["9pt", "5pt"] as CalSet[]) {
      const pts = calPoints(held, set);
      const samples = toSamples(pts);
      if (!samples.length) continue;
      add(`personal ridge λ=${lambda}`, set, ridge(pts, lambda));
      // Bias-only: shift the prior by its mean residual on this person's points.
      let dx = 0;
      let dy = 0;
      for (const s of samples) {
        const q = prior.predict(s.features);
        dx += (s.x - q.x) / samples.length;
        dy += (s.y - q.y) / samples.length;
      }
      add("prior + offset", set, (f) => {
        const q = prior.predict(f);
        return { x: q.x + dx, y: q.y + dy };
      });
      for (const k of PRIOR_STRENGTHS) {
        const r = new GazeRegressor(lambda, 4);
        r.fitWithPrior(samples, prior, k * samples.length / Math.max(1, pts.length));
        add(`prior + fine-tune k=${k}`, set, (f) => r.predict(f));
      }
    }
  }
  return rows;
}

export interface DwellRow {
  session: string;
  source: string;
  calSet: string;
  layout: string;
  stats: DwellStats;
}

/** Dwell simulation with the app's settings, on validation + drift dots, for ridge and kernel. */
export function dwellRows(s: PreparedSession): DwellRow[] {
  const set: CalSet = s.cal.length >= 25 ? "25pt" : "9pt";
  const dots = [...s.val, ...[...s.drift.values()].flat()];
  const rows: DwellRow[] = [];
  const r = ridge(calPoints(s, set), 1);
  const k = kernel(calPoints(s, set));
  const combos: [string, Predictor | null, typeof APP_DWELL][] = [
    ["ridge + old dwell (before)", r, OLD_DWELL],
    ["kernel + new dwell (app now)", k, APP_DWELL],
  ];
  for (const [source, p, cfg] of combos) {
    if (!p) continue;
    for (const layout of LAYOUTS) rows.push({ session: s.name, source, calSet: set, layout: layout.name, stats: simulateDwell(dots, p, { ...cfg, layout }) });
  }
  return rows;
}

export function evaluateAll(sessions: PreparedSession[]): ResultRow[] {
  return [...sessions.flatMap(personalRows), ...sessions.flatMap((s) => driftRows(s)), ...pooledRows(sessions)];
}
