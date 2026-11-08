// On-device prediction engine: ambiguous-key (letter-group) decoding, word
// completion, next-word prediction, and a personal phrase store that learns from
// everything the user speaks.
//
// Speed: a key-sequence index maps every word prefix's letter-group sequence to
// the words that start with it, so a key press looks up one bucket instead of
// scanning the whole vocabulary.
//
// Personalisation (phone-keyboard style):
//  - personal unigram / bigram / trigram counts, kept per profile (the Store is per profile);
//  - a personal-vs-global blend whose personal weight grows with how much the user has said;
//  - recency decay on personal words (30-day half-life);
//  - rejected suggestions (chosen, then deleted within 2 s) are penalised in that context;
//  - imported writing samples and pinned words (names of people) give a head start.
//
// Pure TypeScript; persistence is injected so it runs in tests and in the browser.

import { containsSlur, isSlur } from "../safety/slurs";

export const LETTER_GROUPS = ["abc", "def", "ghi", "jkl", "mno", "pqrs", "tuv", "wxyz"] as const;

/** One typed slot: the set of letters it may stand for (a group, or one exact letter). */
export type Slot = string;

export interface Suggestion {
  kind: "word" | "phrase" | "llm";
  /** Text shown on the chip. */
  label: string;
  /** For words: the word that replaces the slots being typed. For phrases: the text appended after committed words. */
  text: string;
  score: number;
}

export interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const memoryStore = (): Store => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

const GROUP_OF: Record<string, string> = {};
LETTER_GROUPS.forEach((g, i) => [...g].forEach((c) => (GROUP_OF[c] = String(i))));

/** Letter-group sequence for a string of letters, e.g. "hi" -> "22". Non-letters map to "x". */
export function keySeq(s: string): string {
  let out = "";
  for (const c of s) out += GROUP_OF[c] ?? "x";
  return out;
}

/** Key sequence for typed slots (a slot is a group or one exact letter; both map to a group). */
const slotKey = (slots: Slot[]) => slots.map((s) => GROUP_OF[s[0]] ?? "x").join("");

export function matchesSlots(word: string, slots: Slot[], exactLength = false): boolean {
  if (word.length < slots.length || (exactLength && word.length !== slots.length)) return false;
  for (let i = 0; i < slots.length; i++) if (!slots[i].includes(word[i])) return false;
  return true;
}

/** Initial-letter pattern match for abbreviation expansion: one slot per word. */
export function matchesInitials(sentence: string, slots: Slot[]): boolean {
  const words = tokenize(sentence);
  if (words.length !== slots.length) return false;
  return words.every((w, i) => slots[i].includes(w[0]));
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Split free text (messages, emails) into sentences worth learning from. */
export function splitSentences(text: string): string[] {
  return text
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => tokenize(s).length > 0);
}

interface PhraseEntry {
  text: string;
  count: number;
  last: number;
}

/** Personal word count with the time it was last used (for recency decay). */
interface WordStat {
  c: number;
  t: number;
}

type Counts = Map<string, Map<string, number>>;

const KEY_WORDS = "gazetype.words.v1";
// v1 n-gram stores had the starter phrases re-added on every load; v2 holds only the user's own.
const KEY_BIGRAMS_V1 = "gazetype.bigrams.v1";
const KEY_TRIGRAMS_V1 = "gazetype.trigrams.v1";
const KEY_BIGRAMS = "gazetype.bigrams.v2";
const KEY_TRIGRAMS = "gazetype.trigrams.v2";
const KEY_TOPICS = "gazetype.topics.v1";
const KEY_PHRASES = "gazetype.phrases.v1";
const KEY_PINNED = "gazetype.pinned.v1";
const KEY_PENALTY = "gazetype.penalty.v1";

