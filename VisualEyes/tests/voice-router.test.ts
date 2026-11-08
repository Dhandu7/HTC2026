import { describe, expect, it } from "vitest";
import { VoiceRouter } from "../src/voice/router";
import { ClipMatcher, RecordedClipVoice } from "../src/voice/clips";
import { PcmPlayer, type AudioContextLike } from "../src/voice/pcmPlayer";
import { allowAll, type ProviderPlayback, type VoicePolicy, type VoiceProvider, type VoiceTier } from "../src/voice/provider";
import { voicePolicy, makeConsent, VoiceProfileStore, memoryKV } from "../src/voice/consent";

type Behaviour = "ok" | "slow" | "fail-start" | "fail-mid" | "miss";

/** A scriptable provider that records what it was asked to do. */
function fake(tier: VoiceTier, behaviour: Behaviour = "ok", playMs = 5) {
  const calls: string[] = [];
  const cancelled: string[] = [];
  const provider: VoiceProvider = {
    id: tier,
    tier,
    async canSpeak() {
      return behaviour !== "miss";
    },
    speak(text): ProviderPlayback {
      calls.push(text);
      let begin!: () => void;
      let finish!: () => void;
      let fail!: (e: Error) => void;
      const started = new Promise<void>((res, rej) => ((begin = res), (fail = rej)));
      const done = new Promise<void>((res, rej) => {
        finish = res;
        const prev = fail;
        fail = (e) => (prev(e), rej(e));
      });
      started.catch(() => {});
      done.catch(() => {});
      if (behaviour === "ok") {
        begin();
        setTimeout(finish, playMs);
      } else if (behaviour === "fail-start") {
        setTimeout(() => fail(new Error("boom")), 1);
      } else if (behaviour === "fail-mid") {
        begin();
        setTimeout(() => fail(new Error("died mid-play")), 3);
      } // "slow": never starts until cancelled
      return {
        started,
        done,
        cancel() {
          cancelled.push(text);
          begin();
          finish();
        },
      };
    },
  };
  return { provider, calls, cancelled };
}

const router = (providers: VoiceProvider[], extra: Partial<ConstructorParameters<typeof VoiceRouter>[0]> = {}) =>
  new VoiceRouter({ providers, startBudgetMs: { recording: 30, cached: 30, cloned: 30 }, ...extra });

describe("VoiceRouter tier order", () => {
  it("uses the first tier that can speak", async () => {
    const rec = fake("recording");
    const cloned = fake("cloned");
    const sys = fake("system");
    const r = await router([rec.provider, cloned.provider, sys.provider]).speak("I need help").done;
    expect(r.tier).toBe("recording");
    expect(r.fellBack).toBe(false);
    expect(cloned.calls).toEqual([]);
    expect(sys.calls).toEqual([]);
  });

  it("skips a tier that has no audio for this text without calling it a fallback", async () => {
    const rec = fake("recording", "miss");
    const cached = fake("cached", "miss");
    const cloned = fake("cloned");
    const r = await router([rec.provider, cached.provider, cloned.provider, fake("system").provider]).speak("hello there").done;
    expect(r.tier).toBe("cloned");
    expect(r.fellBack).toBe(false);
  });

  it("speaks empty text as nothing", async () => {
    const sys = fake("system");
    const r = await router([sys.provider]).speak("   ").done;
    expect(r.tier).toBeNull();
    expect(sys.calls).toEqual([]);
  });
});

describe("VoiceRouter fallbacks", () => {
  it("falls back to the system voice when the cloned tier is too slow, and cancels it", async () => {
    const cloned = fake("cloned", "slow");
    const sys = fake("system");
    const r = await router([cloned.provider, sys.provider]).speak("good morning").done;
    expect(r.tier).toBe("system");
    expect(r.fellBack).toBe(true);
    expect(r.reason).toMatch(/too slow/);
    expect(cloned.cancelled).toEqual(["good morning"]);
    expect(sys.calls).toEqual(["good morning"]);
  });

  it("falls back when a tier fails before starting", async () => {
    const r = await router([fake("cloned", "fail-start").provider, fake("system").provider]).speak("hi").done;
    expect(r.tier).toBe("system");
    expect(r.reason).toMatch(/cloned failed: boom/);
  });

  it("speaks the full text on the next tier when a tier dies mid-playback (never silent)", async () => {
    const cloned = fake("cloned", "fail-mid", 50);
    const sys = fake("system");
    const r = await router([cloned.provider, sys.provider]).speak("please wait").done;
    expect(r.tier).toBe("system");
    expect(r.fellBack).toBe(true);
    expect(sys.calls).toEqual(["please wait"]);
  });

  it("reports when nothing could speak", async () => {
    const r = await router([fake("recording", "miss").provider]).speak("hello").done;
    expect(r.tier).toBeNull();
    expect(r.reason).toMatch(/no provider/);
  });

  it("falls through when canSpeak throws", async () => {
    const bad: VoiceProvider = {
      id: "bad",
      tier: "cloned",
      canSpeak: async () => {
        throw new Error("sidecar down");
      },
      speak: () => {
        throw new Error("should not be called");
      },
    };
    const r = await router([bad, fake("system").provider]).speak("hello").done;
    expect(r.tier).toBe("system");
  });
});

