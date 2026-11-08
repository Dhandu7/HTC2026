// Offline evaluation of recorded gaze sessions.
//   npm run replay -- recordings/*.json            -> tables on stdout
//   npm run replay -- recordings/*.json --json out.json
//   --train-from 1100 / --test-from 1100: only use frames this many ms after each dot appeared
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { SESSION_FORMAT, type RecordedSession } from "../src/record/format";
import { dwellRows, evaluateAll, prepare, type ResultRow } from "../src/eval/replay";

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const trainFromMs = opt("--train-from");
const testFromMs = opt("--test-from");
const files = args.filter((a, i) => a.endsWith(".json") && !(jsonIdx >= 0 && i === jsonIdx + 1));

if (!files.length) {
  console.error("usage: npm run replay -- <session.json>... [--json results.json]");
  process.exit(1);
}

const sessions = files.map((f) => {
  const s = JSON.parse(readFileSync(f, "utf8")) as RecordedSession;
  if (s.format !== SESSION_FORMAT) throw new Error(`${f}: not a ${SESSION_FORMAT} file`);
  return prepare(s, basename(f, ".json"), { trainFromMs, testFromMs });
});

for (const s of sessions) {
  const m = s.session.meta;
  console.log(
    `• ${s.name}: ${m.participant}, ${m.mode}, glasses=${m.glasses}, lighting="${m.lighting}", ` +
      `${s.geometry.distanceCm.toFixed(0)} cm${m.distanceCm ? "" : " (est.)"}, ${m.screenDiagonalIn}" ${s.session.env.screenWidth}x${s.session.env.screenHeight}, ` +
      `camera ${s.session.env.videoWidth}x${s.session.env.videoHeight}, ${(s.lostFrac * 100).toFixed(1)}% frames lost (no face / blink)`,
  );
}

const rows = evaluateAll(sessions);
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "–");
const f0 = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "–");
const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(0)}%` : "–");

function table(title: string, rs: ResultRow[]) {
  if (!rs.length) return;
  console.log(`\n## ${title}`);
  console.table(
    rs.map((r) => ({
      session: r.session.length > 28 ? `…${r.session.slice(-27)}` : r.session,
      source: r.source,
      cal: r.calSet,
      test: r.testSet,
      "6-chip hit": pct(r.stats.hitRate["6-chip (3x2)"]),
      "16-grid hit": pct(r.stats.hitRate["16-grid (4x4)"]),
      "acc ° (est.)": f1(r.stats.accuracyDeg),
      "acc x/y px": `${f0(r.stats.accuracyXPx)}/${f0(r.stats.accuracyYPx)}`,
      "prec SD °": f1(r.stats.precisionSdDeg),
      "prec S2S °": f1(r.stats.precisionS2sDeg),
      ...(r.poseDev !== undefined ? { "head moved": f1(r.poseDev) } : {}),
      n: r.stats.nSamples,
    })),
  );
}

table("Personal calibration → validation points", rows.filter((r) => r.section === "personal"));
table("Drift (same calibration, later checks; 'head moved' = median pose deviation in tolerances, posture warning above ~1)", rows.filter((r) => r.section === "drift"));
table("Pooled prior, leave one participant out", rows.filter((r) => r.section === "pooled"));
const dwell = sessions.flatMap(dwellRows);
console.log("\n## Dwell simulation (before vs. app now), validation + drift dots");
console.table(
  dwell.map((r) => ({
    session: r.session.length > 28 ? `…${r.session.slice(-27)}` : r.session,
    source: r.source,
    cal: r.calSet,
    layout: r.layout,
    "correct": pct(r.stats.correct),
    "wrong": pct(r.stats.wrong),
    "none (dot gone)": pct(r.stats.none),
    "time to select": Number.isFinite(r.stats.meanTimeMs) ? `${(r.stats.meanTimeMs / 1000).toFixed(2)} s` : "–",
    dots: r.stats.n,
  })),
);
console.log(
  "\ndwell: did looking at a dot select the button centred on it? 'none' = nothing selected before the dot vanished (2.3 s after it appeared in recordings, 1.9 s in saved calibrations, incl. eye travel)." +
    "\nacc = offset of mean gaze from target; prec SD = spread around that mean; S2S = frame-to-frame jitter." +
    "\nhit = share of frames inside a cell-sized box centred on the target (distance-independent: the main metric)." +
    "\n° figures depend on the estimated viewing distance and the screen-size setting. Bars: 6-chip ≥95% hits (≈≤1.5°), 16-grid ≥90% (≈≤1.0°).",
);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ rows, dwell }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
