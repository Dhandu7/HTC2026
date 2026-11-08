// Offline evaluation of recorded eye / pointer-tracker sessions.
//   npm run replay -- recordings/*.json                 -> per-recording tables + mean per pointer mode
//   npm run replay -- recordings/*.json --json out.json
//   --as-pointer: score every file with the pointer pipeline (eye recordings = plumbing test only)
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { SESSION_FORMAT, type RecordedSession } from "../src/record/format";
import { accuracyRows, dwellRows, prepare, targetRows, trackingLost, type DwellRow, type ResultRow } from "../src/eval/replay";

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const asPointer = args.includes("--as-pointer");
const files = args.filter((a, i) => a.endsWith(".json") && !(jsonIdx >= 0 && i === jsonIdx + 1));

if (!files.length) {
  console.error("usage: npm run replay -- <session.json>... [--as-pointer] [--json results.json]");
  process.exit(1);
}

const sessions = files.map((f) => {
  const s = JSON.parse(readFileSync(f, "utf8")) as RecordedSession;
  if (s.format !== SESSION_FORMAT) throw new Error(`${f}: not a ${SESSION_FORMAT} file`);
  return prepare(s, basename(f, ".json"), { asPointer });
});

for (const s of sessions) {
  const m = s.session.meta;
  console.log(
    `• ${s.name}: ${m.participant}, ${s.pointer} mode${s.pointer !== s.recordedPointer ? ` (recorded as ${s.recordedPointer})` : ""}, ${m.mode}, ` +
      `${s.cal.length} cal + ${s.val.length} check dots, ${s.session.env.screenWidth}x${s.session.env.screenHeight}, ` +
      `${(s.lostFrac * 100).toFixed(1)}% frames lost` +
      (trackingLost(s) ? `  ⚠ EXCLUDED: face lost on ${s.lostCheckDots} of ${s.val.length} check dots` : ""),
  );
}
const scored = sessions.filter((s) => !trackingLost(s));

const acc = scored.flatMap(accuracyRows);
const dwell = scored.flatMap(dwellRows);
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "–");
const f0 = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "–");
const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(0)}%` : "–");
const short = (n: string) => (n.length > 30 ? `…${n.slice(-29)}` : n);

console.log("\n## Accuracy on held-out dots (the app's model; pointer recordings show 'simple' (app) vs 'original')");
console.table(
  acc.map((r) => ({
    session: short(r.session),
    pointer: r.pointer,
    model: r.source,
    test: r.testSet,
    "4-chip hit": pct(r.stats.hitRate["4-chip (2x2)"]),
    "6-chip hit": pct(r.stats.hitRate["6-chip (3x2)"]),
    "16-grid hit": pct(r.stats.hitRate["16-grid (4x4)"]),
    "offset x/y px": `${f0(r.stats.accuracyXPx)}/${f0(r.stats.accuracyYPx)}`,
    "jitter S2S px": f0(r.stats.precisionS2sPx),
    "acc ° (est.)": f1(r.stats.accuracyDeg),
    n: r.stats.nSamples,
  })),
);

console.log("\n## Dwell simulation (main's cursor pipeline and 2 s dwell; only dots shown long enough)");
console.table(
  dwell.map((r) => ({
    session: short(r.session),
    pointer: r.pointer,
    model: r.source,
    layout: r.layout,
    correct: pct(r.stats.correct),
    wrong: pct(r.stats.wrong),
    none: pct(r.stats.none),
    "time to select": Number.isFinite(r.stats.meanTimeMs) ? `${(r.stats.meanTimeMs / 1000).toFixed(2)} s` : "–",
    dots: r.stats.n,
  })),
);

// Closed-loop Target test files (pointer visible): what using the app feels like.
const targets = scored.flatMap(targetRows);
if (targets.length) {
  console.log("\n## Target test (closed loop: pointer visible, user steers onto each button)");
  console.table(
    targets.map((r) => ({
      session: short(r.session),
      pointer: r.pointer,
      layout: r.layout,
      correct: pct(r.correct),
      wrong: pct(r.wrong),
      timeout: pct(r.timeout),
      "corners correct": pct(r.cornerCorrect),
      "median time": Number.isFinite(r.medianTimeMs) ? `${(r.medianTimeMs / 1000).toFixed(1)} s` : "–",
      trials: r.trials,
    })),
  );
  const layouts = [...new Set(targets.map((r) => `${r.pointer}|${r.layout}`))];
  console.log("Mean across Target-test files:");
  console.table(
    layouts.map((k) => {
      const [pointer, layout] = k.split("|");
      const t = targets.filter((r) => r.pointer === pointer && r.layout === layout);
      const m = (f: (r: (typeof t)[number]) => number) => {
        const v = t.map(f).filter(Number.isFinite);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
      };
      return { pointer, layout, files: t.length, correct: pct(m((r) => r.correct)), wrong: pct(m((r) => r.wrong)), timeout: pct(m((r) => r.timeout)), "corners correct": pct(m((r) => r.cornerCorrect)) };
    }),
  );
}

// Mean across recordings, per pointer mode (each recording weighs equally).
const mean = (xs: number[]) => {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};
console.log("\n## Mean across recordings");
const modelOf = (src: string) => src.split(" (")[0];
const groups = [...new Set(acc.map((r) => `${r.pointer}|${modelOf(r.source)}`))];
const summary = groups.flatMap((g) => {
  const [pointer, model] = g.split("|");
  const a = acc.filter((r) => r.pointer === pointer && modelOf(r.source) === model && r.testSet === "check dots");
  if (!a.length) return [];
  const d = (layout: string, k: "correct" | "wrong") =>
    mean(dwell.filter((r) => r.pointer === pointer && modelOf(r.source) === model && r.layout.startsWith(layout)).map((r) => r.stats[k]));
  const better = pointer === "pointer" && model === "simple"
    ? `${a.filter((r) => { const o = acc.find((x) => x.session === r.session && x.testSet === r.testSet && modelOf(x.source) === "original"); return o && r.stats.hitRate["6-chip (3x2)"] > o.stats.hitRate["6-chip (3x2)"]; }).length} of ${a.length}`
    : "";
  return [
    {
      pointer,
      model,
      "beats original (6-chip)": better,
      recordings: a.length,
      "6-chip hit": pct(mean(a.map((r) => r.stats.hitRate["6-chip (3x2)"]))),
      "16-grid hit": pct(mean(a.map((r) => r.stats.hitRate["16-grid (4x4)"]))),
      "offset x/y px": `${f0(mean(a.map((r) => r.stats.accuracyXPx)))}/${f0(mean(a.map((r) => r.stats.accuracyYPx)))}`,
      "6-chip dwell ok/wrong": `${pct(d("6", "correct"))}/${pct(d("6", "wrong"))}`,
      "16-grid dwell ok/wrong": `${pct(d("16", "correct"))}/${pct(d("16", "wrong"))}`,
    },
  ];
});
console.table(summary);
console.log(
  "\nhit = share of frames inside a cell-sized box centred on the dot (distance-independent; the main metric)." +
    "\ndwell: did pointing at a dot select the button centred on it, within the time the dot was shown? 'none' = timed out." +
    "\nJudge changes on the mean AND on how many recordings improved, never on one file.",
);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ accuracy: acc, dwell, summary } satisfies { accuracy: ResultRow[]; dwell: DwellRow[]; summary: unknown }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
