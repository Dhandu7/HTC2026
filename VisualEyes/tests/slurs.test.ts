import { describe, expect, it } from "vitest";
import { containsSlur, findSlur, isSlur, slurList } from "../src/safety/slurs";

// Test words are built from the encoded list rather than written out, so they don't appear in the code.
const [first] = slurList(); // a racial slur
const listed = (i: number) => slurList()[i];

describe("slur detection", () => {
  it("decodes a non-empty list", () => {
    expect(slurList().length).toBeGreaterThan(20);
    expect(slurList().every((w) => /^[a-z]+$/.test(w))).toBe(true);
  });
  it("catches every listed word, any capitalisation, with plural endings", () => {
    for (const w of slurList()) {
      expect(isSlur(w), w.length + " letters").toBe(true);
      expect(isSlur(w.toUpperCase())).toBe(true);
      expect(isSlur(w + "s")).toBe(true);
    }
  });
  it("catches look-alike characters, stretching and punctuation", () => {
    const leet = first.replace(/i/g, "1").replace(/e/g, "3");
    expect(isSlur(leet)).toBe(true);
    const stretched = first.replace(/i/, "iii").replace(/g/, "gggg");
    expect(isSlur(stretched)).toBe(true);
    expect(isSlur(first + "!!")).toBe(true);
  });
  it("finds a slur inside a sentence, also spelled out letter by letter", () => {
    expect(findSlur(`you are a ${first} lol`)).toBe(first);
    expect(containsSlur(`you are a ${first.split("").join(" ")}`)).toBe(true);
    expect(containsSlur(`you are a ${first.split("").join(".")}`)).toBe(true);
  });
  it("allows swearing", () => {
    for (const s of ["what the fuck", "oh shit", "damn it", "this is bullshit", "go to hell", "fucking hell, my back hurts", "you ass", "bitch please"])
      expect(containsSlur(s), s).toBe(false);
  });
  it("doesn't block ordinary words that contain or resemble a listed word", () => {
    // Whole-word matching only: these contain listed letter sequences but are normal English.
    for (const s of [
      "the miser was niggardly with money",
      "spice up the soup",
      "a spick and span kitchen",
      "the dyke family lives next door".replace("dyke", "dike"),
      "wopping big fish".replace("wopping", "whopping"),
      "a chink in the armour",
      "the raccoon is a coon".replace("a coon", "cute"),
      "please pass the paprika",
      "I need the pharmacy",
      "the retardant on the fire",
      "Scunthorpe and Penistone",
      "she is gay and proud",
    ])
      expect(containsSlur(s), s).toBe(false);
  });
  it("ignores very short fragments", () => {
    expect(isSlur("ni")).toBe(false);
    expect(isSlur("")).toBe(false);
  });
  it("covers the ableist slur most relevant to this app", () => {
    // An AAC app for disabled people should never offer or speak this one.
    expect(slurList().some((w) => w.startsWith("ret"))).toBe(true);
    expect(isSlur(listed(slurList().findIndex((w) => w.startsWith("ret"))))).toBe(true);
  });
});

import { LETTER_GROUPS, PredictionEngine, memoryStore } from "../src/predict/engine";
import { stripSlurs } from "../src/safety/slurs";

const groupOf = (c: string) => LETTER_GROUPS.find((g) => g.includes(c))!;
const slotsFor = (w: string) => [...w].map(groupOf);
const engineWith = (words: string[], store = memoryStore()) => {
  const e = new PredictionEngine(store, () => 1_000_000);
  e.load(words, [], []);
  return e;
};

describe("slurs in prediction", () => {
  it("never suggests a slur, even one in the word list", () => {
    const e = engineWith(["the", "you", first, "nice"]);
    const typed = e.wordCandidates([], slotsFor(first), 10).map((s) => s.text);
    expect(typed).not.toContain(first);
  });
  it("never learns a sentence containing a slur, but learns swearing", () => {
    const e = engineWith(["the", "you"]);
    e.learn(`you are a ${first}`);
    e.learn("well shit that hurts");
    expect(e.topPhrases(10).some((p) => p.includes(first))).toBe(false);
    expect(e.topPhrases(10)).toContain("well shit that hurts");
    expect(e.wordCandidates([], slotsFor("shi"), 5).map((s) => s.text)).toContain("shit");
  });
  it("skips imported sentences with slurs and never pins one as a name or topic", () => {
    const e = engineWith(["the", "you"]);
    const n = e.ingest(`Love you mom. You ${first} lol. Damn this weather.`);
    expect(n).toBe(3);
    expect(e.topPhrases(10).join(" ")).not.toContain(first);
    expect(e.topPhrases(10)).toContain("Damn this weather");
    e.setPinned([first, "Priya"]);
    e.setTopics(`hockey ${first}`);
    expect(e.wordCandidates([], slotsFor(first.slice(0, 3)), 20).map((s) => s.text)).not.toContain(first);
    expect(e.display("priya")).toBe("Priya");
  });
  it("cleans slurs out of a profile saved before blocking existed", () => {
    const store = memoryStore();
    store.set("gazetype.phrases.v1", JSON.stringify([{ text: `call him a ${first}`, count: 3, last: 5 }, { text: "call my mom", count: 2, last: 4 }]));
    store.set("gazetype.words.v1", JSON.stringify([[first, { c: 9, t: 5 }], ["mom", { c: 2, t: 4 }]]));
    store.set("gazetype.bigrams.v2", JSON.stringify([["a", [[first, 3]]], ["my", [["mom", 2]]]]));
    store.set("gazetype.trigrams.v2", JSON.stringify([]));
    const e = engineWith(["the", "a", "my", "mom", "call"], store);
    expect(e.topPhrases(10)).toEqual(["call my mom"]);
    expect(e.nextWords(["him", "a"], 5).map((s) => s.text)).not.toContain(first);
    expect(e.recentSentences(5)).toEqual(["call my mom"]);
  });
  it("strips slurs out of free text such as a profile description", () => {
    expect(stripSlurs(`loves hockey and ${first} jokes`)).toBe("loves hockey and jokes");
    expect(stripSlurs("loves hockey, swears a lot (damn)")).toBe("loves hockey, swears a lot (damn)");
  });
});
