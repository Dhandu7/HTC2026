import { describe, expect, it } from "vitest";
import { HostedVoiceError, type VoiceView } from "../src/voice/hostedApi";
import { HostedVoiceController, describe as describeError, friendlyReason, type CreateInput } from "../src/voice/hostedController";

const SETTINGS = { modelId: "eleven_flash_v2_5", stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, useSpeakerBoost: true };
const voice = (status: VoiceView["status"] = "active"): VoiceView => ({ status, settings: SETTINGS, consent: { mode: "self" }, clips: [], createdAt: "", updatedAt: "" });
const CONSENT = { version: "v1", statements: ["a", "b"] };
const FILES = [{ name: "a.webm", blob: new Blob(["x"]) }];
const ALL_OK: CreateInput = { mode: "self", authorizedBy: "", acknowledged: true, remoteProcessingAcknowledged: true };

function setup(over: Partial<Record<string, (...a: any[]) => any>> = {}) {
  const calls: string[] = [];
  const api = {
    consentText: async () => CONSENT,
    getVoice: async () => null as VoiceView | null,
    createVoice: async (_c: unknown, _f: unknown) => ({ voice: voice(), skippedClips: [] }),
    updateVoice: async (_p: unknown) => voice(),
    deleteVoice: async () => undefined,
    speak: async (_t: string) => ({ audio: new ArrayBuffer(0), contentType: "audio/mpeg", renderMs: 1 }),
    ...over,
  };
  const wrapped = Object.fromEntries(Object.entries(api).map(([k, f]) => [k, (...a: unknown[]) => (calls.push(k), (f as (...x: unknown[]) => unknown)(...a))])) as unknown as typeof api;
  const c = new HostedVoiceController(wrapped, async () => ({ tier: "cloned", ttfaMs: 321, fellBack: false }));
  return { c, calls };
}

