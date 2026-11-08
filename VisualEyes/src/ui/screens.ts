// The screens beside the message screen: Saved phrases, Recent, Accessibility, Settings and Colour theme.
// Every control is a gaze target (dom.ts `g`), so all of it works hands-free. The few caretaker tools at the
// bottom of Settings are ordinary buttons: they open forms that need a keyboard.
import { esc, g } from "./dom";
import { THEMES, themeOf, type Settings } from "../settings";

export type ScreenName = "phrases" | "recent" | "access" | "settings" | "theme" | "voice" | "voiceSetup";

export interface CaretakerTool {
  label: string;
  run: () => void;
}

export interface ScreensCtx {
  settings: Settings;
  /** Persist, apply the look and sync to the account. */
  saveSettings(): void;
  toast(html: string, ms?: number): void;
  open(name: ScreenName | null): void;
  insertPhrase(text: string): void;
  sayAgain(text: string): void;
  history(): string[];
  frequent(n: number): string[];
  recalibrate(): void;
  aiPrefs(): void;
  account(): { line: string; signedIn: boolean; available: boolean };
  signIn(): void;
  signOut(): void;
  tools(): CaretakerTool[];
  aiStatus(): string;
  /** Listening to the other person: a short status for the Settings row. */
  listenStatus(): string;
  /** "Delete my data": asks for confirmation, then erases this computer's data and the account's. */
  eraseData(): void;
}

export interface Screen {
  title: string;
  sub: string;
  /** Where Back goes. */
  back: "message" | "settings";
  render(): string;
  select(id: string): void;
}

const BOOK: Record<string, string[]> = {
  needs: ["I am thirsty.", "I am hungry.", "I need to use the bathroom.", "Please adjust my pillow.", "I am too hot.", "I am too cold.", "Please turn on the television.", "I would like to go outside."],
  family: ["I love you.", "Thank you for being here.", "Please call my daughter.", "How was your day?", "Tell me about the kids.", "Can you sit with me?", "I miss you.", "Goodnight."],
  health: ["I am in pain.", "Please call the nurse.", "I feel dizzy.", "I need my medication.", "I am having trouble breathing.", "Please raise the bed.", "I am comfortable.", "I am okay."],
  social: ["Good morning.", "Please give me a moment to answer.", "Yes.", "No.", "I need a moment.", "Thank you.", "Could you repeat that?", "Please wait, I am typing."],
};
const CATS: [string, string][] = [["mine", "Often used"], ["needs", "My needs"], ["family", "Family"], ["health", "Health"], ["social", "Social"]];

const onOff = (b: boolean) => (b ? "On" : "Off");
const secs = (ms: number) => `${(ms / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, ".0")} s`;

/** A settings row: label and hint on the left, controls on the right. */
const row = (label: string, hint: string, controls: string) =>
  `<div class="card setrow"><div><div class="lbl">${label}</div><div class="hint">${hint}</div></div><div class="row" style="gap:0;flex:none">${controls}</div></div>`;
const stepper = (minus: string, value: string, plus: string, offMinus: boolean, offPlus: boolean) =>
  `<div class="stepper">${g(minus, "−", { face: "btn", faceStyle: "font-size:2.25rem", off: offMinus })}<div class="val">${value}</div>${g(plus, "+", { face: "btn", faceStyle: "font-size:2.25rem", off: offPlus })}</div>`;
const toggle = (id: string, on: boolean, label = onOff(on)) => g(id, label, { cls: "w", face: "btn", on });

