import { describe, expect, it } from "vitest";
import { LETTER_GROUPS, PredictionEngine, keySeq, matchesSlots, memoryStore, splitSentences } from "../src/predict/engine";
import { CORE_WORDS, SEED_PHRASES } from "../src/predict/vocab";
import { ProfileManager, memoryKV, pickSamples } from "../src/profile/profiles";

const groupOf = (c: string) => LETTER_GROUPS.find((g) => g.includes(c))!;
const slotsFor = (w: string) => [...w].map(groupOf);
const WORDS = ["the", "of", "and", "to", "a", "in", "is", "you", "that", "it", "he", "for", "was", "on", "are", "if", "good", "home", "gone", "hood", "water", "need", "some", "please", "back", "hurts", "go", "in", "him", "hi"];

function engine(store = memoryStore(), now = () => 1_000_000) {
  const e = new PredictionEngine(store, now);
  e.load(WORDS, CORE_WORDS, SEED_PHRASES);
  return e;
}

describe("key-sequence index", () => {
  it("maps letters to group digits", () => {
    expect(keySeq("hi")).toBe("22");
    expect(keySeq("don't")).toBe("144x6");
  });
  it("returns exactly what a full vocabulary scan would", () => {
    const e = engine();
    for (const w of ["go", "ho", "wat", "pl", "b", "goo"]) {
      const slots = slotsFor(w);
      const got = new Set(e.wordCandidates([], slots, 1000).map((s) => s.text));
      const vocab = [...new Set([...WORDS, ...CORE_WORDS.map((c) => c.toLowerCase())])];
      const expected = new Set(vocab.filter((v) => matchesSlots(v, slots)));
      for (const x of expected) expect(got.has(x), `${w}: missing ${x}`).toBe(true);
      for (const x of got) expect(matchesSlots(x, slots), `${w}: extra ${x}`).toBe(true);
    }
  });
  it("respects exact-letter slots", () => {
    const out = engine().wordCandidates([], ["h", "mno"], 10).map((s) => s.text);
    expect(out).toContain("home");
    expect(out).not.toContain("good");
  });
  it("makes newly learned words typeable", () => {
    const e = engine();
    expect(e.wordCandidates([], slotsFor("zork"), 5).map((s) => s.text)).not.toContain("zork");
    e.learn("zork is here");
    expect(e.wordCandidates([], slotsFor("zork"), 5).map((s) => s.text)).toContain("zork");
  });
});

describe("trigram context", () => {
  it("uses two words of context, not just one", () => {
    const e = engine();
    for (let i = 0; i < 3; i++) e.learn("turn the light off");
    for (let i = 0; i < 3; i++) e.learn("open the door");
    expect(e.nextWords(["turn", "the"], 1)[0].text).toBe("light");
    expect(e.nextWords(["open", "the"], 1)[0].text).toBe("door");
  });
});

describe("personalisation", () => {
  it("imported writing outranks generic words with the same keys", () => {
    const e = engine();
    // "hood" and "good" share keys with "gone"/"home"; the user writes "hood" a lot.
    const before = e.wordCandidates([], slotsFor("hood"), 1)[0].text;
    expect(before).toBe("good");
    e.ingest("Going back to the hood. The hood is great. Love my hood. My hood rocks.");
    expect(e.wordCandidates([], slotsFor("hood"), 1)[0].text).toBe("hood");
  });
  it("imported short sentences become phrase completions", () => {
    const e = engine();
    const n = e.ingest("Can you call Priya? I want to watch the game tonight.");
    expect(n).toBe(2);
    expect(e.suggest(["i", "want"], [], 4, 1).some((s) => s.kind === "phrase" && s.text.includes("game"))).toBe(true);
  });
  it("pinned names are easy to reach and keep their capital letter", () => {
    const e = engine();
    e.setPinned(["Priya", "Nurse Alex"]);
    const top = e.wordCandidates(["call"], slotsFor("pri"), 1)[0];
    expect(top.text).toBe("priya");
    expect(top.label).toBe("Priya");
    expect(e.display("alex")).toBe("Alex");
  });
  it("a rejected suggestion drops in that context only", () => {
    const e = engine();
    e.learn("i need water");
    e.learn("i need water");
    expect(e.nextWords(["i", "need"], 1)[0].text).toBe("water");
    e.reject(["i", "need"], "water");
    e.reject(["i", "need"], "water");
    expect(e.nextWords(["i", "need"], 1)[0].text).not.toBe("water");
    // Saying it deliberately clears the penalty.
    e.learn("i need water");
    expect(e.nextWords(["i", "need"], 1)[0].text).toBe("water");
  });
  it("recent personal words beat ones not used for months", () => {
    let t = 1_000_000;
    const e = engine(memoryStore(), () => t);
    e.learn("the gone thing");
    t += 120 * 864e5; // four months later
    e.learn("the hood thing");
    const top = e.wordCandidates([], slotsFor("gone"), 5).map((s) => s.text);
    expect(top.indexOf("hood")).toBeLessThan(top.indexOf("gone"));
  });
});

