// The two keyboards compared in the demo:
//  - GazeTypeKeyboard: 16 large targets (4x4) sized for 2–3° webcam error;
//    8 letter-group keys + prediction chips + personal phrases + abbreviation expansion.
//  - BaselineKeyboard: a standard letter-by-letter dwell QWERTY (optional word chips).
import { LETTER_GROUPS, tokenize, type PredictionEngine, type Slot, type Suggestion } from "../predict/engine";
import { llmPredict } from "../predict/llm";
import { containsSlur, isSlur, SLUR_NOTICE } from "../safety/slurs";
import type { EventKind } from "../metrics/session";
import { esc, g } from "./dom";

export interface KeyboardHost {
  /** Re-render requested (state changed asynchronously, e.g. LLM results arrived). */
  refresh(): void;
  /** Action keys that leave the keyboard (speak, insert, hide, recalibrate, settings). */
  action(name: string): void;
  overlay: boolean;
  /** Profiles the user can switch between by gaze. */
  profiles(): { id: string; name: string }[];
  activeProfileId(): string;
  /** A short message for the user (e.g. why a word was blocked). */
  notice(message: string): void;
  /** AI sentence suggestions are switched on (Settings). Word prediction is always on. Default on. */
  aiEnabled?(): boolean;
  /** A benchmark run is in progress (shows "Finish run" in the menu). */
  benchmarking?(): boolean;
}

export interface Keyboard {
  readonly name: string;
  render(root: HTMLElement): void;
  /** Handle a selected target id; returns what kind of selection it was (for metrics). */
  select(id: string): EventKind;
  text(): string;
  clear(): void;
  /** Clear, but Undo can bring it back. */
  clearUndoable(): void;
  undo(): boolean;
  canUndo(): boolean;
  deleteWord(): void;
  /** Add a whole phrase or sentence (Saved phrases). */
  appendText(text: string): void;
  displayHtml(): string;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** One key: a gaze target around a keycap. `kind` is the keycap style (grp, fn, chip, phr). Labels are escaped here. */
const key = (id: string, label: string, kind = "", sub = "", o: { on?: boolean; read?: boolean } = {}) =>
  g(id, `<span class="kl">${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}`, { face: `k ${kind}`.trim(), on: o.on, read: o.read });
const blank = () => `<div class="g blank"><div class="face k empty"></div></div>`;

type Panel = "home" | "main" | "phrases" | "menu" | "profiles" | "numbers" | { letters: string };

/**
 * Home screen: 6 large targets (3x2) = this many ready-to-speak phrases + "Keyboard".
 * Recorded pointer sessions hit 6 large buttons far more often than the 16-key grid
 * (mean 59% vs 32% of frames), so the grid is the fallback, one selection away.
 */
export const HOME_CHIPS = 5;
/** A home-screen chip: plain text, or text with a small label under it. */
export type HomeItem = string | { text: string; sub: string };

/** Longer chip text gets a smaller font so it fits the target instead of being cut off. */
const chipSize = (label: string) => (label.length > 34 ? " xlong" : label.length > 16 ? " long" : "");
/** How many steps Undo remembers. */
const UNDO_MAX = 60;

/** Wait this long after the last selection before asking the LLM, so quick selections send one request. */
const LLM_DEBOUNCE_MS = 150;
/** A chip that is deleted within this time counts as a rejected suggestion. */
const REJECT_MS = 2000;

export class GazeTypeKeyboard implements Keyboard {
  readonly name = "gazetype";
  committed: string[] = [];
  slots: Slot[] = [];
  spellMode = false;
  /** Start on (and return to) the 6-chip home screen. Off during typing benchmarks. */
  useHome = true;
  private panel: Panel = "home";
  /**
   * Phrases on the home screen. A provider so the conversation engine can supply replies to
   * what the partner said (listen/conversation.ts); defaults to the user's most-used phrases.
   * An item with `sub` shows that label under the text (e.g. "reply" for an AI reply).
   */
  homeSource: (n: number) => HomeItem[] = (n) => this.engine.topPhrases(n);
  private homeItems: string[] = [];

  get onHome() {
    return this.panel === "home";
  }
  private chips: Suggestion[] = [];
  private llmChips: Suggestion[] = [];
  private panelItems: Suggestion[] = [];
  private llmSeq = 0;
  private llmTimer: ReturnType<typeof setTimeout> | undefined;
  private llmAbort: AbortController | null = null;
  private lastPick: { word: string; before: string[]; at: number } | null = null;
  private undoStack: { committed: string[]; slots: Slot[] }[] = [];