export function makeScreens(ctx: ScreensCtx): Record<Exclude<ScreenName, "voice" | "voiceSetup">, Screen> {
  const s = () => ctx.settings;
  const save = () => ctx.saveSettings();
  let cat = "needs";
  let practice = 0;

  const phrasesOf = (c: string) => (c === "mine" ? ctx.frequent(8) : BOOK[c] ?? []);

  return {
    phrases: {
      title: "Saved phrases",
      sub: "Look at a phrase to add it to your message.",
      back: "message",
      render() {
        const list = phrasesOf(cat);
        return `
          <div style="display:flex;flex:none">${CATS.map(([id, label]) => g(`s:cat:${id}`, label, { face: "btn xl", on: cat === id, style: "flex:1" })).join("")}</div>
          <div class="grid2 grow">${
            list.length
              ? list.map((t, i) => g(`s:ph:${i}`, esc(t), { face: "btn", read: true, faceStyle: "min-height:6rem;font-size:1.875rem;justify-content:flex-start;text-align:left;padding:0 1.75rem" })).join("")
              : `<div class="card" style="grid-column:span 2"><p style="font-size:1.5rem">Nothing here yet. Sentences you speak often appear here.</p></div>`
          }</div>`;
      },
      select(id) {
        const [, kind, arg] = id.split(":");
        if (kind === "cat") cat = arg;
        else if (kind === "ph") {
          const t = phrasesOf(cat)[Number(arg)];
          if (t) {
            ctx.insertPhrase(t);
            ctx.open(null);
            ctx.toast("Added to your message.", 2500);
          }
        }
      },
    },

    recent: {
      title: "Recent messages",
      sub: "Look at one to say it again.",
      back: "message",
      render() {
        const h = ctx.history().slice(0, 10);
        if (!h.length) return `<div class="card"><p style="font-size:1.5rem">Nothing said yet. Messages you speak will appear here, newest first.</p></div>`;
        return `<div class="grid2 grow">${h
          .map((t, i) => g(`s:hi:${i}`, `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t)}</span>`, { read: true, faceStyle: "min-height:6rem;font-size:1.75rem;justify-content:flex-start;text-align:left;padding:0 1.75rem" }))
          .join("")}</div>`;
      },
      select(id) {
        const t = ctx.history()[Number(id.split(":")[2])];
        if (t) ctx.sayAgain(t);
      },
    },

    access: {
      title: "Accessibility",
      sub: "Tune how looking and selecting works for you.",
      back: "message",
      render() {
        const st = s();
        return `
          <div class="row grow" style="gap:1.25rem;align-items:stretch">
            <div class="col grow" style="gap:.5rem">
              <div class="card" style="padding:1rem 1.5rem">
                <div class="row" style="justify-content:space-between">
                  <div><div class="lbl">Hold-to-select time</div><div class="hint">How long you look at something to select it.</div></div>
                  ${stepper("s:dw-", secs(st.dwellMs), "s:dw+", st.dwellMs <= 750, st.dwellMs >= 3000)}
                </div>
                <div style="display:flex;margin-top:.25rem">
                  ${g("s:dw:2500", "Careful · 2.5 s", { on: st.dwellMs === 2500, style: "flex:1" })}
                  ${g("s:dw:1500", "Standard · 1.5 s", { on: st.dwellMs === 1500, style: "flex:1" })}
                  ${g("s:dw:1000", "Quick · 1.0 s", { on: st.dwellMs === 1000, style: "flex:1" })}
                </div>
              </div>
              ${row("Extra time on suggestions", "So reading a suggestion never selects it by accident.", stepper("s:rx-", st.readExtraMs ? `+${(st.readExtraMs / 1000).toFixed(1)} s` : "None", "s:rx+", st.readExtraMs <= 0, st.readExtraMs >= 2000))}
              ${row("Key size", "Larger keys are easier to hit.", g("s:kb:std", "Standard", { cls: "w", face: "btn", on: !st.keyBig }) + g("s:kb:big", "Large", { cls: "w", face: "btn", on: st.keyBig }))}
              ${row("High contrast", "Whiter keys with black edges.", toggle("s:hc", st.highContrast))}
              ${row("Reduce motion", "Calmer loaders and no pop animations.", toggle("s:rm", st.reduceMotion))}
              ${row("Show where I'm looking", "A soft circle, sized to how accurate tracking is.", toggle("s:cursor", st.showCursor))}
              ${row("Blink to re-centre", "Three quick blinks bring a drifting pointer back.", toggle("s:blink", st.blinkRecenter))}
            </div>
            <div class="card" style="width:26.875rem;flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.875rem;text-align:center">
              <h2 style="margin:0">Practice selecting</h2>
              <p>Look at the button and hold your gaze. Watch the ring fill.</p>
              ${g("s:practice", "Look here", { face: "btn-teal", faceStyle: "width:20rem;min-height:11.25rem;font-size:2.25rem" })}
              <div class="lbl">Selected ${practice === 1 ? "1 time" : `${practice} times`}</div>
            </div>
          </div>`;
      },
      select(id) {
        const st = s();
        const a = id.slice(2);
        if (a === "dw-") st.dwellMs = Math.max(750, st.dwellMs - 250);
        else if (a === "dw+") st.dwellMs = Math.min(3000, st.dwellMs + 250);
        else if (a.startsWith("dw:")) st.dwellMs = Number(a.slice(3));
        else if (a === "rx-") st.readExtraMs = Math.max(0, st.readExtraMs - 500);
        else if (a === "rx+") st.readExtraMs = Math.min(2000, st.readExtraMs + 500);
        else if (a === "kb:std") st.keyBig = false;
        else if (a === "kb:big") st.keyBig = true;
        else if (a === "hc") st.highContrast = !st.highContrast;
        else if (a === "rm") st.reduceMotion = !st.reduceMotion;
        else if (a === "cursor") st.showCursor = !st.showCursor;
        else if (a === "blink") st.blinkRecenter = !st.blinkRecenter;
        else if (a === "practice") return void practice++;
        save();
      },
    },

    settings: {
      title: "Settings",
      sub: "Speech, writing and eye tracking.",
      back: "message",
      render() {
        const st = s();
        const acc = ctx.account();
        return `
          <div class="grid2" style="gap:.625rem .75rem;flex:none">
            ${row("Colour theme", `Now: ${esc(themeOf(st.theme).name)}.`, g("s:theme", "Change", { cls: "w", face: "btn-teal", faceStyle: "min-height:3.5rem;font-size:1.5rem" }))}
            ${row("Speech speed", "How fast your voice speaks.", stepper("s:sp-", `${st.speechRate.toFixed(1)}×`, "s:sp+", st.speechRate <= 0.61, st.speechRate >= 1.59))}
            ${row("Volume", "How loud your voice is.", stepper("s:vo-", `${st.volume}%`, "s:vo+", st.volume <= 20, st.volume >= 100))}
            ${row("Message text size", "How big your words appear.", g("s:ts:l", "Large", { cls: "w", face: "btn", on: !st.textBig }) + g("s:ts:xl", "Extra large", { cls: "w", face: "btn", on: st.textBig }))}
            ${row("AI suggestions", `Sentence endings in the top row. ${esc(ctx.aiStatus())}`, toggle("s:ai", st.ai))}
            ${row("Listen to the other person", `Replies to what they say appear on the home screen. Uses the browser's speech recognition: in Chrome the microphone audio goes to Google to be transcribed. ${esc(ctx.listenStatus())}`, toggle("s:listen", st.listen))}
            ${row("Ask before clearing", "A check before a whole message is deleted.", toggle("s:cc", st.confirmClear))}
            ${row("What the AI knows", "How you talk, your topics and people.", g("s:aiprefs", "Review", { cls: "w", face: "btn" }))}
            ${row("Eye tracking", "Run calibration again if selections feel off.", g("s:recal", "Recalibrate", { cls: "w", face: "btn" }))}
          </div>
          <div class="card setrow" style="flex:none">
            <div>
              <div class="lbl">Your data</div>
              <div class="hint">On this computer: your profiles, phrases and words learned, calibration, settings and recent messages. Video never leaves it. ${
                acc.signedIn ? "In your account: your settings and your voice, so they follow you to another computer. " : ""
              }AI suggestions send text only, never audio or video. Listening uses the browser's speech recognition for the other person and records nothing.</div>
            </div>
            <div class="row" style="gap:0;flex:none">${g("s:erase", "Delete my data", { cls: "w", face: "btn" })}</div>
          </div>
          <div class="card" style="padding:1rem 1.625rem;display:flex;flex-direction:column;gap:.625rem;flex:none">
            <div class="row" style="justify-content:space-between;flex-wrap:wrap">
              <div><div class="lbl" style="font-size:1.375rem">For caretakers</div><div class="hint">${esc(acc.line)} These need a mouse and keyboard.</div></div>
              <div class="tools"><button type="button" data-tool="account">${acc.signedIn ? "Caretaker sign out" : "Caretaker sign in"}</button></div>
            </div>
            <div class="tools">${ctx
              .tools()
              .map((t, i) => `<button type="button" data-tool="${i}">${esc(t.label)}</button>`)
              .join("")}</div>
          </div>`;
      },
      select(id) {
        const st = s();
        const a = id.slice(2);
        if (a === "theme") return ctx.open("theme");
        if (a === "aiprefs") return ctx.aiPrefs();
        if (a === "recal") return ctx.recalibrate();
        if (a === "erase") return ctx.eraseData();
        if (a === "sp-") st.speechRate = Math.round((st.speechRate - 0.1) * 10) / 10;
        else if (a === "sp+") st.speechRate = Math.round((st.speechRate + 0.1) * 10) / 10;
        else if (a === "vo-") st.volume = Math.max(20, st.volume - 10);
        else if (a === "vo+") st.volume = Math.min(100, st.volume + 10);
        else if (a === "ts:l") st.textBig = false;
        else if (a === "ts:xl") st.textBig = true;
        else if (a === "ai") st.ai = !st.ai;
        else if (a === "listen") st.listen = !st.listen;
        else if (a === "cc") st.confirmClear = !st.confirmClear;
        save();
      },
    },

    theme: {
      title: "Colour theme",
      sub: "Look at a theme to try it. It changes straight away, and you can always come back.",
      back: "settings",
      render() {
        const st = s();
        const glass = !!themeOf(st.theme).glass;
        return `
          <div class="grid4" style="flex:none">${THEMES.map((t) =>
            g(`s:th:${t.id}`, `<div class="sw">${t.sw.map((c) => `<i style="background:${c}"></i>`).join("")}</div><div class="tn">${esc(t.name)}</div><div class="td">${esc(t.desc)}</div>`, { face: "btn tile", on: t.id === st.theme }),
          ).join("")}</div>
          ${
            glass
              ? `<div class="card" style="padding:.875rem 1.625rem;flex:none"><div class="lbl">See-through</div><div class="hint">How much of the window behind shows through the glass.</div>
                 <div style="display:flex;margin-top:.375rem">${[1, 2, 3].map((n) => g(`s:see:${n}`, ["Less", "Medium", "More"][n - 1], { on: st.see === n, style: "flex:1" })).join("")}</div></div>`
              : `<div class="card" style="padding:1rem 1.625rem;flex:none"><p>The two glass themes let the window behind VisualEyes show through, blurred so your words stay readable. That helps when the keyboard floats over another app.</p></div>`
          }`;
      },
      select(id) {
        const st = s();
        const [, kind, arg] = id.split(":");
        if (kind === "th") st.theme = arg;
        else if (kind === "see") st.see = Number(arg);
        save();
      },
    },
  };
}