describe("profiles", () => {
  it("migrates single-user data into a default profile", () => {
    const kv = memoryKV();
    kv.setItem("gazetype.phrases.v1", JSON.stringify([{ text: "old phrase here", count: 3, last: 0 }]));
    const pm = new ProfileManager(kv);
    expect(pm.list()).toHaveLength(1);
    const e = engine(pm.store(pm.active.id));
    expect(e.topPhrases(1)).toContain("old phrase here");
  });
  it("keeps each profile's data separate", () => {
    const pm = new ProfileManager(memoryKV());
    const a = pm.active;
    const b = pm.create("Sam");
    const e = engine(pm.store(a.id));
    e.learn("my cat is called whiskers");
    e.useStore(pm.store(b.id));
    expect(e.wordCandidates(["called"], slotsFor("whi"), 3).map((s) => s.text)).not.toContain("whiskers");
    e.useStore(pm.store(a.id));
    expect(e.wordCandidates(["called"], slotsFor("whi"), 3)[0].text).toBe("whiskers");
  });
  it("export and import round-trips a profile's data", () => {
    const pm = new ProfileManager(memoryKV());
    pm.update(pm.active.id, { name: "Ana", people: ["Leo"] });
    const e = engine(pm.store(pm.active.id));
    e.learn("see you at the lake");
    const json = pm.exportProfile(pm.active.id);
    const pm2 = new ProfileManager(memoryKV());
    const imported = pm2.importProfile(json);
    expect(imported.name).toBe("Ana");
    expect(imported.people).toEqual(["Leo"]);
    expect(engine(pm2.store(imported.id)).topPhrases(50)).toContain("see you at the lake");
  });
  it("deleting a profile removes its data and never deletes the last one", () => {
    const kv = memoryKV();
    const pm = new ProfileManager(kv);
    const b = pm.create("Temp");
    engine(pm.store(b.id)).learn("temporary words here");
    expect(pm.remove(b.id)).toBe(true);
    for (let i = 0; i < kv.length; i++) expect(kv.key(i)!.includes(b.id)).toBe(false);
    expect(pm.remove(pm.active.id)).toBe(false);
  });
});

describe("text helpers", () => {
  it("splits messages into sentences", () => {
    expect(splitSentences("Hi! How are you?\nSee you soon.")).toEqual(["Hi!", "How are you?", "See you soon."]);
  });
  it("picks a bounded, de-duplicated sample", () => {
    const many = Array.from({ length: 200 }, (_, i) => `this is sentence number ${i}`);
    const s = pickSamples([...many, many[0]], 40);
    expect(s).toHaveLength(40);
    expect(new Set(s).size).toBe(40);
    expect(pickSamples(["too short", "this one is long enough"])).toEqual(["this one is long enough"]);
  });
});