  constructor(
    private engine: PredictionEngine,
    private host: KeyboardHost,
  ) {}

  text() {
    return this.committed.join(" ");
  }

  clear() {
    this.committed = [];
    this.slots = [];
    this.panel = this.useHome ? "home" : "main";
    this.undoStack = [];
    this.update();
  }

  private snapshot() {
    this.undoStack.push({ committed: [...this.committed], slots: [...this.slots] });
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
  }

  clearUndoable() {
    if (!this.committed.length && !this.slots.length) return;
    this.snapshot();
    this.committed = [];
    this.slots = [];
    // Clearing (and speaking) goes back to the start: the home screen, or the grid in benchmarks.
    this.panel = this.useHome ? "home" : "main";
    this.update();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.committed = prev.committed;
    this.slots = prev.slots;
    this.panel = "main";
    this.lastPick = null;
    this.update();
    return true;
  }

  deleteWord() {
    if (!this.committed.length && !this.slots.length) return;
    this.snapshot();
    if (this.slots.length) this.slots = [];
    else this.committed.pop();
    this.lastPick = null;
    this.update();
  }

  appendText(text: string) {
    this.snapshot();
    this.commitSentence(`${this.text()} ${text}`);
    this.panel = "main";
    this.update();
  }

  private committedTokens() {
    return tokenize(this.text());
  }

  /** Last local suggestion time in ms (shown in the status bar). */
  lastSuggestMs = 0;

  /** Cancel any LLM request in flight or waiting to be sent: its answer would be for old text. */
  private cancelLlm() {
    clearTimeout(this.llmTimer);
    this.llmAbort?.abort();
    this.llmAbort = null;
  }

  /** Recompute local suggestions now, and kick off an LLM request in the background. */
  update() {
    const words = this.committedTokens();
    const t0 = performance.now();
    this.chips = this.engine.suggest(words, this.slots, 4, 1);
    this.lastSuggestMs = performance.now() - t0;
    this.llmChips = [];
    const seq = ++this.llmSeq;
    this.cancelLlm();
    // Ask the LLM for sentence continuations once there is some context and no word in progress.
    if (!this.slots.length && words.length >= 1 && this.host.aiEnabled?.() !== false) {
      const text = this.text();
      this.llmTimer = setTimeout(() => {
        const ctrl = (this.llmAbort = new AbortController());
        void llmPredict({ task: "continue", text, history: this.engine.recentSentences(8), n: 2 }, ctrl.signal).then((s) => {
        if (seq !== this.llmSeq) return;
        this.llmChips = s
          .map((full) => full.trim())
          .filter((full) => full.toLowerCase() !== this.text().toLowerCase())
          .map((full) => ({ kind: "llm" as const, label: full.slice(this.text().length).trim(), text: full, score: 0 }))
          .filter((c) => c.label);
        this.host.refresh();
        });
      }, LLM_DEBOUNCE_MS);
    }
  }

  /** Chips shown: local first, then at most one LLM sentence in the last slot (unless a phrase chip already says it). */
  private visibleChips(): (Suggestion | null)[] {
    const out: (Suggestion | null)[] = this.chips.slice(0, 4);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z' ]/g, "").trim();
    const shown = new Set(this.chips.map((c) => norm(c.label)));
    const ai = this.llmChips.find((c) => !shown.has(norm(c.label)));
    if (ai) out.splice(3, 1, ai);
    while (out.length < 4) out.push(null);
    return out;
  }

  private preview(): string {
    if (!this.slots.length) return "";
    const top = this.chips.find((c) => c.kind === "word");
    return top ? top.label : this.slots.map((s) => (s.length === 1 ? s : "·")).join("");
  }

