// Does the profile (names, description, writing samples) make suggestions more relevant and
// closer to the person's style? Two parts:
//
//   1. Local word/phrase chips (no network): simulate a user typing held-out sentences on the
//      GazeType keyboard, taking a chip whenever the right one is shown. Profile vs empty profile.
//   2. The AI chip (Claude, through the running LLM server): the same requests the app sends.
//      Own profile vs no profile, plus neutral sentence starts through every persona (style check).
//
//   npm run llm   (or dev:all) in another terminal, then:
//   npx tsx scripts/eval-suggestions.ts [--local-only] [--url http://localhost:8787] [--out results.json]
//
// Part 2 costs a few cents of API usage (about 150 small Haiku requests).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LETTER_GROUPS, PredictionEngine, memoryStore, splitSentences, tokenize, type Suggestion } from "../src/predict/engine";
import { CORE_WORDS, SEED_PHRASES } from "../src/predict/vocab";
import { pickSamples } from "../src/profile/profiles";
import { PERSONAS, type Persona } from "./eval/personas";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, d: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : d;
};
/** --words <file>: score another frequency list (one word per line, most common first) against the app's. */
const WORDS = readFileSync(opt("--words", join(here, "../public/data/words-30k.txt")), "utf8").split("\n");
const LOCAL_ONLY = args.includes("--local-only");
const URL = opt("--url", "http://localhost:8787");
const OUT = opt("--out", "");
/** --old-history: send history the way the app used to (top-ranked phrases), to measure the old behaviour. */
const OLD_HISTORY = args.includes("--old-history");
const ALL_CUTS = args.includes("--all-cuts");
const historyOf = (e: PredictionEngine) => (OLD_HISTORY ? e.topPhrases(8) : e.recentSentences(8));

const groupOf = (c: string) => LETTER_GROUPS.find((g) => g.includes(c)) ?? c;

function engineFor(p: Persona | null): PredictionEngine {
  const e = new PredictionEngine(memoryStore());
  e.load(WORDS, CORE_WORDS, SEED_PHRASES);
  if (p) {
    e.ingest(p.train.join("\n"));
    e.setPinned(p.people);
    e.setTopics(p.about);
  }
  return e;
}

// ---------------------------------------------------------------- part 1: local chips

interface PhraseShown {
  context: string;
  phrase: string;
  right: boolean;
}

/** Selections to type `sentence` taking the right chip whenever shown; logs every phrase chip offered. */
function simulate(e: PredictionEngine, sentence: string, shown: PhraseShown[]): { selections: number; chars: number } {
  const words = tokenize(sentence);
  let sel = 0;
  let i = 0;
  const phraseHit = (chips: Suggestion[]) => {
    for (const c of chips.filter((x) => x.kind === "phrase")) {
      const pw = tokenize(c.text);
      const right = pw.every((w, k) => words[i + k] === w);
      shown.push({ context: words.slice(0, i).join(" "), phrase: c.text, right: pw[0] === words[i] });
      if (right) return pw.length;
    }
    return 0;
  };
  while (i < words.length) {
    const w = words[i];
    const slots: string[] = [];
    for (;;) {
      const chips = e.suggest(words.slice(0, i), slots, 4, 1);
      const k = phraseHit(chips);
      if (k) {
        sel++;
        i += k;
        break;
      }
      if (chips.some((c) => c.kind === "word" && c.text === w)) {
        sel++;
        i++;
        break;
      }
      if (slots.length === w.length) {
        sel++; // accept with space (spell mode would be needed for unknown words; counted as one)
        i++;
        break;
      }
      slots.push(groupOf(w[slots.length]));
      sel++;
    }
  }
  return { selections: sel, chars: sentence.length };
}

