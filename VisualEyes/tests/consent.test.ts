import { describe, expect, it } from "vitest";
import { ConsentError, VoiceProfileStore, makeConsent, memoryKV, voicePolicy } from "../src/voice/consent";

describe("makeConsent", () => {
  it("records a self consent with a timestamp", () => {
    expect(makeConsent({ profileId: "p1", mode: "self" }, () => 123)).toEqual({ profileId: "p1", mode: "self", ts: 123 });
  });

  it("requires the authorizing person's name for carer-authorized consent", () => {
    expect(() => makeConsent({ profileId: "p1", mode: "authorized" })).toThrow(ConsentError);
    expect(() => makeConsent({ profileId: "p1", mode: "authorized", authorizedBy: "  " })).toThrow(ConsentError);
    expect(makeConsent({ profileId: "p1", mode: "authorized", authorizedBy: " Sam " }, () => 1).authorizedBy).toBe("Sam");
  });

  it("requires a profile id", () => {
    expect(() => makeConsent({ profileId: " ", mode: "self" })).toThrow(ConsentError);
  });
});

describe("VoiceProfileStore", () => {
  const consent = () => makeConsent({ profileId: "p1", mode: "self" }, () => 1);

  it("has no profile until one is created with consent", () => {
    const s = new VoiceProfileStore(memoryKV());
    expect(s.load()).toBeNull();
    expect(() => s.update({ paused: true })).toThrow(ConsentError);
    // @ts-expect-error a profile cannot be created without a consent record
    expect(() => s.create(undefined)).toThrow(ConsentError);
    expect(s.load()).toBeNull();
  });

  it("persists and reloads state", () => {
    const kv = memoryKV();
    new VoiceProfileStore(kv).create(consent(), "cloned");
    const s = new VoiceProfileStore(kv).load()!;
    expect(s.mode).toBe("cloned");
    expect(s.paused).toBe(false);
    expect(s.consent.profileId).toBe("p1");
  });

  it("ignores stored data whose consent is missing or tampered with", () => {
    const kv = memoryKV();
    const s = new VoiceProfileStore(kv);
    s.create(consent(), "cloned");
    const stored = JSON.parse(kv.get("gazetype.voice.profile.v1")!);
    delete stored.consent;
    kv.set("gazetype.voice.profile.v1", JSON.stringify(stored));
    expect(s.load()).toBeNull();
    kv.set("gazetype.voice.profile.v1", "not json");
    expect(s.load()).toBeNull();
    s.create(consent(), "cloned");
    const other = JSON.parse(kv.get("gazetype.voice.profile.v1")!);
    other.profileId = "someone-else";
    kv.set("gazetype.voice.profile.v1", JSON.stringify(other));
    expect(s.load()).toBeNull();
  });

  it("bumps the embedding version on re-record", () => {
    const s = new VoiceProfileStore(memoryKV());
    s.create(consent(), "cloned");
    expect(s.bumpEmbeddingVersion().embeddingVersion).toBe(1);
    expect(s.load()!.embeddingVersion).toBe(1);
  });

  it("clamps the speaking pace to a sane range", () => {
    const s = new VoiceProfileStore(memoryKV());
    s.create(consent(), "cloned");
    s.update({ delivery: { pace: 5 } });
    expect(s.load()!.delivery.pace).toBe(1.2);
  });

  it("delete removes the profile and its consent record", () => {
    const kv = memoryKV();
    const s = new VoiceProfileStore(kv);
    s.create(consent(), "cloned");
    s.delete();
    expect(s.load()).toBeNull();
    expect(kv.get("gazetype.voice.profile.v1")).toBeNull();
  });
});

describe("voicePolicy", () => {
  const profile = (mode: "off" | "clips-only" | "cloned", paused = false) => {
    const s = new VoiceProfileStore(memoryKV());
    s.create(makeConsent({ profileId: "p1", mode: "self" }), mode);
    return s.update({ paused });
  };

  it("always allows the system voice, even with no profile", () => {
    expect(voicePolicy(null).allows("system")).toBe(true);
    expect(voicePolicy(null).allows("recording")).toBe(false);
  });

  it.each([
    ["off", false, { recording: false, cached: false, cloned: false }],
    ["clips-only", false, { recording: true, cached: false, cloned: false }],
    ["cloned", false, { recording: true, cached: true, cloned: true }],
    ["cloned", true, { recording: true, cached: false, cloned: false }],
  ] as const)("mode %s paused=%s", (mode, paused, expected) => {
    const p = voicePolicy(profile(mode, paused));
    expect(p.allows("recording")).toBe(expected.recording);
    expect(p.allows("cached")).toBe(expected.cached);
    expect(p.allows("cloned")).toBe(expected.cloned);
  });
});