  render(root: HTMLElement) {
    root.className = "tray";
    const p = this.panel;
    if (p === "home") {
      const src = this.homeSource(HOME_CHIPS).slice(0, HOME_CHIPS);
      const items = src.map((it) => (typeof it === "string" ? { text: it, sub: "speak" } : it));
      this.homeItems = items.map((it) => it.text);
      root.innerHTML =
        items.map((it, i) => key(`home:${i}`, it.text, `phr${it.sub === "reply" ? " ai" : ""}${chipSize(it.text)}`, it.sub, { read: true })).join("") +
        Array.from({ length: HOME_CHIPS - items.length }, blank).join("") +
        key("keyboard", "Keyboard", "fn", "type something new");
      root.className = "tray home";
    } else if (p === "main") {
      const chips = this.visibleChips()
        .map((c, i) =>
          c ? key(`chip:${i}`, c.label, `chip${c.kind === "llm" ? " ai" : ""}${chipSize(c.label)}`, c.kind === "llm" ? "AI" : c.kind === "phrase" ? "phrase" : "", { read: c.kind !== "word" }) : blank(),
        )
        .join("");
      const group = (i: number) => key(`g:${i}`, LETTER_GROUPS[i].toUpperCase(), "grp");
      const n = this.slots.length;
      // Rows 2–3: the eight letter groups in alphabetical order (ABC DEF GHI JKL / MNO PQRS TUV WXYZ),
      // so a key is always where you expect it. Row 4: the controls.
      root.innerHTML =
        chips +
        [0, 1, 2, 3, 4, 5, 6, 7].map(group).join("") +
        key("del", "Delete", "fn", n ? "letter" : "word") +
        key("space", "Space", "fn", n ? "accept" : "") +
        key("phrases", n >= 2 ? "Expand" : "Phrases", "fn", n >= 2 ? "initials to sentence" : "") +
        key("menu", "Done", "fn", "speak and more");
    } else if (p === "phrases") {
      const items = this.panelItems.slice(0, 6);
      root.innerHTML =
        items.map((s, i) => key(`pi:${i}`, s.label, "phr", s.kind === "llm" ? "AI" : "", { read: true })).join("") +
        Array.from({ length: 6 - items.length }, blank).join("") +
        key("back", "Back", "fn") +
        key("menu", "Done", "fn");
      root.className = "tray rows2";
    } else if (p === "menu") {
      const me = this.host.profiles().find((p) => p.id === this.host.activeProfileId());
      const ov = this.host.overlay;
      root.innerHTML =
        key("act:speak", "Speak", "fn") +
        (ov ? key("act:insert", "Insert", "fn", "into app") : key("act:copy", "Copy", "fn")) +
        key("act:clear", this.useHome ? "Home" : "Clear", "fn", this.useHome ? "clears text" : "") +
        key("act:spell", `Spell: ${this.spellMode ? "On" : "Off"}`, "fn", "exact letters", { on: this.spellMode }) +
        key("act:voice", "My voice", "fn") +
        key("act:phrases", "Saved phrases", "fn") +
        key("act:recent", "Recent", "fn", "say again") +
        key("act:numbers", "Numbers", "fn", "times, amounts") +
        key("act:access", "Accessibility", "fn") +
        key("act:settings", "Settings", "fn") +
        key("act:recal", "Recalibrate", "fn") +
        key("act:recenter", "Re-centre", "fn", "or blink 3 times") +
        key("act:profiles", "Switch user", "fn", me?.name ?? "") +
        key("act:rest", "Rest", "fn", "pause eye tracking") +
        (this.host.benchmarking?.() ? key("act:benchmark-done", "Finish run", "fn") : ov ? key("act:hide", "Hide", "fn") : blank()) +
        key("back", "Back", "fn");
    } else if (p === "numbers") {
      root.innerHTML =
        [..."1234567890"].map((d) => key(`l:${d}`, d, "grp")).join("") +
        key("space", "Space", "fn", this.slots.length ? "accept" : "") +
        key("del", "Delete", "fn") +
        blank() + blank() + blank() +
        key("back", "Back", "fn", "to letters");
    } else if (p === "profiles") {
      const list = this.host.profiles().slice(0, 7);
      const active = this.host.activeProfileId();
      root.innerHTML =
        list.map((pr) => key(`prof:${pr.id}`, pr.name, `fn${pr.id === active ? " cur" : ""}`, pr.id === active ? "current" : "")).join("") +
        Array.from({ length: 7 - list.length }, blank).join("") +
        key("back", "Back", "fn");
      root.className = "tray rows2";
    } else {
      const letters = p.letters.split("");
      root.innerHTML =
        letters.map((l) => key(`l:${l}`, l.toUpperCase(), "grp")).join("") +
        Array.from({ length: 4 - letters.length }, blank).join("") +
        key("back", "Back", "fn");
      root.className = "tray letters";
    }
  }

  /** Text shown in the output bar, with the in-progress word highlighted. */
  displayHtml(): string {
    const pv = this.preview();
    if (!this.text() && !pv) return `<span class="caret"></span><span class="ph">Look at a key to begin your message</span>`;
    return `${esc(this.text())}${pv ? `${this.text() ? " " : ""}<span class="pending">${esc(pv)}</span>` : ""}<span class="caret"></span>`;
  }

