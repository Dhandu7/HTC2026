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
const KEY_BIGRAMS = "gazetype.bigrams.v1";
const KEY_TRIGRAMS = "gazetype.trigrams.v1";
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

export class PredictionEngine {
  // Global (shared by all profiles)
  private unigram = new Map<string, number>();
  private unigramTotal = 1;
  private seedPhrases: string[] = [];
  // Personal (per profile, persisted in the Store)
  private personalWords = new Map<string, WordStat>();
  private personalTotal = 0;
  private bigrams: Counts = new Map();
  private trigrams: Counts = new Map();
  private phrases: PhraseEntry[] = [];
  private pinned = new Map<string, string>(); // lowercase -> display casing
  private penalty = new Map<string, number>(); // "prev word" -> number of rejections
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
    this.seedPhrases = seedPhrases;
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
    this.restore();
    if (!this.phrases.length) this.phrases = this.seedPhrases.map((text) => ({ text, count: SEED_PHRASE_COUNT, last: 0 }));
    for (const p of this.seedPhrases) this.addNgrams(tokenize(p), 0.5);
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
      this.bigrams = parseCounts(this.store.get(KEY_BIGRAMS));
      this.trigrams = parseCounts(this.store.get(KEY_TRIGRAMS));
      const p = this.store.get(KEY_PHRASES);
      if (p) this.phrases = JSON.parse(p);
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
  }

  // ---------- index ----------

  private rebuildIndex() {
    this.vocab = new Set();
    this.index = new Map();
    for (const w of this.unigram.keys()) this.indexWord(w);
    for (const w of this.personalWords.keys()) this.indexWord(w);
    for (const w of this.pinned.keys()) this.indexWord(w);
  }

  private indexWord(w: string) {
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

  private addNgrams(words: string[], weight = 1) {
    const seq = ["<s>", ...words];
    for (let i = 1; i < seq.length; i++) {
      this.bump(this.bigrams, seq[i - 1], seq[i], weight);
      if (i >= 2) this.bump(this.trigrams, `${seq[i - 2]} ${seq[i - 1]}`, seq[i], weight);
      else this.bump(this.trigrams, `<s> <s>`, seq[i], weight);
    }
  }

  private prob(c: Counts, ctx: string, w: string): number {
    const m = c.get(ctx);
    if (!m) return 0;
    let total = this.totals.get(m);
    if (total === undefined) {
      total = 0;
      for (const v of m.values()) total += v;
      this.totals.set(m, total);
    }
    return total > 0 ? (m.get(w) ?? 0) / total : 0;
  }

  /** Stupid-backoff context probability: trigram if seen, else discounted bigram. */
  private pContext(prev2: string, prev: string, w: string): number {
    const tri = this.prob(this.trigrams, `${prev2} ${prev}`, w);
    return tri > 0 ? tri : BACKOFF * this.prob(this.bigrams, prev, w);
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
    if (!words.length) return;
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
        if (!w) continue;
        this.pinned.set(w, part.replace(/[^A-Za-z']/g, ""));
        this.indexWord(w);
      }
    }
    this.persist();
  }

  /** Display form of a word (names keep their capital letters). */
  display(w: string): string {
    return this.pinned.get(w) ?? w;
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

  /** Next-word predictions when nothing is being typed. */
  nextWords(committed: string[], n: number): Suggestion[] {
    const [prev2, prev] = this.ctx(committed);
    const cands = new Set<string>([
      ...(this.trigrams.get(`${prev2} ${prev}`)?.keys() ?? []),
      ...(this.bigrams.get(prev)?.keys() ?? []),
    ]);
    return [...cands]
      .map((w) => ({ kind: "word" as const, label: this.display(w), text: w, score: this.wordScore(w, prev2, prev) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  /**
   * Phrases from the personal store that continue the committed words and are
   * consistent with the slots being typed for the next word.
   */
  phraseCompletions(committed: string[], slots: Slot[], n: number): Suggestion[] {
    const out: Suggestion[] = [];
    for (const p of this.phrases) {
      const words = tokenize(p.text);
      if (words.length <= committed.length) continue;
      if (!committed.every((w, i) => words[i] === w)) continue;
      const next = words[committed.length];
      if (slots.length && !matchesSlots(next, slots)) continue;
      const rest = p.text.split(/\s+/).slice(committed.length).join(" ");
      out.push({ kind: "phrase", label: rest, text: rest, score: this.phraseScore(p) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
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
