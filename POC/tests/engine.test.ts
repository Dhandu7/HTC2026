import { describe, expect, it } from "vitest";
import { LETTER_GROUPS, PredictionEngine, matchesInitials, matchesSlots, memoryStore } from "../src/predict/engine";
import { CORE_WORDS, SEED_PHRASES } from "../src/predict/vocab";
import { TypingSession, levenshtein, wpm } from "../src/metrics/session";

const groupOf = (c: string) => LETTER_GROUPS.find((g) => g.includes(c))!;
const slotsFor = (w: string) => [...w].map(groupOf);
const WORDS = ["the", "of", "and", "to", "a", "in", "is", "you", "that", "it", "he", "for", "was", "on", "are", "if", "good", "home", "gone", "hood", "water", "need", "some", "please", "back", "hurts"];

function engine() {
  const e = new PredictionEngine(memoryStore(), () => 1_000_000);
  e.load(WORDS, CORE_WORDS, SEED_PHRASES);
  return e;
}

describe("slot matching", () => {
  it("matches letter groups", () => {
    expect(matchesSlots("good", slotsFor("home"))).toBe(true);
    expect(matchesSlots("water", ["wxyz"])).toBe(true);
    expect(matchesSlots("water", ["abc"])).toBe(false);
    expect(matchesInitials("I need help", ["ghi", "mno", "ghi"])).toBe(true);
  });
});

describe("PredictionEngine", () => {
  it("decodes ambiguous keys to the most frequent word", () => {
    const top = engine().wordCandidates([], slotsFor("you"), 3);
    expect(top[0].text).toBe("you");
  });
  it("completes words from a prefix", () => {
    const top = engine().wordCandidates([], slotsFor("wat"), 3).map((s) => s.text);
    expect(top).toContain("water");
  });
  it("learns personal phrases and offers them on reuse", () => {
    const e = engine();
    e.learn("my dog is called biscuit");
    const s = e.suggest(["my"], [], 4, 1);
    expect(s.some((x) => x.kind === "phrase" && x.text.includes("biscuit"))).toBe(true);
    // personal word now decodes
    expect(e.wordCandidates(["called"], slotsFor("bis"), 3)[0].text).toBe("biscuit");
  });
  it("uses bigram context for next-word prediction", () => {
    const e = engine();
    e.learn("i need water");
    e.learn("i need water");
    const next = e.nextWords(["need"], 3).map((s) => s.text);
    expect(next[0]).toBe("water");
  });
  it("expands initials from the phrase store", () => {
    const out = engine().expandInitials(["ghi", "mno", "ghi"], 4).map((s) => s.text);
    expect(out).toContain("I need help");
  });
  it("persists to the store", () => {
    const store = memoryStore();
    const a = new PredictionEngine(store);
    a.load(WORDS, [], []);
    a.learn("hello there friend");
    const b = new PredictionEngine(store);
    b.load(WORDS, [], []);
    expect(b.topPhrases(5)).toContain("hello there friend");
  });
});

describe("metrics", () => {
  it("computes wpm, msd and false-selection proxy", () => {
    expect(wpm(26, 60000)).toBeCloseTo(5);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    const s = new TypingSession("gazetype", "dwell", "my back hurts");
    s.record(0, "letter");
    s.record(1000, "delete");
    s.record(5000, "phrase");
    const r = s.finish(60000, "my back hurts");
    expect(r.likelyFalseSelections).toBe(1);
    expect(r.errorRate).toBe(0);
    expect(r.selections).toBe(3);
  });
});