  private commitWord(w: string) {
    // Slurs can't be entered, however they're typed (suggestions never offer them; this catches spell mode).
    if (isSlur(w)) {
      this.slots = [];
      this.host.notice(SLUR_NOTICE);
      return;
    }
    const shown = this.engine.display(w);
    this.committed.push(this.committed.length === 0 ? cap(shown) : w === "i" ? "I" : shown);
    this.slots = [];
  }

  private commitSentence(full: string) {
    if (containsSlur(full)) {
      this.slots = [];
      this.host.notice(SLUR_NOTICE);
      return;
    }
    const words = full.trim().split(/\s+/).map((w) => (w === "i" ? "I" : w));
    if (words.length) words[0] = cap(words[0]);
    this.committed = words;
    this.slots = [];
  }

  private openPhrases() {
    this.panel = "phrases";
    if (this.slots.length >= 2) {
      const slots = [...this.slots];
      this.panelItems = this.engine.expandInitials(slots, 6);
      const seq = ++this.llmSeq;
      this.cancelLlm();
      const ctrl = (this.llmAbort = new AbortController());
      void llmPredict({ task: "expand", text: this.text(), slots, history: this.engine.recentSentences(8), n: 4 }, ctrl.signal).then((s) => {
        if (seq !== this.llmSeq || this.panel !== "phrases") return;
        const have = new Set(this.panelItems.map((p) => p.text.toLowerCase()));
        for (const full of s) if (!have.has(full.toLowerCase())) this.panelItems.push({ kind: "llm", label: full, text: full, score: 0 });
        this.host.refresh();
      });
    } else {
      this.panelItems = this.engine.topPhrases(6).map((t) => ({ kind: "phrase" as const, label: t, text: t, score: 0 }));
    }
  }

  select(id: string): EventKind {
    const [kind, arg] = id.split(":");
    let ev: EventKind = "other";
    if (["g", "l", "chip", "space", "del", "pi"].includes(kind) && !(kind === "g" && this.spellMode)) this.snapshot();
    switch (kind) {
      case "home": {
        // One selection = one message: speak the phrase straight away (speaking clears and returns home).
        const t = this.homeItems[Number(arg)];
        if (!t) return "other";
        this.commitSentence(t);
        this.host.action("speak");
        return "phrase";
      }
      case "keyboard":
        this.panel = "main";
        this.update();
        return "other";
      case "g": {
        const g = LETTER_GROUPS[Number(arg)];
        if (this.spellMode) {
          this.panel = { letters: g };
          return "letter";
        }
        this.slots.push(g);
        ev = "letter";
        break;
      }
      case "l":
        this.slots.push(arg);
        if (this.panel !== "numbers") this.panel = "main";
        ev = "letter";
        break;
      case "chip": {
        const c = this.visibleChips()[Number(arg)];
        if (!c) return "other";
        if (c.kind === "word") {
          this.lastPick = { word: c.text, before: this.committedTokens(), at: Date.now() };
          this.commitWord(c.text);
          ev = "word";
        } else if (c.kind === "phrase") {
          this.slots = [];
          this.commitSentence(`${this.text()} ${c.text}`);
          ev = "phrase";
        } else {
          this.commitSentence(c.text);
          ev = "phrase";
        }
        break;
      }
      case "space": {
        if (this.slots.length) {
          const top = this.chips.find((c) => c.kind === "word");
          const literal = this.slots.every((s) => s.length === 1) ? this.slots.join("") : null;
          this.commitWord(top?.text ?? literal ?? this.slots.map((s) => s[0]).join(""));
        }
        ev = "space";
        break;
      }
      case "del": {
        if (this.slots.length) this.slots.pop();
        else {
          const removed = this.committed.pop();
          // Picked a suggested word and deleted it straight away: that suggestion was wrong here.
          const pick = this.lastPick;
          if (pick && removed?.toLowerCase() === pick.word && Date.now() - pick.at < REJECT_MS) this.engine.reject(pick.before, pick.word);
        }
        this.lastPick = null;
        ev = "delete";
        break;
      }
      case "prof":
        this.panel = "main";
        this.host.action(`profile:${arg}`);
        return "other";
      case "phrases":
        this.openPhrases();
        this.host.refresh();
        return "expand";
      case "pi": {
        const it = this.panelItems[Number(arg)];
        if (!it) return "other";
        // Expansion results replace the abbreviation; stored phrases start a new sentence or replace.
        this.commitSentence(this.slots.length >= 2 ? `${this.text()} ${it.text}` : it.text);
        this.panel = "main";
        ev = "phrase";
        break;
      }
      case "menu":
        this.panel = "menu";
        return "other";
      case "back":
        this.panel = "main";
        return "other";
      case "act":
        if (arg === "spell") {
          this.spellMode = !this.spellMode;
          return "other";
        }
        if (arg === "profiles") {
          this.panel = "profiles";
          return "other";
        }
        if (arg === "clear") {
          this.clearUndoable();
          return "delete";
        }
        if (arg === "numbers") {
          this.panel = "numbers";
          return "other";
        }
        this.panel = "main";
        this.host.action(arg);
        return "other";
    }
    this.update();
    return ev;
  }
}

const QWERTY = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

export class BaselineKeyboard implements Keyboard {
  readonly name = "baseline-qwerty";
  value = "";
  private chips: Suggestion[] = [];
  private undoStack: string[] = [];

