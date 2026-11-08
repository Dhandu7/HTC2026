// Consent and voice-profile state. Nothing cloned or recorded may be used unless a
// consent record exists, and consent is bound to the app profile (not to an audio file).
// Pure TypeScript with an injected key-value store, so it runs in tests and in the browser.

import type { VoicePolicy, VoiceTier } from "./provider";

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const memoryKV = (): KVStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
};

export type ConsentMode = "self" | "authorized";

export interface ConsentRecord {
  profileId: string;
  mode: ConsentMode;
  ts: number;
  /** Required when mode is "authorized": who gave documented permission (the voice owner). */
  authorizedBy?: string;
}

/** off: no personal voice. clips-only: real recordings only. cloned: recordings plus cloned audio. */
export type VoiceMode = "off" | "clips-only" | "cloned";

export interface VoiceProfileState {
  profileId: string;
  consent: ConsentRecord;
  mode: VoiceMode;
  paused: boolean;
  /** Bumped on re-record so cached cloned audio for the old voice is never reused. */
  embeddingVersion: number;
  delivery: { pace: number };
}

const KEY = "gazetype.voice.profile.v1";

export class ConsentError extends Error {}

export function makeConsent(
  input: { profileId: string; mode: ConsentMode; authorizedBy?: string },
  now: () => number = () => Date.now(),
): ConsentRecord {
  if (!input.profileId.trim()) throw new ConsentError("profile id required");
  if (input.mode === "authorized" && !input.authorizedBy?.trim()) {
    throw new ConsentError("authorized consent needs the name of the person who gave permission");
  }
  return {
    profileId: input.profileId,
    mode: input.mode,
    ts: now(),
    ...(input.mode === "authorized" ? { authorizedBy: input.authorizedBy!.trim() } : {}),
  };
}

const isConsent = (c: unknown): c is ConsentRecord => {
  const r = c as ConsentRecord | null;
  return (
    !!r &&
    typeof r.profileId === "string" &&
    r.profileId.length > 0 &&
    (r.mode === "self" || r.mode === "authorized") &&
    typeof r.ts === "number" &&
    (r.mode === "self" || (typeof r.authorizedBy === "string" && r.authorizedBy.length > 0))
  );
};

export class VoiceProfileStore {
  constructor(private readonly kv: KVStore) {}

  /** Returns the stored profile, or null if there is none or it has no valid consent record. */
  load(): VoiceProfileState | null {
    const raw = this.kv.get(KEY);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as VoiceProfileState;
      if (!isConsent(s.consent) || s.consent.profileId !== s.profileId) return null;
      return {
        profileId: s.profileId,
        consent: s.consent,
        mode: s.mode === "cloned" || s.mode === "clips-only" ? s.mode : "off",
        paused: !!s.paused,
        embeddingVersion: Number.isInteger(s.embeddingVersion) ? s.embeddingVersion : 0,
        delivery: { pace: Math.min(1.2, Math.max(0.8, s.delivery?.pace ?? 1)) },
      };
    } catch {
      return null;
    }
  }

  /** Create the profile. Consent comes first: there is no way to create a profile without it. */
  create(consent: ConsentRecord, mode: VoiceMode = "clips-only"): VoiceProfileState {
    if (!isConsent(consent)) throw new ConsentError("valid consent record required");
    const s: VoiceProfileState = {
      profileId: consent.profileId,
      consent,
      mode,
      paused: false,
      embeddingVersion: 0,
      delivery: { pace: 1 },
    };
    this.save(s);
    return s;
  }

  update(patch: Partial<Pick<VoiceProfileState, "mode" | "paused" | "delivery">>): VoiceProfileState {
    const s = this.load();
    if (!s) throw new ConsentError("no voice profile");
    const next = { ...s, ...patch };
    this.save(next);
    return next;
  }

  /** Call after the user re-records: invalidates cloned-audio caches keyed on the version. */
  bumpEmbeddingVersion(): VoiceProfileState {
    const s = this.load();
    if (!s) throw new ConsentError("no voice profile");
    const next = { ...s, embeddingVersion: s.embeddingVersion + 1 };
    this.save(next);
    return next;
  }

  /** Remove the profile and its consent record. Callers also delete clips, embeddings and caches. */
  delete(): void {
    this.kv.remove(KEY);
  }

  private save(s: VoiceProfileState) {
    this.kv.set(KEY, JSON.stringify(s));
  }
}

/** Which tiers the current profile allows. The system voice is always allowed. */
export function voicePolicy(state: VoiceProfileState | null): VoicePolicy {
  return {
    allows(tier: VoiceTier): boolean {
      if (tier === "system") return true;
      if (!state || !isConsent(state.consent) || state.mode === "off") return false;
      if (tier === "recording") return true; // recorded clips may stay on while cloning is paused
      return state.mode === "cloned" && !state.paused; // cached + cloned audio are AI-assisted
    },
  };
}
