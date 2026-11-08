import { describe, expect, it } from "vitest";
import { Conversation, filterReplies, homeItems, isEcho } from "../src/listen/conversation";
import { PartnerListener } from "../src/listen/partner";
import { PredictionEngine, memoryStore } from "../src/predict/engine";
import { GazeTypeKeyboard, HOME_CHIPS, type KeyboardHost } from "../src/ui/keyboards";

describe("echo filter", () => {
  it("drops what the app itself just said, exactly or in part", () => {
    expect(isEcho("I love you too.", ["I love you too"])).toBe(true);
    expect(isEcho("love you too", ["I love you too."])).toBe(true);
    expect(isEcho("I love you too I said", ["I love you too"])).toBe(true);
    expect(isEcho("i love you to", ["I love you too"])).toBe(true); // 3 of 4 words shared
  });
  it("keeps a genuinely new sentence", () => {
    expect(isEcho("How was your night?", ["I love you too"])).toBe(false);
    expect(isEcho("Do you want tea?", [])).toBe(false);
  });
});

describe("conversation turns", () => {
  it("records what the partner said and offers it as the latest turn", () => {
    let t = 1000;
    const c = new Conversation({ now: () => t });
    expect(c.heard("How was your night?")?.text).toBe("How was your night?");
    expect(c.latest()?.text).toBe("How was your night?");
    t += 100;
    expect(c.heard("  how was your night  ")).toBeNull(); // the recogniser repeating itself
    t += 10_000;
    expect(c.heard("How was your night?")).not.toBeNull(); // asked again later: a real repeat
  });

  it("ignores the app's own voice coming back through the microphone", () => {
    let t = 1000;
    const c = new Conversation({ now: () => t, echoMs: 5000 });
    c.spoke("Rough. The pillow again.");
    t += 1500;
    expect(c.heard("rough the pillow again")).toBeNull();
    expect(c.latest()).toBeNull();
    t += 6000;
    expect(c.heard("rough the pillow again")?.who).toBe("them"); // long after: no longer an echo
  });

  it("clears replies once the user answers, and keeps a short transcript oldest first", () => {
    const c = new Conversation({ maxTurns: 3 });
    c.heard("Want tea?");
    c.replies = ["Yes please.", "Not now."];
    c.spoke("Yes please.");
    expect(c.replies).toEqual([]);
    expect(c.latest()).toBeNull(); // the newest turn is the user's
    c.heard("Milk?");
    expect(c.transcript()).toEqual([
      { who: "them", text: "Want tea?" },
      { who: "me", text: "Yes please." },
      { who: "them", text: "Milk?" },
    ]);
    c.heard("Sugar?");
    expect(c.transcript().map((t) => t.text)).toEqual(["Yes please.", "Milk?", "Sugar?"]); // maxTurns 3
  });
});

describe("reply filter and home screen", () => {
  it("keeps short, distinct, new replies in order", () => {
    const out = filterReplies(["Yes please.", "yes please", "  Not right now, thanks. ", "", "I need water", "A very long reply that goes on and on and on and on and on and on well past the limit"], { n: 5, known: ["I need water"] });
    expect(out).toEqual(["Yes please.", "Not right now, thanks.", "I need water"].slice(0, 2));
  });
  it("blocks what the caller says to block", () => {
    expect(filterReplies(["fine", "bad"], { n: 5, blocked: (s) => s === "bad" })).toEqual(["fine"]);
  });
  it("puts replies first and fills the rest with the usual phrases, no duplicates", () => {
    expect(homeItems(["Yes.", "No."], ["Hello", "Yes.", "Water please"], 4)).toEqual(["Yes.", "No.", "Hello", "Water please"]);
    expect(homeItems([], ["Hello"], 2)).toEqual(["Hello"]);
  });
});

describe("home screen with replies", () => {
  const fakeRoot = () => ({ innerHTML: "", className: "" }) as unknown as HTMLElement;
  it("shows reply chips first, marked as replies, and speaks one in a single selection", () => {
    const engine = new PredictionEngine(memoryStore(), () => 1_000_000);
    engine.load(["hello"], ["yes"], ["I need water", "Thank you", "Yes please", "Can you help me", "Hello"]);
    const actions: string[] = [];
    const host: KeyboardHost = { refresh: () => {}, action: (a) => actions.push(a), overlay: false, profiles: () => [], activeProfileId: () => "", notice: () => {} };
    const kb = new GazeTypeKeyboard(engine, host);
    const replies = ["Rough night.", "Slept fine, thanks."];
    kb.homeSource = (n) => homeItems(replies, engine.topPhrases(n), n).map((t) => (replies.includes(t) ? { text: t, sub: "reply" } : t));
    const root = fakeRoot();
    kb.render(root);
    expect((root.innerHTML.match(/data-target="home:/g) ?? []).length).toBe(HOME_CHIPS);
    expect(root.innerHTML.indexOf("Rough night.")).toBeLessThan(root.innerHTML.indexOf("I need water"));
    expect(root.innerHTML).toContain("<small>reply</small>");
    expect(kb.select("home:0")).toBe("phrase");
    expect(kb.text()).toBe("Rough night.");
    expect(actions).toEqual(["speak"]);
  });
});

describe("partner listener", () => {
  // A stand-in for the browser's SpeechRecognition.
  class FakeRec {
    static instances: FakeRec[] = [];
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = 0;
    constructor() {
      FakeRec.instances.push(this);
    }
    start() {
      this.started++;
    }
    stop() {}
    abort() {}
    say(text: string, isFinal: boolean) {
      this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
    }
  }

  it("reports unsupported browsers without starting", () => {
    const states: string[] = [];
    const l = new PartnerListener({ onFinal: () => {}, onState: (s) => states.push(s), ctor: null });
    expect(l.supported).toBe(false);
    l.start();
    expect(states).toEqual(["unsupported"]);
  });

  it("passes finished sentences through, drops them while muted, and reports a refused microphone", () => {
    FakeRec.instances = [];
    const finals: string[] = [];
    const interims: string[] = [];
    const states: string[] = [];
    const l = new PartnerListener({ onFinal: (t) => finals.push(t), onInterim: (t) => interims.push(t), onState: (s) => states.push(s), ctor: FakeRec });
    l.start();
    const rec = FakeRec.instances[0];
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.started).toBe(1);
    rec.say("how was", false);
    rec.say("How was your night?", true);
    expect(interims).toEqual(["how was", ""]);
    expect(finals).toEqual(["How was your night?"]);
    l.mute(60_000);
    rec.say("Rough night.", true);
    expect(finals).toEqual(["How was your night?"]); // the app's own voice: ignored
    expect(l.state).toBe("muted");
    l.unmute();
    expect(l.state).toBe("on");
    rec.onerror?.({ error: "not-allowed" });
    expect(l.state).toBe("denied");
    expect(states.at(-1)).toBe("denied");
  });

  it("stops with an error when the browser can't reach its speech service (Brave), instead of looping", () => {
    FakeRec.instances = [];
    const states: string[] = [];
    const l = new PartnerListener({ onFinal: () => {}, onState: (s) => states.push(s), ctor: FakeRec });
    l.start();
    const rec = FakeRec.instances[0];
    rec.onerror?.({ error: "no-speech" }); // routine: still listening
    expect(l.state).toBe("on");
    rec.onerror?.({ error: "network" });
    expect(l.state).toBe("error");
    expect(l.lastError).toBe("network");
    rec.onend?.(); // the dead session ending must not reopen another
    expect(FakeRec.instances.length).toBe(1);
  });
});