describe("loading", () => {
  it("goes to `none` when the user has no voice, and loads the consent text", async () => {
    const { c } = setup();
    await c.refresh();
    expect(c.state).toMatchObject({ phase: "none", voice: null, consent: CONSENT, busy: false, error: null });
    expect(c.status()).toBeNull();
  });

  it.each([
    ["active", "ready"],
    ["paused", "ready"],
    ["deleting", "deleting"],
  ] as const)("a %s voice shows the %s screen", async (status, phase) => {
    const { c } = setup({ getVoice: async () => voice(status) });
    await c.refresh();
    expect(c.state.phase).toBe(phase);
    expect(c.status()).toBe(status);
  });

  it("tells signed-out from unreachable", async () => {
    const a = setup({ getVoice: async () => { throw new HostedVoiceError("x", "auth", 401); } });
    await a.c.refresh();
    expect(a.c.state.phase).toBe("signed-out");
    const b = setup({ getVoice: async () => { throw new HostedVoiceError("x", "network"); } });
    await b.c.refresh();
    expect(b.c.state).toMatchObject({ phase: "unreachable" });
    expect(b.c.state.error).toMatch(/Can't reach the voice service/);
  });

  it("an older, slower answer cannot overwrite a newer one", async () => {
    let first = true;
    let release!: (v: VoiceView | null) => void;
    const { c } = setup({ getVoice: () => (first ? ((first = false), new Promise((r) => (release = r))) : Promise.resolve(voice("active"))) });
    const slow = c.refresh();
    await c.refresh();
    expect(c.state.phase).toBe("ready");
    release(null);
    await slow;
    expect(c.state.phase).toBe("ready");
  });

  it("notifies subscribers, and stops when they unsubscribe", async () => {
    const { c } = setup();
    const seen: string[] = [];
    const off = c.subscribe((s) => seen.push(s.phase));
    await c.refresh();
    off();
    await c.refresh();
    expect(seen[0]).toBe("loading");
    expect(seen).toContain("none");
    const n = seen.length;
    await c.refresh();
    expect(seen.length).toBe(n);
  });
});

describe("creating a voice", () => {
  it.each([
    [{ acknowledged: false }, /own voice/],
    [{ remoteProcessingAcknowledged: false }, /sent to ElevenLabs/],
    [{ mode: "authorized" as const, authorizedBy: "  " }, /name of the voice owner/],
  ])("refuses before uploading anything: %j", async (patch, msg) => {
    const { c, calls } = setup();
    await c.refresh();
    expect(await c.create({ ...ALL_OK, ...patch }, FILES)).toBe(false);
    expect(c.state.error).toMatch(msg);
    expect(calls).not.toContain("createVoice");
    expect(c.state.phase).toBe("none");
  });

  it("needs at least one recording, and the consent text to have loaded", async () => {
    const a = setup();
    await a.c.refresh();
    expect(await a.c.create(ALL_OK, [])).toBe(false);
    expect(a.c.state.error).toMatch(/at least one recording/);
    const b = setup({ consentText: async () => { throw new HostedVoiceError("x", "network"); } });
    await b.c.refresh();
    expect(await b.c.create(ALL_OK, FILES)).toBe(false);
    expect(b.calls).not.toContain("createVoice");
  });

  it("sends the consent the person actually gave, with the version they were shown", async () => {
    let sent: any;
    const { c } = setup({ createVoice: async (consent: unknown) => ((sent = consent), { voice: voice(), skippedClips: [] }) });
    await c.refresh();
    expect(await c.create({ ...ALL_OK, mode: "authorized", authorizedBy: "  Sam  " }, FILES)).toBe(true);
    expect(sent).toEqual({ mode: "authorized", authorizedBy: "Sam", acknowledged: true, remoteProcessingAcknowledged: true, consentVersion: "v1" });
    expect(c.state).toMatchObject({ phase: "ready", notice: "Your voice is ready." });
  });

  it("goes through `creating` and does not mark the voice usable until it succeeds", async () => {
    const phases: string[] = [];
    let release!: () => void;
    const { c } = setup({ createVoice: () => new Promise((r) => (release = () => r({ voice: voice(), skippedClips: [] }))) });
    await c.refresh();
    c.subscribe((s) => phases.push(s.phase));
    const p = c.create(ALL_OK, FILES);
    expect(c.state.phase).toBe("creating");
    expect(c.status()).toBeNull();
    release();
    await p;
    expect(phases).toContain("creating");
    expect(c.state.phase).toBe("ready");
  });

  it("reports unusable recordings, and goes back to `none` so the person can try again", async () => {
    const skipped = [{ label: "clip", errors: ["far too quiet"] }];
    const { c } = setup({ createVoice: async () => { throw new HostedVoiceError("need at least 10 seconds of usable speech", "clips", 422, undefined, skipped); } });
    await c.refresh();
    expect(await c.create(ALL_OK, FILES)).toBe(false);
    expect(c.state).toMatchObject({ phase: "none", skipped, voice: null });
    expect(c.state.error).toBe("need at least 10 seconds of usable speech");
  });

  it("mentions recordings that were skipped even when it worked", async () => {
    const { c } = setup({ createVoice: async () => ({ voice: voice(), skippedClips: [{ label: "x", errors: ["silent"] }] }) });
    await c.refresh();
    await c.create(ALL_OK, FILES);
    expect(c.state.notice).toMatch(/could not be used/);
    expect(c.state.skipped).toHaveLength(1);
  });
});

describe("using and managing the voice", () => {
  it("pause and resume update the status the router relies on", async () => {
    const { c } = setup({ getVoice: async () => voice("active"), updateVoice: async (p: any) => voice(p.paused ? "paused" : "active") });
    await c.refresh();
    await c.setPaused(true);
    expect(c.status()).toBe("paused");
    expect(c.state.notice).toMatch(/system voice/);
    await c.setPaused(false);
    expect(c.status()).toBe("active");
  });

  it("saving settings sends only what changed", async () => {
    let sent: unknown;
    const { c } = setup({ getVoice: async () => voice(), updateVoice: async (p: unknown) => ((sent = p), voice()) });
    await c.refresh();
    await c.saveSettings({ stability: 0.9 });
    expect(sent).toEqual({ settings: { stability: 0.9 } });
  });

  it("a failed change shows a message and refreshes when the voice has vanished", async () => {
    const { c, calls } = setup({ getVoice: async () => voice(), updateVoice: async () => { throw new HostedVoiceError("no voice", "not_found", 404); } });
    await c.refresh();
    await c.setPaused(true);
    expect(c.state.error).toBe("no voice");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((x) => x === "getVoice").length).toBe(2);
  });

  it("a test sentence goes through the router and says which voice spoke", async () => {
    const { c } = setup({ getVoice: async () => voice() });
    await c.refresh();
    await c.test("Hello there.");
    expect(c.state.notice).toBe("Spoken in your voice, 321 ms.");
    await c.test("   ");
    expect(c.state.error).toBe("Type something to say.");
  });

  it("a test that fell back to the system voice says so, and why", async () => {
    const c = new HostedVoiceController({ consentText: async () => CONSENT, getVoice: async () => voice(), createVoice: async () => ({ voice: voice(), skippedClips: [] }), updateVoice: async () => voice(), deleteVoice: async () => undefined, speak: async () => ({ audio: new ArrayBuffer(0), contentType: "audio/mpeg", renderMs: 1 }) }, async () => ({ tier: "system", ttfaMs: 90, fellBack: true, reason: "cloned too slow (>2500 ms)" }));
    await c.refresh();
    await c.test("Hello.");
    expect(c.state.notice).toBe("Spoken in the system voice because your voice was too slow to answer.");
  });
});

