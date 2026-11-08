// Offline evaluation of recorded gaze sessions.
//   npm run replay -- recordings/*.json            -> tables on stdout
//   npm run replay -- recordings/*.json --json out.json
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { SESSION_FORMAT, type RecordedSession } from "../src/record/format";
import { evaluateAll, prepare, type ResultRow } from "../src/eval/replay";

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const files = args.filter((a, i) => a.endsWith(".json") && !(jsonIdx >= 0 && i === jsonIdx + 1));

if (!files.length) {
  console.error("usage: npm run replay -- <session.json>... [--json results.json]");
  process.exit(1);
}

const sessions = files.map((f) => {
  const s = JSON.parse(readFileSync(f, "utf8")) as RecordedSession;
  if (s.format !== SESSION_FORMAT) throw new Error(`${f}: not a ${SESSION_FORMAT} file`);
  return prepare(s, basename(f, ".json"));
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
      "acc °": f1(r.stats.accuracyDeg),
      "acc x/y px": `${f0(r.stats.accuracyXPx)}/${f0(r.stats.accuracyYPx)}`,
      "prec SD °": f1(r.stats.precisionSdDeg),
      "prec S2S °": f1(r.stats.precisionS2sDeg),
      "6-chip hit": pct(r.stats.hitRate["6-chip (3x2)"]),
      "16-grid hit": pct(r.stats.hitRate["16-grid (4x4)"]),
      n: r.stats.nSamples,
    })),
  );
}

table("Personal calibration → validation points", rows.filter((r) => r.section === "personal"));
table("Drift (same calibration, later checks)", rows.filter((r) => r.section === "drift"));
table("Pooled prior, leave one participant out", rows.filter((r) => r.section === "pooled"));
console.log(
  "\nacc = offset of mean gaze from target; prec SD = spread around that mean; S2S = frame-to-frame jitter." +
    "\nhit = share of frames inside a cell-sized box centred on the target. Bars: 6-chip ≤1.5° & ≥95%, 16-grid ≤1.0° & ≥90%.",
);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