const DAY_MS = 864e5;
const HALF_LIFE_DAYS = 30;
/** Personal weight is n / (n + PERSONAL_PRIOR), n = words the user has produced. */
const PERSONAL_PRIOR = 300;
const BACKOFF = 0.4;
const CONTEXT_WEIGHT = 0.85;
const MAX_IMPORTED_PHRASES = 400;
/** Generic starter phrases rank below anything the user has actually said or imported (0.3). */
const SEED_PHRASE_COUNT = 0.25;
/** Starter-phrase n-grams count this much per occurrence: less than one imported sentence (0.3). */
const SEED_NGRAM_WEIGHT = 0.25;
/** Phrase chips show at most this many words; choosing one brings the next part up as the next chip. */
const MAX_PHRASE_CHIP_WORDS = 6;
/** A phrase this short is shown whole rather than cut at MAX_PHRASE_CHIP_WORDS. */
const WHOLE_PHRASE_WORDS = 8;
/** Words too common to anchor a mid-sentence phrase match on their own. */
const STOPWORDS = new Set(
  "a an the and or but to of in on at for with from by is are was were be been am i you he she it we they me my your his her its our their this that these those so if then than as do does did not no yes can could would should will just up out about into over after before again very too u ur im ya yo pls plz".split(" "),
);

export class PredictionEngine {
  // Global (shared by all profiles)
  private unigram = new Map<string, number>();
  private unigramTotal = 1;
  private seedPhrases: string[] = [];
  /** Starter-phrase n-grams: a weak built-in prior, never saved to a profile. */
  private seedBigrams: Counts = new Map();
  private seedTrigrams: Counts = new Map();
  /** Most common global words, for filling empty suggestion slots. */
  private topGlobal: string[] = [];
  // Personal (per profile, persisted in the Store)
  private personalWords = new Map<string, WordStat>();
  private personalTotal = 0;
  private bigrams: Counts = new Map();
  private trigrams: Counts = new Map();
  private phrases: PhraseEntry[] = [];
  private pinned = new Map<string, string>(); // lowercase -> display casing
  private penalty = new Map<string, number>(); // "prev word" -> number of rejections
  private topics = new Set<string>(); // content words from the profile's "about" note
  // Derived
  private vocab = new Set<string>();
  private index = new Map<string, string[]>();