describe("suggestions on longer sentences", () => {
  it("starter phrases don't pile up in a profile each time the app loads", () => {
    const store = memoryStore();
    const e1 = engine(store);
    e1.ingest("I want to watch the hockey game. The hockey game starts at seven.");
    for (let i = 0; i < 5; i++) engine(store); // five more app launches
    const e = engine(store);
    // The user's own "the hockey" (imported twice) beats every starter phrase after "the".
    expect(e.nextWords(["watch", "the"], 1)[0].text).toBe("hockey");
    expect(e.nextWords(["tell", "the"], 1)[0].text).toBe("hockey");
  });
  it("upgrades old saved data, dropping the repeated starter phrases", () => {
    const store = memoryStore();
    // A v1 profile: "the nurse" inflated by repeated seeding, one real sentence in the phrase store.
    store.set("gazetype.bigrams.v1", JSON.stringify([["the", [["nurse", 3], ["hockey", 0.6]]]]));
    store.set("gazetype.phrases.v1", JSON.stringify([{ text: "I love the hockey game", count: 2, last: 1 }, { text: "I need the nurse", count: 1, last: 0 }]));
    const e = engine(store);
    expect(e.nextWords(["love", "the"], 1)[0].text).toBe("hockey");
  });
  it("never leaves suggestion slots empty after an unfamiliar word", () => {
    const e = engine();
    e.ingest("Priya is coming over later.");
    const s = e.nextWords(["after", "dinner"], 4);
    expect(s).toHaveLength(4);
    expect(s.map((x) => x.text)).not.toContain("dinner");
  });
  it("offers a stored phrase from the middle of a sentence", () => {
    const e = engine();
    e.ingest("Tell Priya I love her.");
    // Two meaningful words in common ("tell priya") anchor the match.
    const s = e.phraseCompletions(["after", "dinner", "can", "you", "tell", "priya"], [], 3);
    expect(s[0]?.text).toBe("I love her");
    // Three words of any kind do too.
    e.ingest("When does the hockey game start?");
    expect(e.phraseCompletions(["so", "when", "does", "the"], [], 3)[0]?.text).toBe("hockey game start");
  });
  it("doesn't glue on an ending that makes no sense", () => {
    const e = engine();
    e.ingest("The hockey game starts at seven.");
    e.ingest("Let's watch the game together tonight.");
    e.ingest("Dev u coming over tonight or nah");
    // One shared word, or a common word plus one other, is too weak: these were real nonsense chips.
    expect(e.phraseCompletions(["i", "want", "the", "hockey"], [], 3)).toHaveLength(0); // "I want the hockey game starts at seven"
    expect(e.phraseCompletions(["can", "you", "turn", "the", "game"], [], 3)).toHaveLength(0); // "...turn the game together tonight"
    expect(e.phraseCompletions(["maya", "can", "u"], [], 3)).toHaveLength(0); // "maya can u coming over tonight or nah"
  });
  it("shows short phrases whole and never ends a cut phrase on a dangling word", () => {
    const e = engine();
    e.ingest("Yo can u tell Maya to grab my charger");
    // 9 words: cut to 6 ("Yo can u tell Maya to"), then the dangling "to" is dropped.
    expect(e.phraseCompletions([], [], 1)[0].text).toBe("Yo can u tell Maya");
    const f = engine();
    f.ingest("Can you put the Oilers game on tonight"); // 8 words: shown whole
    expect(f.phraseCompletions([], [], 1)[0].text).toBe("Can you put the Oilers game on tonight");
  });
  it("keeps phrase chips short and correctly capitalised", () => {
    const e = engine();
    e.setPinned(["Priya"]);
    e.ingest("tell priya i will be home after the game tonight");
    const [s] = e.phraseCompletions([], [], 1);
    expect(s.text.split(" ")).toHaveLength(6);
    expect(s.text).toBe("Tell Priya I will be home");
    // The rest comes up as the next chip once those words are in.
    expect(e.phraseCompletions(["tell", "priya", "i", "will", "be", "home"], [], 1)[0].text).toBe("after the game tonight");
  });
  it("boosts topic words from the profile's about note", () => {
    const e = engine();
    const before = e.wordCandidates([], slotsFor("goo"), 5).map((s) => s.text);
    e.setTopics("Loves gardening and the goose at the lake");
    const after = e.wordCandidates([], slotsFor("goo"), 5).map((s) => s.text);
    expect(after.indexOf("goose")).toBeGreaterThanOrEqual(0);
    expect(after.indexOf("goose")).toBeLessThan(before.includes("goose") ? before.indexOf("goose") : 99);
  });
});
