// On-device prediction engine: ambiguous-key (letter-group) decoding, word
// completion, next-word prediction from a personal bigram model, and a personal
// phrase store that learns from everything the user speaks.
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

interface PhraseEntry {
  text: string;
  count: number;
  last: number;
}

const KEY_WORDS = "gazetype.words.v1";
const KEY_BIGRAMS = "gazetype.bigrams.v1";
const KEY_PHRASES = "gazetype.phrases.v1";

export class PredictionEngine {
  private unigram = new Map<string, number>();
  private personalWords = new Map<string, number>();
  private bigrams = new Map<string, Map<string, number>>();
  private phrases: PhraseEntry[] = [];

  constructor(
    private readonly store: Store = memoryStore(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Frequency-ranked word list (most common first) plus AAC core words and seed phrases. */
  load(rankedWords: string[], coreWords: string[], seedPhrases: string[]): void {
    rankedWords.forEach((w, rank) => {
      const word = w.trim().toLowerCase();
      if (word && !this.unigram.has(word)) this.unigram.set(word, 1 / (rank + 10));
    });
    // Core AAC vocabulary ("pain", "nurse", "suction"...) is boosted to top-200 frequency.
    for (const w of coreWords) {
      const word = w.toLowerCase();
      this.unigram.set(word, Math.max(this.unigram.get(word) ?? 0, 1 / 200));
    }
    this.restore();
    if (!this.phrases.length) {
      this.phrases = seedPhrases.map((text) => ({ text, count: 1, last: 0 }));
    }
    for (const p of seedPhrases) this.addBigrams(tokenize(p), 0.5);
  }

  private restore() {
    try {
      const w = this.store.get(KEY_WORDS);
      if (w) this.personalWords = new Map(JSON.parse(w));
      const b = this.store.get(KEY_BIGRAMS);
      if (b) this.bigrams = new Map((JSON.parse(b) as [string, [string, number][]][]).map(([k, v]) => [k, new Map(v)]));
      const p = this.store.get(KEY_PHRASES);
      if (p) this.phrases = JSON.parse(p);
    } catch {
      /* corrupt storage: start fresh */
    }
  }

  private persist() {
    this.store.set(KEY_WORDS, JSON.stringify([...this.personalWords]));
    this.store.set(KEY_BIGRAMS, JSON.stringify([...this.bigrams].map(([k, v]) => [k, [...v]])));
    this.store.set(KEY_PHRASES, JSON.stringify(this.phrases));
  }

  private addBigrams(words: string[], weight = 1) {
    const seq = ["<s>", ...words];
    for (let i = 1; i < seq.length; i++) {
      const m = this.bigrams.get(seq[i - 1]) ?? new Map<string, number>();
      m.set(seq[i], (m.get(seq[i]) ?? 0) + weight);
      this.bigrams.set(seq[i - 1], m);
    }
  }

  private pNext(prev: string, w: string): number {
    const m = this.bigrams.get(prev);
    if (!m) return 0;
    let total = 0;
    for (const c of m.values()) total += c;
    return (m.get(w) ?? 0) / total;
  }

  private wordScore(w: string, prev: string): number {
    const base = this.unigram.get(w) ?? 0;
    const personal = this.personalWords.get(w) ?? 0;
    return (base + 0.02 * personal) * (1 + 30 * this.pNext(prev, w));
  }

  /** Learn from a sentence the user committed (spoke / inserted). */
  learn(sentence: string): void {
    const words = tokenize(sentence);
    if (!words.length) return;
    for (const w of words) this.personalWords.set(w, (this.personalWords.get(w) ?? 0) + 1);
    this.addBigrams(words);
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
    const prev = committed.at(-1) ?? "<s>";
    const out: Suggestion[] = [];
    const vocab = new Set([...this.unigram.keys(), ...this.personalWords.keys()]);
    for (const w of vocab) {
      if (!matchesSlots(w, slots)) continue;
      // Completions (longer than typed) are useful but should not beat exact-length hits of similar frequency.
      const extra = w.length - slots.length;
      const score = this.wordScore(w, prev) * (extra === 0 ? 1 : 0.55 * Math.pow(0.85, extra - 1));
      out.push({ kind: "word", label: w, text: w, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
  }

  /** Next-word predictions when nothing is being typed. */
  nextWords(committed: string[], n: number): Suggestion[] {
    const prev = committed.at(-1) ?? "<s>";
    const m = this.bigrams.get(prev);
    const cands = m ? [...m.keys()] : [];
    return cands
      .map((w) => ({ kind: "word" as const, label: w, text: w, score: this.wordScore(w, prev) }))
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
