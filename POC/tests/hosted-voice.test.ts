import { describe, expect, it } from "vitest";
import { HostedVoiceError } from "../src/voice/hostedApi";
import { HostedVoice, MAX_SPOKEN_CHARS, type AudioSink } from "../src/voice/hostedVoice";
import type { Pcm } from "../src/voice/pcmPlayer";
import type { ProviderPlayback, VoiceProvider } from "../src/voice/provider";
import { VoiceRouter } from "../src/voice/router";

const PCM: Pcm = { samples: new Float32Array(100), sampleRate: 44100 };

function sink(opts: { decodeFails?: boolean; playMs?: number } = {}) {
  const log: string[] = [];
  const s: AudioSink = {
    async decode() {
      log.push("decode");
      if (opts.decodeFails) throw new Error("bad audio");
      return PCM;
    },
    play(): ProviderPlayback {
      log.push("play");
      let end!: () => void;
      const done = new Promise<void>((r) => (end = r));
      setTimeout(end, opts.playMs ?? 5);
      return { started: Promise.resolve(), done, cancel: () => (log.push("stop"), end()) };
    },
  };
  return { s, log };
}

function api(handler: (text: string, signal?: AbortSignal) => Promise<{ audio: ArrayBuffer; contentType: string; renderMs: number }>) {
  const calls: string[] = [];
  return { calls, speak: (t: string, _s?: unknown, signal?: AbortSignal) => (calls.push(t), handler(t, signal)) };
}
const ok = async () => ({ audio: new ArrayBuffer(8), contentType: "audio/mpeg", renderMs: 50 });

describe("HostedVoice.canSpeak", () => {
  it("only when the voice is active, and only for text the service accepts", async () => {
    let active = true;
    const v = new HostedVoice(api(ok), sink().s, () => active);
    expect(await v.canSpeak("Hello.")).toBe(true);
    expect(await v.canSpeak("   ")).toBe(false);
    expect(await v.canSpeak("x".repeat(MAX_SPOKEN_CHARS + 1))).toBe(false);
    active = false; // paused, deleting, or no voice
    expect(await v.canSpeak("Hello.")).toBe(false);
  });
});

describe("HostedVoice.speak", () => {
  it("fetches, decodes, then plays; started and done resolve in order", async () => {
    const { s, log } = sink();
    const a = api(ok);
    const p = new HostedVoice(a, s, () => true).speak("Hello there.", {});
    await p.started;
    expect(log).toEqual(["decode", "play"]);
    await p.done;
    expect(a.calls).toEqual(["Hello there."]);
  });

  it("a service failure rejects started and done, so the router can fall back", async () => {
    const p = new HostedVoice(api(async () => { throw new HostedVoiceError("down", "upstream", 502); }), sink().s, () => true).speak("hi", {});
    await expect(p.started).rejects.toThrow("down");
    await expect(p.done).rejects.toThrow("down");
  });

  it("undecodable audio also rejects instead of staying silent", async () => {
    const p = new HostedVoice(api(ok), sink({ decodeFails: true }).s, () => true).speak("hi", {});
    await expect(p.started).rejects.toThrow("bad audio");
  });

  it("cancelling before the answer arrives aborts the request and plays nothing", async () => {
    let seen: AbortSignal | undefined;
    const { s, log } = sink();
    const a = api((_t, signal) => {
      seen = signal;
      return new Promise((res) => setTimeout(() => res({ audio: new ArrayBuffer(8), contentType: "audio/mpeg", renderMs: 1 }), 30));
    });
    const p = new HostedVoice(a, s, () => true).speak("hi", {});
    p.cancel();
    await p.started;
    await p.done;
    await new Promise((r) => setTimeout(r, 60));
    expect(seen?.aborted).toBe(true);
    expect(log).toEqual([]); // the late answer was ignored
  });

  it("cancelling during playback stops it", async () => {
    const { s, log } = sink({ playMs: 1000 });
    const p = new HostedVoice(api(ok), s, () => true).speak("hi", {});
    await p.started;
    p.cancel();
    await p.done;
    expect(log).toContain("stop");
  });
});

describe("inside the voice router", () => {
  const system = (log: string[]): VoiceProvider => ({
    id: "system",
    tier: "system",
    canSpeak: async () => true,
    speak: (t) => (log.push(`system:${t}`), { started: Promise.resolve(), done: Promise.resolve(), cancel() {} }),
  });
  const router = (hosted: VoiceProvider, sys: VoiceProvider, active: () => boolean) =>
    new VoiceRouter({ providers: [hosted, sys], policy: () => ({ allows: (t) => t === "system" || (t === "cloned" && active()) }), startBudgetMs: { cloned: 100 } });

  it("speaks in the user's voice when it is active", async () => {
    const log: string[] = [];
    const r = await router(new HostedVoice(api(ok), sink().s, () => true), system(log), () => true).speak("Hello.").done;
    expect(r.tier).toBe("cloned");
    expect(r.provider).toBe("elevenlabs");
    expect(log).toEqual([]);
  });

  it("falls back to the system voice, and says why, when the service fails", async () => {
    const log: string[] = [];
    const hosted = new HostedVoice(api(async () => { throw new HostedVoiceError("down", "upstream", 502); }), sink().s, () => true);
    const r = await router(hosted, system(log), () => true).speak("Hello.").done;
    expect(r.tier).toBe("system");
    expect(r.fellBack).toBe(true);
    expect(r.reason).toMatch(/cloned failed/);
    expect(log).toEqual(["system:Hello."]);
  });

  it("falls back when the service is too slow", async () => {
    const log: string[] = [];
    const hosted = new HostedVoice(api(() => new Promise(() => {})), sink().s, () => true);
    const r = await router(hosted, system(log), () => true).speak("Hello.").done;
    expect(r.tier).toBe("system");
    expect(r.reason).toMatch(/too slow/);
  });

  it("a voice waiting for verification is skipped without calling the service on every sentence", async () => {
    const log: string[] = [];
    const a = api(ok);
    const r = await router(new HostedVoice(a, sink().s, () => false /* usable() is false until verified */), system(log), () => false).speak("Hello.").done;
    expect(r.tier).toBe("system");
    expect(a.calls).toEqual([]);
    expect(r.ttfaMs).toBeLessThan(100); // no wasted round trip before the system voice speaks
  });

  it("a paused or missing voice never reaches the service at all", async () => {
    const log: string[] = [];
    const a = api(ok);
    const r = await router(new HostedVoice(a, sink().s, () => false), system(log), () => false).speak("Hello.").done;
    expect(r.tier).toBe("system");
    expect(a.calls).toEqual([]);
  });
});