function localPart() {
  console.log("\n=== Part 1: local word and phrase chips (held-out sentences) ===\n");
  console.log("persona   | selections/char: empty profile -> with profile | phrase chips shown (right / wrong)");
  const report: Record<string, unknown> = {};
  for (const p of PERSONAS) {
    const rows = [null, p].map((who) => {
      const e = engineFor(who);
      const shown: PhraseShown[] = [];
      let sel = 0;
      let chars = 0;
      for (const s of p.test) {
        const r = simulate(e, s, shown);
        sel += r.selections;
        chars += r.chars;
      }
      return { spc: sel / chars, shown };
    });
    const [base, prof] = rows;
    const right = prof.shown.filter((s) => s.right).length;
    console.log(
      `${p.id.padEnd(9)} | ${base.spc.toFixed(3)} -> ${prof.spc.toFixed(3)} (${((1 - prof.spc / base.spc) * 100).toFixed(0)}% fewer) | ${right} / ${prof.shown.length - right}`,
    );
    report[p.id] = { emptySpc: base.spc, profileSpc: prof.spc, wrongPhrases: prof.shown.filter((s) => !s.right) };
  }
  console.log("\nWrong phrase chips (with profile), as shown after the typed words:");
  for (const p of PERSONAS)
    for (const s of (report[p.id] as { wrongPhrases: PhraseShown[] }).wrongPhrases.slice(0, 8))
      console.log(`  [${p.id}] "${s.context}" + [${s.phrase}]`);
  return report;
}

// ---------------------------------------------------------------- part 2: the AI chip

interface Call {
  persona: string;
  profile: string;
  text: string;
  truth?: string;
  suggestions: string[];
  ms: number;
  error?: string;
}

async function predict(text: string, p: Persona | null, history: string[]): Promise<{ suggestions: string[]; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${URL}/api/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "continue",
        text,
        history,
        n: 2,
        profile: p ? { name: p.name, about: p.about, people: p.people, samples: pickSamples(splitSentences(p.train.join("\n"))) } : undefined,
      }),
    });
    const body = await r.json();
    return { suggestions: body.suggestions ?? [], ms: Date.now() - t0, error: r.ok ? undefined : body.error };
  } catch (err) {
    return { suggestions: [], ms: Date.now() - t0, error: String(err) };
  }
}

/** The typed text as the app shows it: first word capitalised, "i" -> "I". */
const asTyped = (words: string[]) => words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w === "i" ? "I" : w)).join(" ");

const continuation = (full: string, text: string) => full.slice(text.length).trim();

