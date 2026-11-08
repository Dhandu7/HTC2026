// The other side of the conversation. The partner's speech is transcribed (listen/partner.ts), each finished
// sentence becomes a turn here, and the AI proposes replies that go on the home screen as ready-to-speak chips
// (ui/keyboards.ts `homeSource`). Pure TypeScript, so the rules below are unit-tested without a browser:
//
//   - a transcript line that repeats the last one within a short window is the recogniser restarting, not a
//     new sentence;
//   - the microphone hears the app's own voice through the speakers, so anything that matches what the app
//     just said is dropped as an echo;
//   - replies that only repeat the user's standard phrases are dropped (the home screen already has those).
//
// Shared with the Node server (server/llm.ts) for the reply filter, like safety/slurs.ts.

export interface Turn {
  who: "them" | "me";
  text: string;
  at: number;
}

/** Words only, lower case: "How's it going?!" -> "how's it going". */
export const norm = (s: string) => (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).join(" ");

/** A heard sentence that is contained in, or contains, something the app said recently is the app's own voice. */
export function isEcho(heard: string, saidRecently: string[]): boolean {
  const h = norm(heard);
  if (!h) return true;
  return saidRecently.some((s) => {
    const n = norm(s);
    if (!n) return false;
    if (h === n || h.includes(n) || n.includes(h)) return true;
    // Partial echo: most of the heard words are in what was said, in order.
    const hw = h.split(" ");
    const nw = new Set(n.split(" "));
    const shared = hw.filter((w) => nw.has(w)).length;
    return hw.length >= 3 && shared / hw.length >= 0.75;
  });
}

const MAX_REPLY_WORDS = 14;

/** Keep replies that are short, new and different from each other. `n` at most. */
export function filterReplies(out: string[], opts: { n: number; known?: string[]; blocked?: (s: string) => boolean }): string[] {
  const known = new Set((opts.known ?? []).map(norm));
  const seen = new Set<string>();
  const keep: string[] = [];
  for (const raw of out) {
    const s = raw.trim().replace(/\s+/g, " ");
    const k = norm(s);
    if (!k || seen.has(k) || known.has(k)) continue;
    if (k.split(" ").length > MAX_REPLY_WORDS) continue;
    if (opts.blocked?.(s)) continue;
    seen.add(k);
    keep.push(s);
    if (keep.length >= opts.n) break;
  }
  return keep;
}

/** The home screen: AI replies first, then the user's usual phrases to fill the remaining slots. */
export function homeItems(replies: string[], phrases: string[], n: number): string[] {
  const seen = new Set(replies.map(norm));
  const out = replies.slice(0, n);
  for (const p of phrases) {
    if (out.length >= n) break;
    if (seen.has(norm(p))) continue;
    seen.add(norm(p));
    out.push(p);
  }
  return out;
}

export interface ConversationOpts {
  now?: () => number;
  /** A line heard again within this window is the recogniser repeating itself. */
  repeatMs?: number;
  /** How long after the app speaks its own voice may still be picked up. */
  echoMs?: number;
  maxTurns?: number;
}

export class Conversation {
  private turns: Turn[] = [];
  /** What the app said recently, newest first, for the echo filter. */
  private said: { text: string; at: number }[] = [];
  /** Replies for the latest thing the partner said; cleared when the user answers. */
  replies: string[] = [];
  /** Words heard so far of a sentence still being spoken. */
  interim = "";
  private readonly now: () => number;
  private readonly repeatMs: number;
  private readonly echoMs: number;
  private readonly maxTurns: number;

  constructor(o: ConversationOpts = {}) {
    this.now = o.now ?? (() => Date.now());
    this.repeatMs = o.repeatMs ?? 4000;
    this.echoMs = o.echoMs ?? 6000;
    this.maxTurns = o.maxTurns ?? 12;
  }

  /** The app is about to speak `text`: remember it so the microphone doesn't feed it back. */
  spoke(text: string) {
    const at = this.now();
    this.said = [{ text, at }, ...this.said.filter((s) => at - s.at < this.echoMs * 4)].slice(0, 6);
    this.turns.push({ who: "me", text: text.trim(), at });
    this.trim();
    this.replies = [];
    this.interim = "";
  }

  /**
   * A finished sentence from the partner. Returns the new turn, or null when it was an echo of the app's own
   * voice, a repeat, or empty.
   */
  heard(text: string): Turn | null {
    const t = text.trim().replace(/\s+/g, " ");
    this.interim = "";
    const at = this.now();
    if (!norm(t)) return null;
    const recent = this.said.filter((s) => at - s.at < this.echoMs).map((s) => s.text);
    if (isEcho(t, recent)) return null;
    const last = this.turns[this.turns.length - 1];
    if (last?.who === "them" && norm(last.text) === norm(t) && at - last.at < this.repeatMs) return null;
    const turn: Turn = { who: "them", text: t, at };
    this.turns.push(turn);
    this.trim();
    return turn;
  }

  /** The latest thing the partner said, if that is the newest turn. */
  latest(): Turn | null {
    const last = this.turns[this.turns.length - 1];
    return last?.who === "them" ? last : null;
  }

  /** Earlier turns, oldest first, for the AI's context. */
  transcript(n = 8): { who: "them" | "me"; text: string }[] {
    return this.turns.slice(-n).map(({ who, text }) => ({ who, text }));
  }

  clear() {
    this.turns = [];
    this.replies = [];
    this.interim = "";
  }

  private trim() {
    if (this.turns.length > this.maxTurns) this.turns = this.turns.slice(-this.maxTurns);
  }
}