  constructor(
    private store: Store = memoryStore(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Frequency-ranked word list (most common first) plus AAC core words and seed phrases. */
  load(rankedWords: string[], coreWords: string[], seedPhrases: string[]): void {
    this.unigram.clear();
    rankedWords.forEach((w, rank) => {
      const word = w.trim().toLowerCase();
      if (word && !this.unigram.has(word)) this.unigram.set(word, 1 / (rank + 10));
    });
    // Core AAC vocabulary ("pain", "nurse", "suction"...) is boosted to top-200 frequency.
    for (const w of coreWords) {
      const word = w.toLowerCase();
      this.unigram.set(word, Math.max(this.unigram.get(word) ?? 0, 1 / 200));
    }
    this.unigramTotal = [...this.unigram.values()].reduce((a, b) => a + b, 0) || 1;
    this.topGlobal = [...this.unigram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([w]) => w);
    this.seedPhrases = seedPhrases;
    this.seedBigrams = new Map();
    this.seedTrigrams = new Map();
    for (const p of seedPhrases) this.addNgramsTo(this.seedBigrams, this.seedTrigrams, tokenize(p), 1);
    this.resetPersonal();
  }

  /** Switch to another profile's store (global vocabulary is kept). */
  useStore(store: Store): void {
    this.store = store;
    this.resetPersonal();
  }

  private resetPersonal() {
    this.personalWords = new Map();
    this.bigrams = new Map();
    this.trigrams = new Map();
    this.phrases = [];
    this.pinned = new Map();
    this.penalty = new Map();
    this.topics = new Set();
    this.restore();
    this.dropSlurs();
    if (!this.phrases.length) this.phrases = this.seedPhrases.map((text) => ({ text, count: SEED_PHRASE_COUNT, last: 0 }));
    this.personalTotal = [...this.personalWords.values()].reduce((a, s) => a + s.c, 0);
    this.rebuildIndex();
  }

  private restore() {
    try {
      const w = this.store.get(KEY_WORDS);
      if (w) {
        // v1 stored [word, count]; now [word, {c, t}]. Accept both.
        const entries = JSON.parse(w) as [string, number | WordStat][];
        this.personalWords = new Map(entries.map(([k, v]) => [k, typeof v === "number" ? { c: v, t: 0 } : v]));
      }
      const parseCounts = (raw: string | null): Counts =>
        raw ? new Map((JSON.parse(raw) as [string, [string, number][]][]).map(([k, v]) => [k, new Map(v)])) : new Map();
      const p = this.store.get(KEY_PHRASES);
      if (p) this.phrases = JSON.parse(p);
      if (this.store.get(KEY_BIGRAMS) !== null) {
        this.bigrams = parseCounts(this.store.get(KEY_BIGRAMS));
        this.trigrams = parseCounts(this.store.get(KEY_TRIGRAMS));
      } else if (this.store.get(KEY_BIGRAMS_V1) !== null || this.store.get(KEY_TRIGRAMS_V1) !== null) {
        // Upgrade: v1 counts are polluted by repeated starter phrases, so rebuild the user's
        // n-grams from their phrase history instead (it holds everything they said or imported).
        const seeds = new Set(this.seedPhrases.map((x) => tokenize(x).join(" ")));
        for (const ph of this.phrases) {
          const words = tokenize(ph.text);
          const own = seeds.has(words.join(" ")) ? ph.count - 1 : ph.count; // old builds seeded at count 1
          if (own > 0) this.addNgrams(words, own);
        }
      }
      const top = this.store.get(KEY_TOPICS);
      if (top) this.topics = new Set(JSON.parse(top));
      const pin = this.store.get(KEY_PINNED);
      if (pin) this.pinned = new Map(JSON.parse(pin));
      const pen = this.store.get(KEY_PENALTY);
      if (pen) this.penalty = new Map(JSON.parse(pen));
    } catch {
      /* corrupt storage: start fresh */
    }
  }

  private persist() {
    const counts = (c: Counts) => JSON.stringify([...c].map(([k, v]) => [k, [...v]]));
    this.store.set(KEY_WORDS, JSON.stringify([...this.personalWords]));
    this.store.set(KEY_BIGRAMS, counts(this.bigrams));
    this.store.set(KEY_TRIGRAMS, counts(this.trigrams));
    this.store.set(KEY_PHRASES, JSON.stringify(this.phrases));
    this.store.set(KEY_PINNED, JSON.stringify([...this.pinned]));
    this.store.set(KEY_PENALTY, JSON.stringify([...this.penalty]));
    this.store.set(KEY_TOPICS, JSON.stringify([...this.topics]));
  }

  // ---------- index ----------

  private rebuildIndex() {
    this.vocab = new Set();
    this.index = new Map();
    for (const w of this.unigram.keys()) this.indexWord(w);
    for (const w of this.personalWords.keys()) this.indexWord(w);
    for (const w of this.pinned.keys()) this.indexWord(w);
    for (const w of this.topics) this.indexWord(w);
  }

  /** Remove slurs from data saved before slur blocking existed (or imported from elsewhere). */
  private dropSlurs() {
    this.phrases = this.phrases.filter((p) => !containsSlur(p.text));
    for (const w of [...this.personalWords.keys()]) if (isSlur(w)) this.personalWords.delete(w);
    for (const c of [this.bigrams, this.trigrams])
      for (const [ctx, row] of c) {
        if (ctx.split(" ").some(isSlur)) c.delete(ctx);
        else for (const w of [...row.keys()]) if (isSlur(w)) row.delete(w);
      }
    for (const w of [...this.pinned.keys()]) if (isSlur(w)) this.pinned.delete(w);
    for (const w of [...this.topics]) if (isSlur(w)) this.topics.delete(w);
  }

  private indexWord(w: string) {
    if (isSlur(w)) return; // never typeable through suggestions, never offered
    if (this.vocab.has(w)) return;
    this.vocab.add(w);
    const seq = keySeq(w);
    for (let k = 1; k <= seq.length; k++) {
      const key = seq.slice(0, k);
      if (key.endsWith("x")) break; // no slot can match a non-letter
      const bucket = this.index.get(key);
      if (bucket) bucket.push(w);
      else this.index.set(key, [w]);
    }
  }

  // ---------- n-grams ----------

  /** Cached row totals per context, so a lookup doesn't re-sum the row for every candidate. */
  private totals = new WeakMap<Map<string, number>, number>();

  private bump(c: Counts, ctx: string, w: string, weight: number) {
    const m = c.get(ctx) ?? new Map<string, number>();
    m.set(w, (m.get(w) ?? 0) + weight);
    c.set(ctx, m);
    this.totals.delete(m);
  }

  private addNgramsTo(bi: Counts, tri: Counts, words: string[], weight: number) {
    const seq = ["<s>", ...words];
    for (let i = 1; i < seq.length; i++) {
      this.bump(bi, seq[i - 1], seq[i], weight);
      this.bump(tri, i >= 2 ? `${seq[i - 2]} ${seq[i - 1]}` : `<s> <s>`, seq[i], weight);
    }
  }

  private addNgrams(words: string[], weight = 1) {
    this.addNgramsTo(this.bigrams, this.trigrams, words, weight);
  }

  private rowTotal(m: Map<string, number> | undefined): number {
    if (!m) return 0;
    let total = this.totals.get(m);
    if (total === undefined) {
      total = 0;
      for (const v of m.values()) total += v;
      this.totals.set(m, total);
    }
    return total;
  }

  /** P(w | ctx) from the user's own counts plus the weak starter-phrase prior. */
  private prob(own: Counts, seed: Counts, ctx: string, w: string): number {
    const m = own.get(ctx);
    const s = seed.get(ctx);
    const total = this.rowTotal(m) + SEED_NGRAM_WEIGHT * this.rowTotal(s);
    return total > 0 ? ((m?.get(w) ?? 0) + SEED_NGRAM_WEIGHT * (s?.get(w) ?? 0)) / total : 0;
  }

  /** Stupid-backoff context probability: trigram if seen, else discounted bigram. */
  private pContext(prev2: string, prev: string, w: string): number {
    const tri = this.prob(this.trigrams, this.seedTrigrams, `${prev2} ${prev}`, w);
    return tri > 0 ? tri : BACKOFF * this.prob(this.bigrams, this.seedBigrams, prev, w);
  }

  // ---------- scoring ----------

  /** Weight of personal data in the blend: grows as the user says more. */
  get personalWeight(): number {
    return this.personalTotal / (this.personalTotal + PERSONAL_PRIOR);
  }

  private personalCount(w: string): number {
    const s = this.personalWords.get(w);
    if (!s) return 0;
    const ageDays = s.t ? Math.max(0, (this.now() - s.t) / DAY_MS) : HALF_LIFE_DAYS;
    return s.c * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  }

  private baseScore(w: string): number {
    const lambda = this.personalWeight;
    const global = (this.unigram.get(w) ?? 0) / this.unigramTotal;
    const personal = this.personalTotal ? this.personalCount(w) / this.personalTotal : 0;
    let base = (1 - lambda) * global + lambda * personal;
    // Even a brand-new profile should see its first personal words (no global entry) quickly.
    if (!global && personal) base = Math.max(base, 0.05 * personal);
    // Pinned words (names of family, carers, pets) rank like top-50 words.
    if (this.pinned.has(w)) base = Math.max(base, 1 / 60 / this.unigramTotal);
    // Topic words from the profile's "about" note ("hockey", "garden") rank like top-300 words.
    else if (this.topics.has(w)) base = Math.max(base, 1 / 300 / this.unigramTotal);
    return base;
  }

  /** Interpolated score: mostly what fits the context, plus a share of how common the word is overall. */
  private wordScore(w: string, prev2: string, prev: string): number {
    const pen = this.penalty.get(`${prev} ${w}`) ?? 0;
    const score = CONTEXT_WEIGHT * this.pContext(prev2, prev, w) + (1 - CONTEXT_WEIGHT) * this.baseScore(w);
    return score * Math.pow(0.4, pen);
  }

  private ctx(committed: string[]): [string, string] {
    const prev = committed.at(-1) ?? "<s>";
    const prev2 = committed.length >= 2 ? committed.at(-2)! : "<s>";
    return [prev2, prev];
  }

  // ---------- learning ----------

  private learnWords(words: string[], weight: number) {
    const t = this.now();
    for (const w of words) {
      const s = this.personalWords.get(w);
      // Refresh recency: decay the old count to now, then add.
      if (s) this.personalWords.set(w, { c: this.personalCount(w) + weight, t });
      else this.personalWords.set(w, { c: weight, t });
      this.personalTotal += weight;
      this.indexWord(w);
    }
    this.addNgrams(words, weight);
  }

  /** Learn from a sentence the user committed (spoke / inserted). */
  learn(sentence: string): void {
    const words = tokenize(sentence);
    if (!words.length || containsSlur(sentence)) return; // slurs are never learned
    this.learnWords(words, 1);
    // Saying it deliberately cancels earlier rejections in these contexts.
    const seq = ["<s>", ...words];
    for (let i = 1; i < seq.length; i++) this.penalty.delete(`${seq[i - 1]} ${seq[i]}`);
    const norm = words.join(" ");
    const existing = this.phrases.find((p) => tokenize(p.text).join(" ") === norm);
    if (existing) {
      existing.count++;
      existing.last = this.now();
    } else if (words.length >= 2) {
      this.phrases.push({ text: sentence.trim(), count: 1, last: this.now() });
    }
    this.persist();
  }

  /**
   * Import writing samples (old texts, emails, posts) at a lower weight than live use.
   * Short sentences also join the phrase store. Returns the number of sentences learned.
   */
  ingest(text: string, weight = 0.3): number {
    const sentences = splitSentences(text);
    const known = new Set(this.phrases.map((p) => tokenize(p.text).join(" ")));
    let imported = this.phrases.filter((p) => p.count < 1 && p.count !== SEED_PHRASE_COUNT).length;
    for (const s of sentences) {
      if (containsSlur(s)) continue; // imported text: sentences with slurs are skipped entirely
      const words = tokenize(s);
      this.learnWords(words, weight);
      const norm = words.join(" ");
      if (words.length >= 2 && words.length <= 10 && imported < MAX_IMPORTED_PHRASES) {
        const existing = this.phrases.find((p) => tokenize(p.text).join(" ") === norm);
        if (existing) existing.count += weight;
        else if (!known.has(norm)) {
          this.phrases.push({ text: s.replace(/[.!?]+$/, ""), count: weight, last: 0 });
          known.add(norm);
          imported++;
        }
      }
    }
    this.persist();
    return sentences.length;
  }

  /** Words that should always be easy to reach, kept in their display casing (e.g. names). */
  setPinned(words: string[]): void {
    this.pinned = new Map();
    for (const raw of words) {
      for (const part of raw.trim().split(/\s+/)) {
        const w = part.toLowerCase().replace(/[^a-z']/g, "");
        if (!w || isSlur(w)) continue;
        this.pinned.set(w, part.replace(/[^A-Za-z']/g, ""));
        this.indexWord(w);
      }
    }
    this.persist();
  }

  /**
   * Topic words from free text about the user (interests, places, pets). They get a modest
   * boost, so "hockey" or "garden" come up easily without crowding out everyday words.
   */
  setTopics(text: string): void {
    this.topics = new Set(tokenize(text).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !isSlur(w)));
    for (const w of this.topics) this.indexWord(w);
    this.persist();
  }

  /** Display form of a word (names keep their capital letters). */
  display(w: string): string {
    return w === "i" ? "I" : (this.pinned.get(w) ?? w);
  }

  /** The user picked `word` after `committed`, then deleted it straight away: rank it lower there. */
  reject(committed: string[], word: string): void {
    const [, prev] = this.ctx(committed);
    const key = `${prev} ${word}`;
    this.penalty.set(key, (this.penalty.get(key) ?? 0) + 1);
    this.persist();
  }

  // ---------- queries ----------

  private phraseScore(p: PhraseEntry): number {
    const ageH = p.last ? (this.now() - p.last) / 3.6e6 : 1e4;
    return p.count + 2 / (1 + ageH);
  }

  /**
   * What the user actually said most recently (spoken, inserted or copied), newest first.
   * Starter phrases and imported writing samples are left out: they aren't things the user
   * just said, and the samples already reach the AI as part of the profile.
   */
  recentSentences(n: number): string[] {
    return this.phrases
      .filter((p) => p.last > 0)
      .sort((a, b) => b.last - a.last)
      .slice(0, n)
      .map((p) => p.text);
  }

  topPhrases(n: number): string[] {
    return [...this.phrases]
      .sort((a, b) => this.phraseScore(b) - this.phraseScore(a))
      .slice(0, n)
      .map((p) => p.text);
  }

  /** Words consistent with the typed slots, given the committed words before them. */
  wordCandidates(committed: string[], slots: Slot[], n: number): Suggestion[] {
    if (!slots.length) return [];
    const [prev2, prev] = this.ctx(committed);
    const bucket = this.index.get(slotKey(slots)) ?? [];
    const out: Suggestion[] = [];
    for (const w of bucket) {
      if (!matchesSlots(w, slots)) continue; // exact-letter slots narrow the group further
      // Completions (longer than typed) are useful but should not beat exact-length hits of similar frequency.
      const extra = w.length - slots.length;
      const score = this.wordScore(w, prev2, prev) * (extra === 0 ? 1 : 0.55 * Math.pow(0.85, extra - 1));
      out.push({ kind: "word", label: this.display(w), text: w, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
  }

  /**
   * Next-word predictions when nothing is being typed. Words seen in this context come first;
   * if there aren't enough, the slots are filled with the user's own frequent words, their
   * people and topics, then common words, so a chip is never left empty.
   */
  nextWords(committed: string[], n: number): Suggestion[] {
    const [prev2, prev] = this.ctx(committed);
    const tri = `${prev2} ${prev}`;
    const cands = new Set<string>([
      ...(this.trigrams.get(tri)?.keys() ?? []),
      ...(this.seedTrigrams.get(tri)?.keys() ?? []),
      ...(this.bigrams.get(prev)?.keys() ?? []),
      ...(this.seedBigrams.get(prev)?.keys() ?? []),
    ]);
    const recent = new Set(committed.slice(-3));
    const score = (w: string) => ({ kind: "word" as const, label: this.display(w), text: w, score: this.wordScore(w, prev2, prev) });
    const inContext = [...cands].filter((w) => !recent.has(w) && !isSlur(w)).map(score).sort((a, b) => b.score - a.score).slice(0, n);
    if (inContext.length >= n) return inContext;
    const have = new Set(inContext.map((s) => s.text));
    const fill = [
      ...[...this.personalWords.keys()].sort((a, b) => this.personalCount(b) - this.personalCount(a)).slice(0, 40),
      ...this.pinned.keys(),
      ...this.topics,
      ...this.topGlobal,
    ]
      .filter((w) => !have.has(w) && !recent.has(w) && w !== "<s>" && (have.add(w), true))
      .map(score)
      .sort((a, b) => b.score - a.score);
    return [...inContext, ...fill].slice(0, n);
  }

  /**
   * Phrases from the personal store that continue the committed words and are
   * consistent with the slots being typed for the next word.
   */
  phraseCompletions(committed: string[], slots: Slot[], n: number): Suggestion[] {
    const best = new Map<string, Suggestion>();
    for (const p of this.phrases) {
      const words = tokenize(p.text);
      const m = this.alignPhrase(committed, words);
      if (!m || m.at >= words.length) continue;
      if (slots.length && !matchesSlots(words[m.at], slots)) continue;
      let restWords = words.slice(m.at);
      if (restWords.length > WHOLE_PHRASE_WORDS) {
        // Cut long phrases, but never so the chip ends on a dangling "to" / "the" / "and".
        restWords = restWords.slice(0, MAX_PHRASE_CHIP_WORDS);
        while (restWords.length > 2 && STOPWORDS.has(restWords[restWords.length - 1])) restWords.pop();
      }
      // Phrases continuing the whole sentence beat ones matched on its last few words.
      const weight = m.fromStart ? 2 : 0.4 + 0.3 * Math.min(m.overlap, 3);
      // Keep the phrase's own capitals for names ("Priya"), but not a capital that only marked its sentence start.
      const raw = p.text.match(/[A-Za-z']+/g) ?? [];
      const shown = (w: string, at: number) => {
        if (w === "i") return "I";
        if (this.pinned.has(w)) return this.display(w);
        return at > 0 && raw[at]?.toLowerCase() === w ? raw[at] : w;
      };
      const rest = restWords.map((w, i) => (i === 0 && m.at === 0 ? cap(shown(w, 0)) : shown(w, m.at + i))).join(" ");
      const s: Suggestion = { kind: "phrase", label: rest, text: rest, score: this.phraseScore(p) * weight };
      if ((best.get(rest.toLowerCase())?.score ?? -1) < s.score) best.set(rest.toLowerCase(), s);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, n);
  }

  /**
   * Where a stored phrase continues what has been typed: either the sentence so far is the
   * start of the phrase, or the last typed words appear inside it (so "...can you tell Priya"
   * still finds "Tell Priya I love her"). A mid-sentence match needs at least two meaningful
   * words in common, or three words of any kind: one shared word ("...turn the game" vs
   * "watch the game together tonight") glues on endings that make no sense.
   */
  private alignPhrase(committed: string[], words: string[]): { at: number; overlap: number; fromStart: boolean } | null {
    if (committed.every((w, i) => words[i] === w)) return { at: committed.length, overlap: committed.length, fromStart: true };
    for (let k = Math.min(4, committed.length); k >= 1; k--) {
      const tail = committed.slice(-k);
      if (k < 3 && tail.filter((w) => !STOPWORDS.has(w)).length < 2) continue;
      for (let j = k; j < words.length; j++) {
        let ok = true;
        for (let i = 0; i < k && ok; i++) ok = words[j - k + i] === tail[i];
        if (ok) return { at: j, overlap: k, fromStart: false };
      }
    }
    return null;
  }

  /** Local abbreviation expansion: phrases whose word initials fit the slots. */
  expandInitials(slots: Slot[], n: number): Suggestion[] {
    return this.phrases
      .filter((p) => matchesInitials(p.text, slots))
      .sort((a, b) => this.phraseScore(b) - this.phraseScore(a))
      .slice(0, n)
      .map((p) => ({ kind: "phrase" as const, label: p.text, text: p.text, score: this.phraseScore(p) }));
  }

  /**
   * Mixed suggestion list for the chip row: at most `maxPhrases` phrase chips,
   * the rest single words. Deduplicated by label.
   */
  suggest(committed: string[], slots: Slot[], n = 4, maxPhrases = 1): Suggestion[] {
    const phrases = this.phraseCompletions(committed, slots, maxPhrases).filter(
      (p) => tokenize(p.text).length > 1,
    );
    const words = slots.length ? this.wordCandidates(committed, slots, n) : this.nextWords(committed, n);
    const seen = new Set<string>();
    const merged: Suggestion[] = [];
    for (const s of [...phrases, ...words]) {
      if (seen.has(s.label) || merged.length >= n) continue;
      seen.add(s.label);
      merged.push(s);
    }
    return merged;
  }
}