describe("deleting", () => {
  it("removes the voice and returns to `none`", async () => {
    const { c } = setup({ getVoice: async () => voice() });
    await c.refresh();
    expect(await c.remove()).toBe(true);
    expect(c.state).toMatchObject({ phase: "none", voice: null, notice: "Your voice was deleted." });
    expect(c.status()).toBeNull();
  });

  it("if ElevenLabs cannot delete it yet, the voice is shown as `deleting` and can be retried", async () => {
    let n = 0;
    const { c } = setup({
      getVoice: async () => (n === 0 ? voice("active") : voice("deleting")),
      deleteVoice: async () => { n++; throw new HostedVoiceError("retried", "upstream", 502); },
    });
    await c.refresh();
    expect(await c.remove()).toBe(false);
    expect(c.state.phase).toBe("deleting");
    expect(c.status()).toBe("deleting"); // switched off: the router will not use it
    expect(c.state.error).toMatch(/marked for deletion/);
  });
});

describe("messages for people", () => {
  it("turns the router's reasons into plain words, with no stray punctuation", () => {
    expect(friendlyReason("cloned too slow (>2500 ms)")).toBe("your voice was too slow to answer");
    expect(friendlyReason("cloned failed: Could not reach the voice service.")).toBe("your voice wasn't available (Could not reach the voice service)");
    expect(friendlyReason("cloned not allowed")).toBe("your voice is switched off");
    expect(friendlyReason(undefined)).toBe("");
    expect(friendlyReason("something else")).toBe("something else");
  });

  it("opening the screen again starts clean: an old 'Spoken in…' notice does not linger", async () => {
    const { c } = setup({ getVoice: async () => voice() });
    await c.refresh();
    await c.test("Hello.");
    expect(c.state.notice).toMatch(/Spoken/);
    await c.refresh();
    expect(c.state.notice).toBeNull();
  });

  it("never shows technical detail for unknown errors, and keeps the service's own plain wording otherwise", () => {
    expect(describeError(new Error("TypeError: x is undefined at line 4"))).toBe("Something went wrong. Please try again.");
    expect(describeError(new HostedVoiceError("no free voice slots on the ElevenLabs account", "conflict", 409))).toBe("no free voice slots on the ElevenLabs account");
    expect(describeError(new HostedVoiceError("x", "rate_limited", 429, 7))).toMatch(/in 7 seconds/);
    expect(describeError(new HostedVoiceError("x", "locked", 423))).toMatch(/paused/);
    // a refusal is a setup problem and says so, with the command that diagnoses it; any other upstream failure is just "try again"
    const refused = describeError(new HostedVoiceError("create voice: ElevenLabs refused the request (check the API key, its permissions and the plan)", "upstream", 502));
    expect(refused).toMatch(/refused the request/);
    expect(refused).toMatch(/Starter plan/);
    expect(refused).toMatch(/hosted\.sh doctor/);
    // when ElevenLabs explains the refusal, the person sees that explanation
    const explained = describeError(new HostedVoiceError("speak: ElevenLabs refused the request (The API key you used is missing the permission text_to_speech). Check the API key, its permissions and the plan.", "upstream", 502));
    expect(explained).toMatch(/refused the request: The API key you used is missing the permission text_to_speech\./);
    expect(explained).toMatch(/text to speech and voices/);
    expect(describeError(new HostedVoiceError("speak: ElevenLabs refused the request. Check the API key, its permissions and the plan.", "upstream", 502))).toMatch(/usually means the API key is missing or wrong/);
    expect(describeError(new HostedVoiceError("create voice: ElevenLabs returned an error (HTTP 500)", "upstream", 502))).toBe("The voice provider (ElevenLabs) had a problem. Try again in a moment.");
  });
});