function styleOf(cont: string, p: Persona) {
  const words = cont.split(/\s+/).filter(Boolean);
  const lower = cont.replace(/\bI\b/g, "i") === cont.toLowerCase();
  const punct = /[.!?,]/.test(cont);
  const markers = tokenize(cont).filter((w) => p.style.markers.includes(w)).length;
  const known = new Set([...p.people.flatMap((n) => n.split(" ")), p.name, "I", "Raptors", "Oilers", "Fortnite", "Saturday", "Sunday", "Nurse", "Coach"]);
  const caps = cont.match(/\b[A-Z][a-z']+/g) ?? [];
  const firstWordCap = /^[A-Z]/.test(cont) ? cont.split(/\s/)[0] : null;
  const invented = caps.filter((c) => c !== firstWordCap && !known.has(c) && !known.has(c.replace(/'s$/, "")));
  return { words: words.length, lower, punct, markers, invented };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const NEUTRAL = ["can you", "i want", "tell", "i am", "please", "what"];

async function aiPart() {
  const health = await fetch(`${URL}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok || !health.keySet) {
    console.log(`\nPart 2 skipped: no LLM server with a key at ${URL} (start npm run llm, or pass --url).`);
    return null;
  }
  console.log(`\n=== Part 2: the AI chip (${health.fastModel} via ${URL}) ===`);
  const jobs: { persona: Persona; profile: Persona | null; label: string; words: string[]; truth?: string }[] = [];
  for (const p of PERSONAS) {
    for (const s of p.test) {
      const w = tokenize(s);
      // Default: after the first word and halfway. --all-cuts: after every word (more requests, steadier numbers).
      const cuts = ALL_CUTS ? w.slice(1).map((_, k) => k + 1) : [...new Set([1, Math.ceil(w.length / 2)])].filter((k) => k < w.length);
      for (const k of cuts)
        for (const prof of [p, null]) jobs.push({ persona: p, profile: prof, label: prof ? "own" : "none", words: w.slice(0, k), truth: w.slice(k).join(" ") });
    }
    for (const n of NEUTRAL) jobs.push({ persona: p, profile: p, label: "neutral", words: n.split(" ") });
  }
  const histories = new Map<string, string[]>(PERSONAS.map((p) => [p.id, historyOf(engineFor(p))]));
  const emptyHistory = historyOf(engineFor(null));
  const calls: Call[] = await pool(jobs, 4, async (j) => {
    const text = asTyped(j.words);
    const r = await predict(text, j.profile, j.profile ? histories.get(j.persona.id)! : emptyHistory);
    return { persona: j.persona.id, profile: j.label, text, truth: j.truth, ...r };
  });

  const errors = calls.filter((c) => c.error);
  if (errors.length) console.log(`  ${errors.length} request(s) failed, e.g. ${errors[0].error}`);
  console.log("\nRelevance on held-out sentences (does a suggestion continue with the right next word / two words?)");
  console.log("persona   | profile | next word | next 2 words | copied a sample | empty | median ms");
  const norm = (t: string) => tokenize(t).join(" ");
  for (const p of PERSONAS)
    for (const label of ["own", "none"]) {
      const cs = calls.filter((c) => c.persona === p.id && c.profile === label && !c.error);
      const next = (c: Call, n: number) => {
        const t = tokenize(c.truth!).slice(0, n).join(" ");
        return c.suggestions.some((s) => tokenize(continuation(s, c.text)).slice(0, n).join(" ") === t);
      };
      const ms = cs.map((c) => c.ms).sort((a, b) => a - b);
      const samples = new Set(p.train.map(norm));
      const all = cs.flatMap((c) => c.suggestions);
      console.log(
        `${p.id.padEnd(9)} | ${label.padEnd(7)} | ${pct(cs.filter((c) => next(c, 1)).length, cs.length)} | ${pct(cs.filter((c) => next(c, 2)).length, cs.length).padEnd(12)} | ${pct(all.filter((s) => samples.has(norm(s))).length, all.length).padEnd(15)} | ${pct(cs.filter((c) => !c.suggestions.length).length, cs.length).padEnd(5)} | ${ms[ms.length >> 1] ?? "-"}`,
      );
    }

  console.log("\nStyle on neutral starts (same typed words for everyone; should follow each person)");
  console.log("persona   | all lowercase | has punctuation | style words | avg words | invented names");
  for (const p of PERSONAS) {
    const conts = calls.filter((c) => c.persona === p.id && c.profile === "neutral").flatMap((c) => c.suggestions.map((s) => continuation(s, c.text)));
    const st = conts.map((c) => styleOf(c, p));
    console.log(
      `${p.id.padEnd(9)} | ${pct(st.filter((s) => s.lower).length, st.length).padEnd(13)} | ${pct(st.filter((s) => s.punct).length, st.length).padEnd(15)} | ${pct(st.filter((s) => s.markers > 0).length, st.length).padEnd(11)} | ${(st.reduce((a, s) => a + s.words, 0) / (st.length || 1)).toFixed(1).padEnd(9)} | ${[...new Set(st.flatMap((s) => s.invented))].join(", ") || "none"}`,
    );
  }
  console.log("\nSample outputs (own profile, first cut of each test sentence):");
  for (const p of PERSONAS)
    for (const c of calls.filter((c) => c.persona === p.id && c.profile === "own").slice(0, 16).filter((_, i) => i % 2 === 0))
      console.log(`  [${p.id}] "${c.text}" (really: ${c.truth}) -> ${c.suggestions.map((s) => `[${continuation(s, c.text)}]`).join(" ") || "(nothing)"}`);
  console.log("\nSample outputs (neutral starts):");
  for (const p of PERSONAS)
    for (const c of calls.filter((c) => c.persona === p.id && c.profile === "neutral"))
      console.log(`  [${p.id}] "${c.text}" -> ${c.suggestions.map((s) => `[${continuation(s, c.text)}]`).join(" ") || "(nothing)"}`);
  return calls;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-").padStart(4).padEnd(9);

const local = localPart();
const ai = LOCAL_ONLY ? null : await aiPart();
if (OUT) writeFileSync(OUT, JSON.stringify({ local, ai }, null, 2));