  constructor(
    private engine: PredictionEngine,
    private host: KeyboardHost,
    public withPrediction = false,
  ) {}

  text() {
    return this.value;
  }

  clear() {
    this.value = "";
    this.undoStack = [];
    this.update();
  }

  private snapshot() {
    this.undoStack.push(this.value);
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
  }

  clearUndoable() {
    if (!this.value) return;
    this.snapshot();
    this.value = "";
    this.update();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    this.value = prev;
    this.update();
    return true;
  }

  deleteWord() {
    if (!this.value) return;
    this.snapshot();
    this.value = this.value.replace(/\s*\S+\s*$/, "");
    this.update();
  }

  appendText(text: string) {
    this.snapshot();
    this.value = `${this.value && !/\s$/.test(this.value) ? `${this.value} ` : this.value}${text} `;
    this.update();
  }

  private update() {
    if (!this.withPrediction) return;
    const words = tokenize(this.value);
    const partial = /[a-z']$/i.test(this.value) ? words.pop() ?? "" : "";
    this.chips = partial ? this.engine.wordCandidates(words, [...partial.toLowerCase()], 3) : this.engine.nextWords(words, 3);
  }

  render(root: HTMLElement) {
    root.className = "tray baseline";
    const chips = this.withPrediction
      ? `<div class="krow">${[0, 1, 2].map((i) => (this.chips[i] ? key(`chip:${i}`, this.chips[i].label, "chip") : blank())).join("")}</div>`
      : "";
    root.innerHTML =
      chips +
      QWERTY.map((r) => `<div class="krow">${[...r].map((c) => key(`k:${c}`, c.toUpperCase())).join("")}</div>`).join("") +
      `<div class="krow">${key("del", "Delete", "fn")}${g("space", `<span class="kl">Space</span>`, { cls: "wide", face: "k fn" })}${key("act:speak", "Speak", "fn")}${this.host.benchmarking?.() ? key("act:benchmark-done", "Finish run", "fn") : ""}${this.host.overlay ? key("act:insert", "Insert", "fn") : ""}</div>`;
  }

  displayHtml() {
    if (!this.value) return `<span class="caret"></span><span class="ph">Look at a key to begin your message</span>`;
    return `${esc(this.value)}<span class="caret"></span>`;
  }

  select(id: string): EventKind {
    const [kind, arg] = id.split(":");
    let ev: EventKind = "other";
    if (kind === "k" || kind === "space" || kind === "del" || kind === "chip") this.snapshot();
    if (kind === "k") {
      this.value += this.value.length === 0 ? arg.toUpperCase() : arg;
      ev = "letter";
    } else if (kind === "space") {
      const last = this.value.match(/\S+$/)?.[0] ?? "";
      if (isSlur(last)) {
        this.value = this.value.slice(0, this.value.length - last.length); // remove the word, not just block the space
        this.host.notice(SLUR_NOTICE);
        ev = "delete";
      } else {
        this.value += " ";
        ev = "space";
      }
    } else if (kind === "del") {
      this.value = this.value.slice(0, -1);
      ev = "delete";
    } else if (kind === "chip") {
      const c = this.chips[Number(arg)];
      if (c) {
        this.value = this.value.replace(/[a-z']*$/i, "") + c.text + " ";
        ev = "word";
      }
    } else if (kind === "act") {
      this.host.action(arg);
    }
    this.update();
    return ev;
  }
}
