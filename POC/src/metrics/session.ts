// Text-entry metrics in the units the literature uses: WPM, selections per
// character (≈ KSPC), and minimum-string-distance error rate.

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export const normalizeText = (s: string) => s.toLowerCase().replace(/[^a-z' ]/g, "").replace(/\s+/g, " ").trim();

/** Standard WPM: (|T| - 1) / 5 words per minute (MacKenzie). */
export function wpm(chars: number, ms: number): number {
  if (ms <= 0 || chars <= 1) return 0;
  return ((chars - 1) / 5) / (ms / 60000);
}

export type EventKind = "letter" | "word" | "phrase" | "space" | "delete" | "expand" | "other";

export interface RunResult {
  id: string;
  keyboard: string;
  selectionMode: string;
  target: string;
  typed: string;
  ms: number;
  wpm: number;
  selections: number;
  selectionsPerChar: number;
  deletes: number;
  /** Selections undone by a delete within 2 s — a proxy for false (Midas-touch) selections. */
  likelyFalseSelections: number;
  errorRate: number;
  rejectedBlinks?: number;
  date: string;
}

export class TypingSession {
  private events: { t: number; kind: EventKind }[] = [];
  startT: number | null = null;

  constructor(
    public keyboard: string,
    public selectionMode: string,
    public target = "",
  ) {}

  record(t: number, kind: EventKind) {
    if (this.startT === null) this.startT = t;
    this.events.push({ t, kind });
  }

  get selections() {
    return this.events.length;
  }

  finish(t: number, typed: string, extra: Partial<RunResult> = {}): RunResult {
    const ms = this.startT === null ? 0 : t - this.startT;
    const text = normalizeText(typed);
    const target = normalizeText(this.target);
    let likelyFalse = 0;
    for (let i = 1; i < this.events.length; i++) {
      const e = this.events[i];
      const p = this.events[i - 1];
      if (e.kind === "delete" && p.kind !== "delete" && e.t - p.t < 2000) likelyFalse++;
    }
    const chars = text.length;
    return {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      keyboard: this.keyboard,
      selectionMode: this.selectionMode,
      target,
      typed: text,
      ms,
      wpm: wpm(chars, ms),
      selections: this.events.length,
      selectionsPerChar: chars ? this.events.length / chars : 0,
      deletes: this.events.filter((e) => e.kind === "delete").length,
      likelyFalseSelections: likelyFalse,
      errorRate: target ? levenshtein(text, target) / Math.max(text.length, target.length, 1) : 0,
      date: new Date().toISOString(),
      ...extra,
    };
  }
}