describe("VoiceRouter cancel and last-wins", () => {
  it("a new speak cancels the one in progress", async () => {
    const sys = fake("system", "ok", 200);
    const rt = router([sys.provider]);
    const first = rt.speak("first sentence");
    await new Promise((r) => setTimeout(r, 10));
    const second = rt.speak("second sentence");
    const [a, b] = await Promise.all([first.done, second.done]);
    expect(a.cancelled).toBe(true);
    expect(sys.cancelled).toContain("first sentence");
    expect(b.tier).toBe("system");
  });

  it("cancel() stops playback", async () => {
    const sys = fake("system", "ok", 500);
    const rt = router([sys.provider]);
    const h = rt.speak("long one");
    await new Promise((r) => setTimeout(r, 10));
    h.cancel();
    const r = await h.done;
    expect(r.cancelled).toBe(true);
  });
});

describe("VoiceRouter policy", () => {
  it("never calls tiers the policy forbids, and still speaks via the system voice", async () => {
    const cloned = fake("cloned");
    const sys = fake("system");
    const none: VoicePolicy = { allows: (t) => t === "system" };
    const r = await router([cloned.provider, sys.provider], { policy: () => none }).speak("hello").done;
    expect(cloned.calls).toEqual([]);
    expect(r.tier).toBe("system");
    expect(r.fellBack).toBe(true);
    expect(r.reason).toMatch(/not allowed/);
  });

  it("with no consented profile only the system voice speaks", async () => {
    const rec = fake("recording");
    const sys = fake("system");
    const r = await router([rec.provider, sys.provider], { policy: () => voicePolicy(null) }).speak("hello").done;
    expect(rec.calls).toEqual([]);
    expect(r.tier).toBe("system");
  });

  it("paused cloning keeps real recordings but blocks cloned and cached audio", async () => {
    const store = new VoiceProfileStore(memoryKV());
    store.create(makeConsent({ profileId: "p1", mode: "self" }), "cloned");
    const paused = store.update({ paused: true });
    const policy = voicePolicy(paused);
    expect(policy.allows("recording")).toBe(true);
    expect(policy.allows("cached")).toBe(false);
    expect(policy.allows("cloned")).toBe(false);
    expect(allowAll.allows("cloned")).toBe(true);
  });
});

describe("RecordedClipVoice", () => {
  const ctx = (): AudioContextLike & { started: number; stopped: number } => {
    const state = { started: 0, stopped: 0 };
    return Object.assign(state, {
      currentTime: 0,
      destination: {},
      createBuffer: (_c: number, length: number) => ({ getChannelData: () => new Float32Array(length), duration: 0 }),
      createBufferSource() {
        const src = {
          buffer: null as unknown,
          onended: null as null | (() => void),
          connect() {},
          start() {
            state.started++;
            setTimeout(() => src.onended?.(), 5);
          },
          stop() {
            state.stopped++;
          },
        };
        return src;
      },
    });
  };

  it("plays the user's own clip for a normalized text match", async () => {
    const audio = ctx();
    const matcher = new ClipMatcher([{ id: "1", text: "I need help", clipFile: "c1" }]);
    const loaded: string[] = [];
    const voice = new RecordedClipVoice(
      matcher,
      { load: async (f) => (loaded.push(f), { samples: new Float32Array(10), sampleRate: 24000 }) },
      new PcmPlayer(audio),
    );
    const sys = fake("system");
    const r = await router([voice, sys.provider]).speak("  I NEED help!  ").done;
    expect(r.tier).toBe("recording");
    expect(loaded).toEqual(["c1"]);
    expect(audio.started).toBe(1);
    expect(sys.calls).toEqual([]);
  });

  it("falls back to the system voice when the clip cannot be loaded", async () => {
    const matcher = new ClipMatcher([{ id: "1", text: "yes", clipFile: "gone" }]);
    const voice = new RecordedClipVoice(
      matcher,
      {
        load: async () => {
          throw new Error("clip file missing");
        },
      },
      new PcmPlayer(ctx()),
    );
    const r = await router([voice, fake("system").provider]).speak("yes").done;
    expect(r.tier).toBe("system");
    expect(r.reason).toMatch(/clip file missing/);
  });

  it("does not claim text it has no recording for", async () => {
    const matcher = new ClipMatcher([{ id: "1", text: "yes", clipFile: "c" }]);
    const voice = new RecordedClipVoice(matcher, { load: async () => ({ samples: new Float32Array(1), sampleRate: 1 }) }, new PcmPlayer(ctx()));
    expect(await voice.canSpeak("yes please")).toBe(false);
    expect(await voice.canSpeak("Yes.")).toBe(true);
  });
});
