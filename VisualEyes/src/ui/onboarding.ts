// Start screen and onboarding. Onboarding fills the profile the AI reads (profile/profiles.ts, server/llm.ts):
// a name, an "about" text (how they talk, topics, anything else), the people they talk to, and their own writing.
//
// Two ways through it:
//   - the user, with their eyes: calibrate, practise, then pick how they talk, topics and people by gaze;
//   - a caretaker, with mouse and keyboard: sign in (Auth0) or stay local, answer for them, then hand over.
//     The user then calibrates, practises and checks the caretaker's answers ("handed"), and has the final say.
//
// Gaze targets use ids starting "o:" and are dispatched by main.ts. Caretaker controls are ordinary buttons and
// inputs handled here. State is kept in localStorage so a sign-in redirect comes back to the same step.
import { brand, esc, g, logo } from "./dom";
import type { Settings } from "../settings";

export type Path = "eye" | "carer" | "handed";
export type Step =
  | "start" | "welcome" | "cal" | "cal-failed"
  | "e-practice" | "e-tone" | "e-topics" | "e-people" | "e-review"
  | "login" | "c-person" | "c-talk" | "c-people" | "c-writing" | "c-review" | "c-handover";

export interface Draft {
  full: string;
  call: string;
  rel: string;
  tones: string[];
  topics: string[];
  people: string[];
  extra: string;
  /** Their own writing, pasted or from a file. Used only once consent is ticked. */
  writing: string;
  consent: boolean;
  learned: boolean;
  ai: boolean;
  /** Written by the user ("I talk…") or by a caretaker ("Sam talks…"). */
  firstPerson: boolean;
}

export const emptyDraft = (): Draft => ({ full: "", call: "", rel: "", tones: [], topics: [], people: [], extra: "", writing: "", consent: false, learned: false, ai: true, firstPerson: true });

export interface OnboardCtx {
  settings: Settings;
  saveSettings(): void;
  toast(html: string, ms?: number): void;
  calibrated(): boolean;
  /** Mouse mode (demo): no camera, so no calibration step. */
  mouse(): boolean;
  /** The head tracker (nose pointer) is in use, or will be when the camera starts. */
  head(): boolean;
  cameraOn(): boolean;
  faceVisible(): boolean;
  cameraStream(): MediaStream | null;
  startCamera(mode: "eye" | "head" | "mouse"): Promise<boolean>;
  /** Called after the camera starts from the start screen: main decides whether onboarding is needed. */
  afterCamera(): void;
  calibrate(): Promise<boolean>;
  auth(): { available: boolean; why: string | null; signedIn: boolean; who: string };
  signIn(signUp: boolean): Promise<void>;
  signOut(): void;
  skipSignIn(): void;
  finish(d: Draft, about: string): void;
  /** Leave onboarding without saving (editing from Settings, or "skip for now"). */
  cancel(): void;
  /** Real AI suggestions for "I would like…" with this draft's profile, or null if the AI is off. */
  examples(d: Draft, about: string): Promise<string[] | null>;
  sentences(text: string): number;
  profileName(): string;
  profiles(): { id: string; name: string }[];
  activeProfile(): string;
  switchProfile(id: string): void;
  statusLines(): { text: string; on: boolean }[];
  /** Setup is now on screen: the app behind it must be hidden, not just covered (glass themes are see-through). */
  shown(): void;
}

const EYE: [Step, string][] = [["cal", "Calibrate"], ["e-practice", "Practice"], ["e-tone", "How you talk"], ["e-topics", "Topics"], ["e-people", "People"], ["e-review", "Check"]];
const CARER: [Step, string][] = [["login", "Sign in"], ["c-person", "About them"], ["c-talk", "How they talk"], ["c-people", "People"], ["c-writing", "Their writing"], ["c-review", "Check"], ["c-handover", "Hand over"]];
const HANDED: [Step, string][] = [["cal", "Calibrate"], ["e-practice", "Practice"], ["e-review", "Check"]];

const TONES = [
  { id: "short", label: "Short and direct", eg: "Drink please.", phrase: "short and direct" },
  { id: "warm", label: "Warm and chatty", eg: "Come and sit with me for a bit.", phrase: "warm and chatty" },
  { id: "polite", label: "Polite", eg: "Could I have a drink, please?", phrase: "polite" },
  { id: "funny", label: "Joking", eg: "Tea, before I wither away.", phrase: "often joking" },
];
const TOPICS = ["Family", "Sport", "Music", "TV and films", "Food", "Faith", "Work", "News", "Nature", "Games", "Books", "Pets"];
const QUICK = ["Mum", "Dad", "my wife", "my husband", "my partner", "my son", "my daughter", "the nurse"];
const RELS = ["Partner", "Child", "Parent", "Friend", "Professional carer"];
const SPEEDS = [
  { ms: 2000, label: "Slower", desc: "Hold for 2 seconds" },
  { ms: 1500, label: "Normal", desc: "Hold for 1.5 seconds" },
  { ms: 1000, label: "Faster", desc: "Hold for 1 second" },
];
/** Practice target positions, as fractions of the practice card. */
const PTGT: [number, number][] = [[0.18, 0.3], [0.72, 0.55], [0.32, 0.78]];
const EXAMPLES: Record<string, string[]> = {
  short: ["to go outside.", "a drink.", "to rest."],
  warm: ["to sit in the garden with you for a bit.", "a cup of tea, if you're making one.", "to hear about your day."],
  polite: ["to go outside, please.", "a drink of water, please.", "to rest for a while, thank you."],
  funny: ["to escape this chair for a bit.", "a cup of tea before I wither away.", "a nap. Wake me for dinner."],
  none: ["to go outside.", "something to eat.", "to speak with my family."],
};
const MAX_PEOPLE = 40;
const MAX_ABOUT = 2000;
const MAX_WRITING = 200_000;
const STATE_KEY = "visualeyes.onboard.v1";

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const lowerFirst = (t: string) => t.replace(/^[A-Z][a-z]/, (m) => m.toLowerCase());

