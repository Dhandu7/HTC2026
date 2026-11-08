// The two keyboards compared in the demo:
//  - GazeTypeKeyboard: 16 large targets (4x4) sized for 2–3° webcam error;
//    8 letter-group keys + prediction chips + personal phrases + abbreviation expansion.
//  - BaselineKeyboard: a standard letter-by-letter dwell QWERTY (optional word chips).
import { LETTER_GROUPS, tokenize, type PredictionEngine, type Slot, type Suggestion } from "../predict/engine";
import { llmPredict } from "../predict/llm";
import type { EventKind } from "../metrics/session";

export interface KeyboardHost {
  /** Re-render requested (state changed asynchronously, e.g. LLM results arrived). */
  refresh(): void;
  /** Action keys that leave the keyboard (speak, insert, hide, recalibrate, settings). */
  action(name: string): void;
  overlay: boolean;
  /** Profiles the user can switch between by gaze. */
  profiles(): { id: string; name: string }[];
  activeProfileId(): string;
}

export interface Keyboard {
  readonly name: string;
  render(root: HTMLElement): void;
  /** Handle a selected target id; returns what kind of selection it was (for metrics). */
  select(id: string): EventKind;
  text(): string;
  clear(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const btn = (id: string, label: string, cls = "", sub = "") =>
  `<button class="key ${cls}" data-target="${esc(id)}"><span class="lbl">${label}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</button>`;

type Panel = "main" | "phrases" | "menu" | "profiles" | { letters: string };

/** Longer chip text gets a smaller font so it fits the target instead of being cut off. */
const chipSize = (label: string) => (label.length > 34 ? " xlong" : label.length > 16 ? " long" : "");

/** Wait this long after the last selection before asking the LLM, so quick selections send one request. */
const LLM_DEBOUNCE_MS = 150;
/** A chip that is deleted within this time counts as a rejected suggestion. */
const REJECT_MS = 2000;

export class GazeTypeKeyboard implements Keyboard {
  readonly name = "gazetype";
  committed: string[] = [];
  slots: Slot[] = [];
  spellMode = false;
  private panel: Panel = "main";
  private chips: Suggestion[] = [];
  private llmChips: Suggestion[] = [];
  private panelItems: Suggestion[] = [];
  private llmSeq = 0;
  private llmTimer: ReturnType<typeof setTimeout> | undefined;
  private llmAbort: AbortController | null = null;
  private lastPick: { word: string; before: string[]; at: number } | null = null;

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
    if (!this.slots.length && words.length >= 1) {
      const text = this.text();
      this.llmTimer = setTimeout(() => {
        const ctrl = (this.llmAbort = new AbortController());
        void llmPredict({ task: "continue", text, history: this.engine.topPhrases(8), n: 2 }, ctrl.signal).then((s) => {
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
    root.className = "board gazetype";
    const p = this.panel;
    if (p === "main") {
      const chips = this.visibleChips()
        .map((c, i) =>
          c
            ? btn(`chip:${i}`, esc(c.label), `chip ${c.kind}${chipSize(c.label)}`, c.kind === "llm" ? "✨ AI" : c.kind === "phrase" ? "phrase" : "")
            : `<div class="key chip empty"></div>`,
        )
        .join("");
      const group = (i: number) => btn(`g:${i}`, LETTER_GROUPS[i].toUpperCase(), "group");
      const phrasesLabel = this.slots.length >= 2 ? "✨ Expand" : "💬 Phrases";
      const phrasesSub = this.slots.length >= 2 ? "initials → sentence" : "";
      // ⌫ sits one step in from the edge (row 3, column 2): the pointer struggles to reach the
      // corners, bottom-left worst of all, and delete is used constantly. The least-used
      // letter group (WXYZ) takes the bottom-left corner instead. Letters keep reading order.
      root.innerHTML =
        chips +
        [0, 1, 2, 3].map(group).join("") +
        group(4) +
        btn("del", "⌫", "ctrl", this.slots.length ? "letter" : "word") +
        group(5) +
        group(6) +
        group(7) +
        btn("space", "␣", "ctrl", this.slots.length ? "accept" : "") +
        btn("phrases", phrasesLabel, "ctrl", phrasesSub) +
        btn("menu", "☰ Done", "ctrl", this.host.overlay ? "speak / insert" : "speak");
    } else if (p === "phrases") {
      const items = this.panelItems.slice(0, 6);
      root.innerHTML =
        items.map((s, i) => btn(`pi:${i}`, esc(s.label), `phrase-item ${s.kind}`, s.kind === "llm" ? "✨ AI" : "")).join("") +
        Array.from({ length: 6 - items.length }, () => `<div class="key empty"></div>`).join("") +
        btn("back", "↩ Back", "ctrl") +
        btn("menu", "☰ Done", "ctrl");
      root.className = "board gazetype panel2x4";
    } else if (p === "menu") {
      const me = this.host.profiles().find((p) => p.id === this.host.activeProfileId());
      root.innerHTML =
        btn("act:speak", "🔊 Speak", "action") +
        (this.host.overlay ? btn("act:insert", "📋 Insert", "action", "into app") : btn("act:copy", "📋 Copy", "action")) +
        btn("act:clear", "🗑 Clear", "action") +
        btn("act:spell", this.spellMode ? "Spell: ON" : "Spell: OFF", "action", "exact letters") +
        btn("act:recal", "◎ Recalibrate", "action") +
        (this.host.overlay ? btn("act:hide", "✖ Hide", "action") : btn("act:settings", "⚙ Settings", "action")) +
        btn("act:profiles", "👤 Switch user", "action", esc(me?.name ?? "")) +
        btn("act:benchmark-done", "⏱ Finish run", "action") +
        btn("act:recenter", "⊕ Re-center", "action", "or blink 3×") +
        `<div class="key empty"></div>`.repeat(2) +
        btn("back", "↩ Back", "ctrl");
      root.className = "board gazetype panel3x4";
    } else if (p === "profiles") {
      const list = this.host.profiles().slice(0, 7);
      const active = this.host.activeProfileId();
      root.innerHTML =
        list.map((pr) => btn(`prof:${pr.id}`, esc(pr.name), `action${pr.id === active ? " current" : ""}`, pr.id === active ? "current" : "")).join("") +
        `<div class="key empty"></div>`.repeat(7 - list.length) +
        btn("back", "↩ Back", "ctrl");
      root.className = "board gazetype panel2x4";
    } else {
      const letters = p.letters.split("");
      root.innerHTML =
        letters.map((l) => btn(`l:${l}`, l.toUpperCase(), "group")).join("") +
        Array.from({ length: 4 - letters.length }, () => `<div class="key empty"></div>`).join("") +
        btn("back", "↩ Back", "ctrl");
      root.className = "board gazetype panel-letters";
    }
  }

  /** Text shown in the output bar, with the in-progress word highlighted. */
  displayHtml(): string {
    const pv = this.preview();
    return `${esc(this.text())}${pv ? ` <span class="pending">${esc(pv)}</span>` : ""}<span class="caret"></span>`;
  }

  private commitWord(w: string) {
    const shown = this.engine.display(w);
    this.committed.push(this.committed.length === 0 ? cap(shown) : w === "i" ? "I" : shown);
    this.slots = [];
  }

  private commitSentence(full: string) {
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
      void llmPredict({ task: "expand", text: this.text(), slots, history: this.engine.topPhrases(8), n: 4 }, ctrl.signal).then((s) => {
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
    switch (kind) {
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
        this.panel = "main";
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
          this.clear();
          this.panel = "main";
          return "delete";
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
    this.update();
  }

  private update() {
    if (!this.withPrediction) return;
    const words = tokenize(this.value);
    const partial = /[a-z']$/i.test(this.value) ? words.pop() ?? "" : "";
    this.chips = partial ? this.engine.wordCandidates(words, [...partial.toLowerCase()], 3) : this.engine.nextWords(words, 3);
  }

  render(root: HTMLElement) {
    root.className = "board baseline";
    const chips = this.withPrediction
      ? `<div class="row chips">${[0, 1, 2].map((i) => (this.chips[i] ? btn(`chip:${i}`, esc(this.chips[i].label), "chip word") : `<div class="key chip empty"></div>`)).join("")}</div>`
      : "";
    root.innerHTML =
      chips +
      QWERTY.map((r) => `<div class="row">${[...r].map((c) => btn(`k:${c}`, c.toUpperCase())).join("")}</div>`).join("") +
      `<div class="row">${btn("del", "⌫", "ctrl")}${btn("space", "space", "ctrl wide")}${btn("act:speak", "🔊", "ctrl")}${btn(
        "act:benchmark-done",
        "⏱",
        "ctrl",
      )}${this.host.overlay ? btn("act:insert", "📋", "ctrl") : ""}</div>`;
  }

  displayHtml() {
    return `${esc(this.value)}<span class="caret"></span>`;
  }

  select(id: string): EventKind {
    const [kind, arg] = id.split(":");
    let ev: EventKind = "other";
    if (kind === "k") {
      this.value += this.value.length === 0 ? arg.toUpperCase() : arg;
      ev = "letter";
    } else if (kind === "space") {
      this.value += " ";
      ev = "space";
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