describe("a voice that ElevenLabs wants verified", () => {
  const needsIt = (): VoiceView => ({ ...voice("active"), needsVerification: true, voiceName: "vocaleyes-abc123-def456" });

  it("is created, but not offered to the router, and the person is told what to do", async () => {
    const { c } = setup({ createVoice: async () => ({ voice: needsIt(), skippedClips: [] }) });
    await c.refresh();
    expect(await c.create(ALL_OK, FILES)).toBe(true);
    expect(c.state.phase).toBe("ready");
    expect(c.state.notice).toMatch(/needs you to verify it before it can speak/);
    expect(c.status()).toBe("active"); // it exists...
    expect(c.usable()).toBe(false); // ...but the router must not try it on every sentence
  });

  it("an active, verified voice is usable; a paused or missing one is not", async () => {
    const a = setup({ getVoice: async () => voice("active") });
    await a.c.refresh();
    expect(a.c.usable()).toBe(true);
    const b = setup({ getVoice: async () => voice("paused") });
    await b.c.refresh();
    expect(b.c.usable()).toBe(false);
    const c2 = setup();
    await c2.c.refresh();
    expect(c2.c.usable()).toBe(false);
  });

  it("'I've verified' tries the voice once, and when it speaks the voice becomes usable", async () => {
    let verified = false;
    const speakCalls: string[] = [];
    const { c } = setup({
      getVoice: async () => (verified ? voice("active") : needsIt()),
      speak: async (t: string) => {
        speakCalls.push(t);
        if (!verified) throw new HostedVoiceError("ElevenLabs needs you to verify this voice before it can speak. Sign in to elevenlabs.io", "conflict", 409);
        return { audio: new ArrayBuffer(0), contentType: "audio/mpeg", renderMs: 1 };
      },
    });
    await c.refresh();
    expect(c.usable()).toBe(false);
    expect(await c.recheckVerification()).toBe(false); // not verified yet: says why, stays unusable
    expect(c.state.error).toMatch(/verify this voice before it can speak/);
    expect(c.usable()).toBe(false);
    verified = true; // the owner completed it at ElevenLabs
    expect(await c.recheckVerification()).toBe(true);
    expect(c.usable()).toBe(true);
    expect(c.state).toMatchObject({ notice: "Verified. Your voice is ready to use.", error: null });
    expect(speakCalls).toEqual(["Ready.", "Ready."]); // a tiny phrase: it costs a few characters, no more
  });

  it("a test that falls back because of verification refreshes so the screen shows the verify steps", async () => {
    let n = 0;
    const calls: string[] = [];
    const api = {
      consentText: async () => CONSENT,
      getVoice: async () => (calls.push("getVoice"), n++ === 0 ? voice("active") : needsIt()),
      createVoice: async () => ({ voice: voice(), skippedClips: [] }),
      updateVoice: async () => voice(),
      deleteVoice: async () => undefined,
      speak: async () => ({ audio: new ArrayBuffer(0), contentType: "audio/mpeg", renderMs: 1 }),
    };
    const c = new HostedVoiceController(api, async () => ({ tier: "system", ttfaMs: 50, fellBack: true, reason: "cloned failed: ElevenLabs needs you to verify this voice before it can speak." }));
    await c.refresh();
    expect(c.usable()).toBe(true);
    await c.test("Hello.");
    await new Promise((r) => setTimeout(r, 0));
    expect(c.state.voice?.needsVerification).toBe(true);
    expect(c.usable()).toBe(false);
  });
});