/** The "about" text the AI reads: style, topics, then anything else, in the first person on the eye path. */
export function aboutOf(d: Draft): string {
  const firstPerson = d.firstPerson;
  const call = d.call.trim() || d.full.trim().split(/\s+/)[0] || "They";
  const parts: string[] = [];
  const tones = TONES.filter((t) => d.tones.includes(t.id)).map((t) => t.phrase);
  if (tones.length) parts.push(firstPerson ? `I talk in a way that is ${list(tones)}.` : `${call} talks in a way that is ${list(tones)}.`);
  if (d.topics.length) parts.push(`${firstPerson ? "I like" : "Likes"} talking about ${list(d.topics.map(lowerFirst))}.`);
  if (d.extra.trim()) parts.push(d.extra.trim());
  return parts.join(" ").slice(0, MAX_ABOUT);
}

interface Saved {
  step: Step;
  path: Path;
  draft: Draft;
}

export class Onboarding {
  step: Step = "start";
  path: Path = "eye";
  draft: Draft = emptyDraft();
  private hits = 0;
  private editing = false;
  private returnToReview = false;
  private examples: { key: string; list: string[]; live: boolean } | null = null;
  private faceTimer = 0;
  private calTimer = 0;
  private calCountdown = 0;
  private busy = "";
  private fileInput: HTMLInputElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: OnboardCtx,
  ) {
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("input", (e) => this.onInput(e));
    root.addEventListener("change", (e) => this.onChange(e));
    root.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (e.key === "Enter" && t.id === "ob-person") {
        e.preventDefault();
        this.addPerson();
      }
    });
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = ".txt,text/plain";
    this.fileInput.hidden = true;
    this.fileInput.addEventListener("change", async () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (!f) return;
      const text = (await f.text()).slice(0, MAX_WRITING);
      this.draft.writing = this.draft.writing ? `${this.draft.writing}\n${text}` : text;
      this.draft.learned = false;
      this.save();
      this.render();
    });
    document.body.append(this.fileInput);
  }

  get visible() {
    return !this.root.hidden;
  }

  /** Steps where the user chooses by gaze (main.ts gives the layer gaze only when it can be used). */
  private order(): [Step, string][] {
    return this.path === "carer" ? CARER : this.path === "handed" ? HANDED : EYE;
  }

  private save() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ step: this.step, path: this.path, draft: this.draft } satisfies Saved));
    } catch {
      /* a full disk only loses the resume point */
    }
  }

  clearSaved() {
    localStorage.removeItem(STATE_KEY);
  }

  /** After a sign-in redirect: continue the caretaker steps where they were. Returns whether it resumed. */
  resume(): boolean {
    try {
      const s = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") as Saved | null;
      if (!s || s.path !== "carer" || !CARER.some(([id]) => id === s.step)) return false;
      this.path = s.path;
      this.draft = { ...emptyDraft(), ...s.draft };
      this.show(s.step === "login" && this.ctx.auth().signedIn ? "c-person" : s.step);
      return true;
    } catch {
      return false;
    }
  }

  /** Show the start screen (camera). */
  showStart() {
    this.editing = false;
    this.show("start");
  }

  /** Begin onboarding for a profile that hasn't had it. */
  begin() {
    this.editing = false;
    this.draft = emptyDraft();
    this.hits = 0;
    this.show("welcome");
  }

  /** From Settings: review what the AI knows, by gaze, and change it. */
  edit(d: Draft) {
    this.editing = true;
    this.path = "eye";
    this.draft = { ...emptyDraft(), ...d };
    this.show("e-review");
  }

  hide() {
    this.root.hidden = true;
    this.root.innerHTML = "";
    clearInterval(this.faceTimer);
    clearInterval(this.calTimer);
  }

  show(step: Step) {
    this.step = step;
    this.root.hidden = false;
    this.ctx.shown();
    clearInterval(this.calTimer);
    if (step === "cal" && this.ctx.mouse()) {
      this.hits = 0;
      step = this.step = "e-practice";
    }
    if (step !== "start" && step !== "welcome") this.save();
    if (step === "cal") this.startCalCountdown();
    this.render();
  }

  // ---------- navigation ----------
  private next() {
    if (this.returnToReview && (this.step === "e-people" || this.step === "c-people")) {
      this.returnToReview = false;
      return this.show(this.path === "carer" ? "c-review" : "e-review");
    }
    const o = this.order();
    const i = o.findIndex(([id]) => id === this.step);
    if (i >= 0 && i < o.length - 1) this.show(o[i + 1][0]);
  }

  private back() {
    if (this.editing && this.step === "e-review") return this.ctx.cancel();
    const o = this.order();
    const i = o.findIndex(([id]) => id === this.step);
    if (i > 0) {
      const prev = o[i - 1][0];
      // Going back to calibration means calibrating again; skip past it.
      if (prev === "cal") return this.show("welcome");
      return this.show(prev);
    }
    this.show(this.path === "carer" && this.step !== "login" ? "login" : "welcome");
  }

  private startCalCountdown() {
    this.calCountdown = 5;
    this.calTimer = window.setInterval(() => {
      if (this.step !== "cal" || !this.visible) return clearInterval(this.calTimer);
      this.calCountdown--;
      const el = this.root.querySelector(".ob-count");
      if (el) el.textContent = String(Math.max(0, this.calCountdown));
      if (this.calCountdown <= 0) {
        clearInterval(this.calTimer);
        void this.runCal();
      }
    }, 1000);
  }

  private async runCal() {
    clearInterval(this.calTimer);
    if (this.busy) return;
    this.busy = "cal";
    const ok = await this.ctx.calibrate();
    this.busy = "";
    if (!this.visible) return;
    if (ok) {
      this.hits = 0;
      this.show("e-practice");
    } else this.show("cal-failed");
  }

  // ---------- gaze targets ----------
  select(id: string) {
    const [, a, arg] = id.split(":");
    const d = this.draft;
    switch (a) {
      case "eyes":
        this.path = "eye";
        d.firstPerson = true;
        return this.show("cal");
      case "carer":
        this.path = "carer";
        d.firstPerson = false;
        return this.show(this.ctx.auth().signedIn ? "c-person" : "login");
      case "back":
        return this.back();
      case "next":
        if (this.step === "e-practice" && this.hits < 3) return;
        return this.next();
      case "retry":
        return this.show("cal");
      case "hit":
        this.hits = Math.min(3, this.hits + 1);
        break;
      case "sp":
        this.ctx.settings.dwellMs = Number(arg);
        this.ctx.saveSettings();
        break;
      case "tone":
        d.tones = d.tones.includes(arg) ? d.tones.filter((x) => x !== arg) : [...d.tones, arg];
        break;
      case "top":
        d.topics = d.topics.includes(arg) ? d.topics.filter((x) => x !== arg) : [...d.topics, arg];
        break;
      case "ppl":
        if (d.people.includes(arg)) d.people = d.people.filter((x) => x !== arg);
        else if (d.people.length < MAX_PEOPLE) d.people = [...d.people, arg];
        break;
      case "spell":
        this.ctx.toast("You can spell any name on the keyboard later. A caretaker can also add names under Settings, For caretakers, Profiles.", 6000);
        return;
      case "change":
        this.returnToReview = true;
        return this.show("e-tone");
      case "ai":
        d.ai = !d.ai;
        break;
      case "looks":
        return this.done();
      case "startcal":
        return void this.handOver();
    }
    this.save();
    this.render();
  }

  private done() {
    const d = { ...this.draft };
    this.clearSaved();
    this.editing = false;
    this.ctx.finish(d, aboutOf(d));
  }

  private async handOver() {
    this.path = "handed";
    if (!this.ctx.cameraOn()) {
      const ok = await this.ctx.startCamera("head");
      if (!ok) {
        this.path = "carer";
        return this.render();
      }
    }
    this.show("cal");
  }

  // ---------- caretaker controls ----------
  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el || !this.root.contains(el)) return;
    const [a, ...rest] = el.dataset.act!.split(":");
    const arg = rest.join(":");
    const d = this.draft;
    switch (a) {
      case "cam":
        return void this.startCam(arg as "eye" | "head" | "mouse");
      case "calnow":
        return void this.runCal();
      case "signin":
      case "signup":
        this.save();
        // Come back to "About them" after the sign-in page.
        try {
          localStorage.setItem(STATE_KEY, JSON.stringify({ step: "c-person", path: "carer", draft: d } satisfies Saved));
        } catch {
          /* ignore */
        }
        el.textContent = "Opening sign-in…";
        return void this.ctx.signIn(a === "signup").catch((err) => {
          this.ctx.toast(`Couldn't open sign-in: ${esc((err as Error).message)}`, 6000);
          this.render();
        });
      case "acct": {
        // Start screen: sign a caretaker in or out without going through setup.
        const au = this.ctx.auth();
        if (au.signedIn) return this.ctx.signOut();
        if (!au.available) return this.ctx.toast(esc(au.why ?? "Sign-in isn't available here."), 7000);
        el.textContent = "Opening sign-in…";
        return void this.ctx.signIn(false).catch((err) => {
          this.ctx.toast(`Couldn't open sign-in: ${esc((err as Error).message)}`, 6000);
          this.render();
        });
      }
      case "local":
        this.ctx.skipSignIn();
        return this.show("c-person");
      case "signout":
        this.ctx.signOut();
        return;
      case "rel":
        d.rel = d.rel === arg ? "" : arg;
        break;
      case "tone":
        d.tones = d.tones.includes(arg) ? d.tones.filter((x) => x !== arg) : [...d.tones, arg];
        break;
      case "top":
        d.topics = d.topics.includes(arg) ? d.topics.filter((x) => x !== arg) : [...d.topics, arg];
        break;
      case "qp":
        if (!d.people.includes(arg) && d.people.length < MAX_PEOPLE) d.people = [...d.people, arg];
        break;
      case "rmp":
        d.people = d.people.filter((_, i) => i !== Number(arg));
        break;
      case "addp":
        return this.addPerson();
      case "file":
        return this.fileInput.click();
      case "consent":
        d.consent = !d.consent;
        break;
      case "learn":
        if (!d.consent || !d.writing.trim()) return;
        d.learned = true;
        this.save();
        this.ctx.toast(`Learned from ${this.ctx.sentences(d.writing)} sentences.`, 3000);
        return this.next();
      case "skipwriting":
        d.learned = false;
        return this.next();
      case "ai":
        d.ai = !d.ai;
        break;
      case "back":
        return this.back();
      case "next":
        if (this.step === "c-person" && !(d.call.trim() || d.full.trim())) {
          this.ctx.toast("Add their name first, so the AI knows who is speaking.", 3500);
          return;
        }
        return this.next();
      case "skip":
        return this.ctx.cancel();
      default:
        return;
    }
    this.save();
    this.render();
  }

  private async startCam(mode: "eye" | "head" | "mouse") {
    if (this.busy) return;
    this.busy = "cam";
    this.render();
    const ok = await this.ctx.startCamera(mode);
    this.busy = "";
    if (ok) this.ctx.afterCamera();
    else this.render();
  }

  private addPerson() {
    const inp = this.root.querySelector<HTMLInputElement>("#ob-person");
    const name = inp?.value.trim().replace(/\s+/g, " ").slice(0, 60) ?? "";
    if (!name) return;
    if (this.draft.people.length >= MAX_PEOPLE) return this.ctx.toast(`Up to ${MAX_PEOPLE} names.`);
    if (!this.draft.people.some((p) => p.toLowerCase() === name.toLowerCase())) this.draft.people = [...this.draft.people, name];
    this.save();
    this.render();
    this.root.querySelector<HTMLInputElement>("#ob-person")?.focus();
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement | HTMLTextAreaElement;
    const f = t.dataset.field as keyof Draft | undefined;
    if (!f) return;
    if (f === "full" || f === "call" || f === "extra") this.draft[f] = t.value;
    else if (f === "writing") {
      this.draft.writing = t.value.slice(0, MAX_WRITING);
      this.draft.learned = false;
      const n = this.root.querySelector(".ob-count-writing");
      if (n) n.textContent = this.writingLine();
      const learn = this.root.querySelector<HTMLButtonElement>("[data-act=learn]");
      if (learn) learn.disabled = !(this.draft.consent && this.draft.writing.trim());
    }
    this.save();
  }

  private onChange(e: Event) {
    const t = e.target as HTMLSelectElement;
    if (t.dataset.field === "profile") {
      this.ctx.switchProfile(t.value);
      this.render();
    }
  }

  private writingLine() {
    const n = this.draft.writing.trim() ? this.ctx.sentences(this.draft.writing) : 0;
    return n ? `${n} sentence${n === 1 ? "" : "s"} found. Their own sentences come up first, and up to 40 guide the AI.` : "Nothing added yet.";
  }

  // ---------- drawing ----------
  private call() {
    return this.draft.call.trim() || this.draft.full.trim().split(/\s+/)[0] || (this.path === "eye" ? this.ctx.profileName() : "them");
  }

  private header(): string {
    const p = this.path;
    const s = this.step;
    const carerStep = s === "login" || s.startsWith("c-");
    const eyeStep = s === "cal-failed" || s.startsWith("e-");
    const tag = s === "start" || s === "welcome" ? "" : p === "carer" ? "Caretaker setup" : p === "handed" ? `${esc(this.call())}'s turn` : this.editing ? "What the AI knows" : this.ctx.head() ? "Setting up on your own" : "Setting up with your eyes";
    const a = this.ctx.auth();
    const steps = s === "start" || s === "welcome" || this.editing ? [] : this.order();
    const cur = steps.findIndex(([id]) => id === (s === "cal-failed" ? "cal" : s));
    return `
      <header class="obh">${brand()}${tag ? `<span class="tag">${tag}</span>` : ""}<div class="spacer"></div>
        ${carerStep && a.signedIn ? `<span class="hint">Signed in as <b style="color:var(--ink)">${esc(a.who)}</b></span><button class="link" type="button" data-act="signout">Sign out</button>` : ""}
        ${eyeStep && s !== "e-practice" ? g("o:back", this.editing && s === "e-review" ? "Close" : "Back", { face: "nav" }) : ""}
      </header>
      ${steps.length ? `<div class="strip">${steps.map(([, label], i) => `<div class="sg${i < cur ? " done" : i === cur ? " cur" : ""}"><i></i><span>${esc(label)}</span></div>`).join("")}</div>` : ""}`;
  }

  render() {
    if (this.root.hidden) return;
    clearInterval(this.faceTimer);
    const body = this.body();
    this.root.className = "screen";
    this.root.innerHTML = `${this.header()}${body}`;
    // Live camera preview on the calibration step, from the tracker's own stream.
    const v = this.root.querySelector<HTMLVideoElement>("video.ob-preview");
    const stream = this.ctx.cameraStream();
    if (v && stream) {
      v.srcObject = stream;
      void v.play().catch(() => {});
    }
    if (this.step === "cal") {
      this.faceTimer = window.setInterval(() => {
        const el = this.root.querySelector(".ob-face");
        if (el) el.innerHTML = this.faceLine();
      }, 500);
    }
    if (this.step === "e-review" || this.step === "c-review") void this.loadExamples();
  }

  private faceLine() {
    const ok = this.ctx.faceVisible();
    return `<span class="badge" style="background:${ok ? "var(--ok)" : "var(--coral)"};color:#0B1A12">${ok ? "Good" : "Looking"}</span><span class="lbl" style="font-size:1.4375rem">${ok ? "Face found" : "Looking for your face…"}</span>`;
  }

  private async loadExamples() {
    const about = aboutOf(this.draft);
    const key = JSON.stringify([about, this.draft.people, this.draft.ai]);
    if (this.examples?.key === key) return;
    const tone = TONES.find((t) => this.draft.tones.includes(t.id))?.id ?? "none";
    this.examples = { key, list: EXAMPLES[tone], live: false };
    const draw = () => {
      const box = this.root.querySelector(".ob-examples");
      if (box) box.innerHTML = this.examplesHtml();
    };
    draw();
    if (!this.draft.ai) return;
    const live = await this.ctx.examples(this.draft, about);
    if (this.examples?.key !== key || !live?.length) return;
    this.examples = { key, list: live, live: true };
    draw();
  }

  private examplesHtml() {
    const ex = this.examples;
    if (!ex) return "";
    return `${ex.list.slice(0, 3).map((e) => `<div class="sug"><b>…</b>${esc(e)}</div>`).join("")}
      <span class="fine">${ex.live ? "Live from the AI, with this profile." : this.draft.ai ? "Examples of this style. Start the AI server for real suggestions." : "AI suggestions are off. Word prediction still learns from you."}</span>`;
  }

  private body(): string {
    const d = this.draft;
    const call = esc(this.call());
    const head = this.ctx.head();
    const next = (w = "26.25rem") => g("o:next", "Next", { face: "btn-main", faceStyle: `width:${w};min-height:6.875rem;font-size:2.375rem`, off: this.step === "e-practice" && this.hits < 3 });
    switch (this.step) {
      case "start": {
        const returning = this.ctx.profiles().length > 1 || this.ctx.profileName() !== "Me";
        const opts = this.ctx.profiles().map((p) => `<option value="${esc(p.id)}"${p.id === this.ctx.activeProfile() ? " selected" : ""}>${esc(p.name)}</option>`).join("");
        return `<div class="obbody" style="align-items:center;justify-content:center;text-align:center;gap:1.375rem">
          <div class="cam" style="width:32.5rem;height:20.625rem">${logo("var(--onBrand)", "var(--coral)").replace("<svg", '<svg style="width:7rem;height:7rem;opacity:.9"')}</div>
          <div><h1 class="h1" style="font-size:3.125rem">${returning ? `Welcome back, ${esc(this.ctx.profileName())}` : "Welcome to VisualEyes"}</h1>
            <p class="sub" style="font-size:1.5rem">${head ? "VisualEyes uses the camera to follow small movements of your head, so you can type and speak by pointing." : "VisualEyes uses the camera to follow your eyes, so you can type and speak by looking."}</p></div>
          <button class="face btn-main cbtn" type="button" data-act="cam:head" style="width:32.5rem;min-height:6.5rem;font-size:2.375rem"${this.busy ? " disabled" : ""}>${this.busy ? "Starting the camera…" : "Turn on camera"}</button>
          <p class="hint" style="width:47.5rem;font-size:1.25rem;margin:0">This is the only step that needs a hand. Whoever is nearby: click the button, then click <b style="color:var(--ink)">Allow</b> when the computer asks. Video stays on this computer.</p>
          <div class="row" style="gap:1.5rem"><button class="link" type="button" data-act="cam:mouse">Mouse mode (demo)</button></div>
          <div class="row selectwrap" style="gap:1.5rem;font-weight:800;font-size:1.1875rem"><span class="row" style="gap:.75rem">Typing as <select data-field="profile" aria-label="Who is typing">${opts}</select></span>
            ${(() => {
              const au = this.ctx.auth();
              return au.signedIn
                ? `<span class="hint">Caretaker: <b style="color:var(--ink)">${esc(au.who)}</b></span><button class="link" type="button" data-act="acct">Sign out</button>`
                : `<button class="link" type="button" data-act="acct">Caretaker sign in</button>`;
            })()}</div>
          <div class="status-lines">${this.ctx.statusLines().map((l) => `<p class="${l.on ? "on" : "off"}">${esc(l.text)}</p>`).join("")}
            <p class="fine">Communication aid prototype, not a medical device.</p></div>
        </div>`;
      }
      case "welcome": {
        const cal = this.ctx.calibrated();
        return `<div class="obbody">
          <div style="text-align:center;padding-top:.375rem"><h1 class="h1" style="font-size:3rem">Who is setting up VisualEyes?</h1>
            <p class="sub" style="font-size:1.4375rem">Next we ask a few questions so the suggestions sound like you. About 3 minutes.</p></div>
          <div style="display:flex;flex:1;min-height:0;gap:.5rem">
            ${g("o:eyes", `${logo("var(--onBrand)", "var(--coral)").replace("<svg", '<svg style="width:7.5rem;height:7.5rem"')}<span style="font-size:3.625rem">${head ? "Me, on my own" : "Me, with my eyes"}</span><span style="font-size:1.5rem;font-weight:700;color:var(--onBrandSoft);line-height:1.35">${cal ? (head ? "Keep pointing at this side until it fills." : "Keep looking at this side until it fills.") : `Calibration starts first, so VisualEyes can follow your ${head ? "head" : "eyes"}.`}</span>`, { style: "flex:1", face: "btn-main", faceStyle: "flex-direction:column;gap:1.125rem;padding:0 3.75rem;border-radius:1.875rem" })}
            ${g("o:carer", `<span style="font-size:3.625rem;font-weight:900">My caretaker</span><span style="font-size:1.5rem;font-weight:700;color:var(--mute);line-height:1.35">They sign in with a mouse and keyboard and answer for you. You check their answers at the end.</span><span class="hint">Caretakers: click anywhere on this side.</span>`, { style: "flex:1", face: "btn", faceStyle: "flex-direction:column;gap:1.125rem;padding:0 3.75rem;border-radius:1.875rem" })}
          </div>
          <div class="row" style="justify-content:center;gap:1.5rem"><p class="hint" style="margin:0">${cal ? "Each half of the screen is one big button." : `${head ? "Pointing" : "Eye control"} starts after calibration. For now a helper can click a side.`}</p><button class="link" type="button" data-act="skip">Skip for now</button></div>
        </div>`;
      }
      case "cal":
        return `<div class="obbody" style="justify-content:center"><div class="row" style="gap:2.5rem;align-items:center">
          <div class="cam" style="width:37.5rem;height:28.125rem">${this.ctx.cameraStream() ? `<video class="ob-preview" playsinline muted></video>` : "Camera is off"}<div class="guide"></div></div>
          <div class="col grow" style="gap:1.125rem">
            <div><h1 class="h1" style="font-size:3rem">${head ? "First, let VisualEyes learn how you move" : "First, let VisualEyes learn your eyes"}</h1>
              <p class="sub" style="font-size:1.4375rem">${head ? "Dots appear one at a time. Point your nose at each one by turning your head, until it disappears. Small movements are enough. About 50 seconds." : "Dots appear one at a time. Look at each one until it disappears. Keep your head still and comfortable. About 50 seconds."}</p></div>
            <div class="card" style="padding:.5rem 1.5rem"><div class="chk ob-face">${this.faceLine()}</div>
              <div class="chk"><span class="badge soft">Tip</span><span class="lbl" style="font-size:1.4375rem">Light in front of you, not behind</span></div>
              <div class="chk"><span class="badge soft">Tip</span><span class="lbl" style="font-size:1.4375rem">${head ? "Sit centred, facing the screen" : "Head inside the oval"}</span></div></div>
            <div class="row"><div class="face btn-main" style="flex:1;min-height:6.25rem;font-size:2.25rem">Starting in <span class="ob-count" style="margin-left:.5rem">${this.calCountdown}</span></div>
              <button class="link" type="button" data-act="calnow">Start now</button></div>
          </div></div></div>`;
      case "cal-failed":
        return `<div class="obbody centre" style="justify-content:center">
          <h1 class="h1">Calibration didn't finish</h1>
          <p class="sub" style="font-size:1.5rem;max-width:56rem">That happens. Check the light is in front of you and the camera can see ${head ? "your whole face" : "both eyes"}, then try again.</p>
          <div class="row">${g("o:retry", "Try again", { face: "btn-main", faceStyle: "width:26rem;min-height:7rem;font-size:2.5rem" })}</div>
          <button class="link" type="button" data-act="back">Back to the start</button></div>`;
      case "e-practice": {
        const [px, py] = PTGT[Math.min(this.hits, PTGT.length - 1)];
        const msg = [head ? "Point at the button and hold still." : "Look at the button and hold your gaze.", "Good. Now this one.", "One more.", "Done."][this.hits];
        return `<div class="obbody" style="flex-direction:row;gap:1.75rem">
          <div class="card" style="position:relative;flex:1;min-width:0;padding:0;overflow:hidden">
            <div style="position:absolute;left:1.75rem;top:1.25rem;right:1.75rem;display:flex;justify-content:space-between;align-items:baseline"><span class="lbl">${msg}</span><span class="hint" style="font-size:1.375rem;font-weight:800">${this.hits} of 3</span></div>
            ${
              this.hits < 3
                ? g("o:hit", "Look here", { cls: "round", style: `position:absolute;left:${px * 100}%;top:${py * 100}%;transform:translate(-50%,-50%)`, face: "btn", faceStyle: "width:11.875rem;min-height:11.875rem;font-size:1.75rem" })
                : `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.625rem;text-align:center"><span style="font-size:3rem;font-weight:900">That's it</span><span class="sub" style="font-size:1.5rem">Every button works the same way: ${head ? "point" : "look"}, hold, done.<br>${head ? "Move away" : "Look away"} before choosing the same thing again.</span></div>`
            }
          </div>
          <div class="col" style="width:26.875rem;flex:none;gap:.75rem">
            <h1 class="h1" style="font-size:2.5rem">Practice choosing</h1>
            <p class="sub" style="margin:0 0 .375rem;font-size:1.3125rem">How long should you hold ${head ? "still" : "your look"}? Change it any time.</p>
            ${SPEEDS.map((s) => g(`o:sp:${s.ms}`, `<span style="font-size:1.875rem;font-weight:900">${s.label}</span><span class="td">${s.desc}</span>`, { on: this.ctx.settings.dwellMs === s.ms, faceStyle: "min-height:6.25rem;flex-direction:column;gap:2px" })).join("")}
            <div class="grow"></div>
            ${next("100%")}
          </div></div>`;
      }
      case "e-tone":
        return `<div class="obbody"><div><h1 class="h1" style="font-size:2.875rem">How do you like to talk?</h1><p class="sub" style="font-size:1.4375rem">Pick any that fit. Suggestions will be written the way you would say things.</p></div>
          <div class="grid2" style="gap:.375rem .5rem">${TONES.map((t) => g(`o:tone:${t.id}`, `<span class="tick">✓</span><span class="ol">${t.label}</span><span class="od">“${esc(t.eg)}”</span>`, { face: "btn opt", on: d.tones.includes(t.id), faceStyle: "min-height:10.625rem" })).join("")}</div>
          <div class="grow"></div>
          <div class="row" style="justify-content:space-between"><span class="hint">${d.tones.length ? `${d.tones.length} chosen` : "Choose any, or none"}</span>${next()}</div></div>`;
      case "e-topics":
        return `<div class="obbody"><div><h1 class="h1" style="font-size:2.875rem">What do you like to talk about?</h1><p class="sub" style="font-size:1.4375rem">Words for these come up sooner. Pick as many as you like.</p></div>
          <div class="grid4" style="gap:2px .5rem">${TOPICS.map((t) => g(`o:top:${t}`, `<span class="tick">✓</span>${esc(t)}`, { on: d.topics.includes(t), faceStyle: "position:relative;min-height:7rem;font-size:1.875rem;font-weight:900" })).join("")}</div>
          <div class="grow"></div>
          <div class="row" style="justify-content:space-between"><span class="hint">${d.topics.length ? `${d.topics.length} chosen` : "Choose any, or none"}</span>${next()}</div></div>`;
      case "e-people":
        return `<div class="obbody"><div><h1 class="h1" style="font-size:2.875rem">Who do you talk to most?</h1><p class="sub" style="font-size:1.4375rem">These come up as soon as you start spelling them. A caretaker can add first names for you.</p></div>
          <div class="grid4" style="gap:2px .5rem">${QUICK.map((t) => g(`o:ppl:${t}`, `<span class="tick">✓</span>${esc(t)}`, { on: d.people.includes(t), faceStyle: "position:relative;min-height:7rem;font-size:1.875rem;font-weight:900" })).join("")}</div>
          ${d.people.filter((p) => !QUICK.includes(p)).length ? `<div class="row wrap" style="gap:.625rem">${d.people.filter((p) => !QUICK.includes(p)).map((p) => `<span class="who">${esc(p)}</span>`).join("")}</div>` : ""}
          <div class="row" style="gap:.5rem">${g("o:spell", "Spell a name", { face: "btn lg", faceStyle: "width:26.25rem" })}</div>
          <div class="grow"></div>
          <div class="row" style="justify-content:space-between"><span class="hint">${d.people.length ? `${d.people.length} chosen` : "Choose any, or none"}</span>${next()}</div></div>`;
      case "e-review":
      case "c-review":
        return this.review();
      case "login": {
        const a = this.ctx.auth();
        const right = a.signedIn
          ? `<h2 class="h1" style="font-size:2.25rem">Signed in as ${esc(a.who)}</h2><button class="face btn-teal cbtn" type="button" data-act="next" style="min-height:5rem;font-size:1.875rem;width:100%">Continue</button>`
          : `${
              a.available
                ? `<button class="face btn-teal cbtn" type="button" data-act="signin" style="min-height:5rem;font-size:1.875rem;width:100%">Sign in</button>
                   <button class="face btn cbtn" type="button" data-act="signup" style="min-height:4rem;width:100%">Create a caretaker account</button>
                   <p class="hint" style="margin:0">A secure sign-in page opens (Auth0). It handles passwords, password resets and Google sign-in, then brings you back here.</p>`
                : `<p class="hint" style="margin:0;color:var(--coral)">${esc(a.why ?? "Sign-in isn't available here.")}</p>`
            }
             <div class="or">or</div>
             <button class="face btn cbtn" type="button" data-act="local" style="min-height:4rem;width:100%">Set up on this computer only, no account</button>
             <p class="hint" style="margin:0">Without an account you can't help from another computer, and nothing is backed up.</p>`;
        return `<div class="obbody" style="flex-direction:row;gap:2.25rem">
          <div class="brandside"><h1 class="h1" style="font-size:2.875rem;color:var(--onBrand)">Caretaker sign in</h1>
            <p>Set up VisualEyes for someone you care for, and help with it later from any computer.</p>
            <ul style="margin:.375rem 0 0;padding-left:1.625rem">
              <li>They never need a password.</li>
              <li>You tell the AI how they talk, who they talk to, and share things they've written.</li>
              <li>Their messages are not sent to your account.</li></ul></div>
          <div class="col grow" style="justify-content:center;gap:1.125rem;padding:0 2.5rem">${right}
            <div style="height:.375rem"></div>
            <div class="row" style="justify-content:center">${g("o:eyes", head ? "I'll do it myself instead" : "I'll do it with my eyes instead", { face: "btn lg", faceStyle: "width:32.5rem" })}</div>
          </div></div>`;
      }
      case "c-person":
        return `<div class="obbody"><div><h1 class="h1">Who will use VisualEyes?</h1><p class="sub">Their name goes into the suggestions, so the AI knows who is speaking.</p></div>
          <div class="row grow" style="gap:1.75rem;align-items:stretch">
            <div class="card col grow" style="gap:1.375rem;padding:1.75rem 2rem">
              <label><span class="fl">Their full name</span><input class="inp" type="text" data-field="full" maxlength="80" placeholder="Sam Rivera" value="${esc(d.full)}"></label>
              <label><span class="fl">What should VisualEyes call them?</span><input class="inp" type="text" data-field="call" maxlength="40" placeholder="Sam" value="${esc(d.call)}"></label>
              <div><span class="fl">You are their…</span><div class="row wrap" style="gap:.625rem">${RELS.map((r) => `<button type="button" class="pk${d.rel === r ? " on" : ""}" data-act="rel:${esc(r)}">${esc(r)}</button>`).join("")}</div></div>
            </div>
            <div class="card" style="width:28.75rem;flex:none;align-self:flex-start"><h2>They won't need a password</h2><p>Your account is only for caretaker tasks: changing their settings and keeping them backed up.</p></div>
          </div>
          ${this.cfoot("Continue")}</div>`;
      case "c-talk":
        return `<div class="obbody"><div><h1 class="h1">How does ${call} talk?</h1><p class="sub">This becomes the “about” text the AI reads before every suggestion.</p></div>
          <div class="row grow" style="gap:1.75rem;align-items:stretch">
            <div class="card col grow" style="gap:1.375rem;padding:1.625rem 1.875rem">
              <div><span class="fl">Their style</span><div class="row wrap" style="gap:.625rem">${TONES.map((t) => `<button type="button" class="pk${d.tones.includes(t.id) ? " on" : ""}" data-act="tone:${t.id}">${esc(t.label)}</button>`).join("")}</div></div>
              <div><span class="fl">Things they like to talk about</span><div class="row wrap" style="gap:.625rem">${TOPICS.map((t) => `<button type="button" class="pk${d.topics.includes(t) ? " on" : ""}" data-act="top:${esc(t)}">${esc(t)}</button>`).join("")}</div></div>
            </div>
            <div class="card col" style="width:35rem;flex:none;gap:.625rem;padding:1.625rem 1.875rem">
              <span class="fl" style="margin:0">Anything else, in their words or yours</span>
              <textarea class="inp grow" data-field="extra" maxlength="1500" placeholder="Retired teacher from Leeds. Supports Leeds United. Dry sense of humour, calls everyone “love”. Hates a fuss. Says “cheers” not “thank you”.">${esc(d.extra)}</textarea>
              <span class="hint">Where they're from, words they always use, things they'd never say.</span>
            </div>
          </div>
          ${this.cfoot("Continue")}</div>`;
      case "c-people":
        return `<div class="obbody"><div><h1 class="h1">Who does ${call} talk to?</h1><p class="sub">Family, carers, friends, pets. Spelled exactly how they'd write them.</p></div>
          <div class="card col" style="gap:1.25rem;padding:1.75rem 2rem">
            <div class="row" style="gap:.75rem;align-items:flex-end"><label class="grow"><span class="fl">Add a name</span><input id="ob-person" class="inp" type="text" maxlength="60" placeholder="Jordan"></label>
              <button class="face btn-teal cbtn" type="button" data-act="addp" style="width:11.25rem;min-height:3.75rem;font-size:1.5rem">Add</button></div>
            <div class="row wrap" style="gap:.625rem;min-height:2.625rem">${d.people.length ? d.people.map((p, i) => `<span class="who">${esc(p)}<button type="button" data-act="rmp:${i}" aria-label="Remove ${esc(p)}">×</button></span>`).join("") : `<span class="hint">No names yet.</span>`}</div>
            <div><span class="fl">Quick add</span><div class="row wrap" style="gap:.625rem">${QUICK.map((t) => `<button type="button" class="pk${d.people.includes(t) ? " on" : ""}" data-act="qp:${esc(t)}">${esc(t)}</button>`).join("")}</div></div>
          </div>
          <div class="card" style="padding:1.125rem 1.875rem"><p>Names are pinned in predictions: typing “J” offers “Jordan” first. They're also given to the AI, so “I want to call…” finishes with a real name. Up to ${MAX_PEOPLE}.</p></div>
          <div class="grow"></div>
          ${this.cfoot("Continue")}</div>`;
      case "c-writing":
        return `<div class="obbody"><div><h1 class="h1">Do you have things ${call} has written?</h1><p class="sub">Old texts, emails or posts. The AI copies their word choice, spelling and sentence length.</p></div>
          <div class="row grow" style="gap:1.75rem;align-items:stretch">
            <div class="card col grow" style="gap:.875rem;padding:1.625rem 1.875rem">
              <span class="fl" style="margin:0">Paste messages, one or many</span>
              <textarea class="inp grow" data-field="writing" placeholder="Running late, put the kettle on x&#10;Did you see the match?? Ref wants his eyes tested&#10;Cheers love, see you Sunday">${esc(d.writing)}</textarea>
              <div class="row" style="gap:.875rem"><button class="face btn cbtn" type="button" data-act="file" style="width:16.25rem">Choose a file</button><span class="hint">A .txt export from their phone or email works.</span></div>
            </div>
            <div class="col" style="width:32.5rem;flex:none;gap:1rem">
              <div class="card"><h2>What happens to it</h2><p class="ob-count-writing">${this.writingLine()}</p></div>
              <button type="button" class="card cbtn" data-act="consent" style="display:flex;gap:1rem;align-items:flex-start;text-align:left;color:var(--ink)"><span class="box${d.consent ? " on" : ""}">${d.consent ? "✓" : ""}</span><span style="font-size:1.25rem;font-weight:700;line-height:1.4">${call} is happy for these messages to be used. Leave out anything private.</span></button>
              <p class="hint" style="margin:0 .25rem">The text stays on this computer. Up to 40 picked sentences go to the AI with each suggestion request.</p>
            </div>
          </div>
          <div class="cfoot"><button class="link" type="button" data-act="back">Back</button><div class="spacer"></div>
            <button class="face btn cbtn" type="button" data-act="skipwriting" style="width:13.75rem">Skip</button>
            <button class="face btn-teal cbtn" type="button" data-act="learn" style="width:20rem"${d.consent && d.writing.trim() ? "" : " disabled"}>Learn from these</button></div></div>`;
      case "c-handover":
        return `<div class="obbody" style="flex-direction:row;gap:1.875rem;align-items:stretch">
          <div class="col" style="width:35rem;flex:none;gap:1rem">
            <div><h1 class="h1">Now hand over to ${call}</h1><p class="sub">${call} ${head ? "points at a few dots with their head" : "calibrates with their eyes"}, practises once, then checks what you wrote.</p></div>
            <div class="card" style="padding:.5rem 1.625rem">${["Screen about an arm's length from their face", "Camera level with their eyes", "Light in front of them, not behind", "Glasses on, if they usually wear them"].map((t) => `<div class="chk"><span class="box on">✓</span><span style="font-size:1.3125rem;font-weight:800">${t}</span></div>`).join("")}</div>
            <div class="grow"></div>
            <div class="cfoot"><button class="link" type="button" data-act="back">Back</button></div>
          </div>
          ${g("o:startcal", `<span style="font-size:3.5rem">Start ${call}'s eye setup</span><span style="font-size:1.5rem;font-weight:700;color:var(--onBrandSoft);line-height:1.35">Click here, then ${call} ${head ? "points their nose at" : "looks at"} the dots. ${this.ctx.cameraOn() ? "" : "The camera turns on first."}</span>`, { style: "flex:1", face: "btn-main", faceStyle: "flex-direction:column;gap:1rem;border-radius:1.875rem;padding:0 3.125rem" })}
        </div>`;
    }
    return "";
  }

  private cfoot(label: string) {
    return `<div class="cfoot"><button class="link" type="button" data-act="back">Back</button><div class="spacer"></div><button class="face btn-teal cbtn" type="button" data-act="next" style="width:18.75rem">${label}</button></div>`;
  }

  private review(): string {
    const d = this.draft;
    const gaze = this.step === "e-review";
    const carerWrote = this.path === "handed";
    const call = esc(this.call());
    const about = aboutOf(d);
    const title = this.editing ? "This is what the AI knows about you" : carerWrote ? `${call}, is this right?` : gaze ? "This is what the AI will know about you" : `What the AI will know about ${call}`;
    const sub = carerWrote ? "Your caretaker set this up for you. Change anything that isn't you." : gaze ? "It reads this before every suggestion. You can change it any time in Settings." : `${call} will check this after the hand over.`;
    const writing = d.learned && d.writing.trim() ? `Learning from ${this.ctx.sentences(d.writing)} of their sentences. Up to 40 guide the AI.` : "Nothing added. It learns from what is typed from now on.";
    return `<div class="obbody">
      <div><h1 class="h1" style="font-size:2.75rem">${title}</h1><p class="sub" style="font-size:1.375rem">${sub}</p></div>
      <div class="row grow" style="gap:1.625rem;align-items:stretch">
        <div class="card col grow" style="gap:.875rem;padding:1.625rem 1.875rem;overflow:hidden">
          <span class="fl" style="margin:0;color:var(--mute)">About ${d.firstPerson ? "you" : call}</span>
          <p class="about">${about ? esc(about) : "Nothing yet. Pick how you talk and your topics, or let it learn as you type."}</p>
          ${d.people.length ? `<span class="fl" style="margin:.375rem 0 0;color:var(--mute)">People</span><div class="row wrap" style="gap:.625rem">${d.people.map((p) => `<span class="who">${esc(p)}</span>`).join("")}</div>` : ""}
          <span class="fl" style="margin:.375rem 0 0;color:var(--mute)">Their own writing</span>
          <p class="about" style="font-size:1.3125rem;color:var(--mute)">${writing}</p>
        </div>
        <div class="col" style="width:33.75rem;flex:none;gap:.625rem">
          <span class="fl" style="margin:0">Try it: “I would like…”</span>
          <div class="col ob-examples" style="gap:.625rem">${this.examplesHtml()}</div>
          <div class="grow"></div>
          ${
            gaze
              ? `${g("o:looks", this.editing ? "Save" : "Looks right", { face: "btn-main", faceStyle: "min-height:6.875rem;font-size:2.125rem" })}
                 <div style="display:flex">${g("o:change", "Change something", { face: "btn lg", style: "flex:1", faceStyle: "font-size:1.5rem" })}${g("o:ai", `AI: ${d.ai ? "On" : "Off"}`, { face: "btn lg", style: "flex:1", on: d.ai, faceStyle: "font-size:1.5rem" })}</div>`
              : `<button type="button" class="card cbtn" data-act="ai" style="display:flex;gap:1rem;align-items:center;text-align:left;color:var(--ink);padding:1rem 1.375rem"><span class="box${d.ai ? " on" : ""}">${d.ai ? "✓" : ""}</span><span style="font-size:1.25rem;font-weight:800">Use AI suggestions</span></button>`
          }
        </div>
      </div>
      <p class="hint" style="margin:0">${d.ai ? "The AI service gets this text and the sentence being written. Never video or sound." : "AI suggestions are off: nothing is sent to the AI service. Word prediction still works on this computer."}</p>
      ${gaze ? "" : this.cfoot("Looks right")}
    </div>`;
  }
}
