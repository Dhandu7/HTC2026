// Voice provider contract. A provider is one speaking tier (see docs/VOICE_ENGINE_FLOW.md):
//   recording → the user's real clip, cached → pre-rendered cloned clip,
//   cloned → live render from the sidecar, system → speechSynthesis.
// Providers are pure adapters: tier choice, budgets and fallback live in router.ts.

export type VoiceTier = "recording" | "cached" | "cloned" | "system";

export interface SpeakOptions {
  /** Speaking rate multiplier, 1 = normal. */
  pace?: number;
}

/** One in-flight utterance on a single provider. */
export interface ProviderPlayback {
  /** Resolves when audio has started (or is scheduled to start immediately). Rejects if it never can. */
  started: Promise<void>;
  /** Resolves when playback finished or was cancelled. Rejects on failure. */
  done: Promise<void>;
  /** Stop playing. A provider may keep rendering in the background (e.g. to fill the cache). */
  cancel(): void;
}

export interface VoiceProvider {
  readonly id: string;
  readonly tier: VoiceTier;
  /** Cheap and side-effect free: can this provider speak this exact text right now? */
  canSpeak(text: string): Promise<boolean>;
  speak(text: string, opts: SpeakOptions): ProviderPlayback;
}

export interface SpeakResult {
  tier: VoiceTier | null;
  provider: string | null;
  /** Time from speak() to first audio. */
  ttfaMs: number;
  totalMs: number;
  /** True if a higher tier was skipped because it failed or was too slow. */
  fellBack: boolean;
  /** Why a higher tier was skipped, or why nothing played. */
  reason?: string;
  cancelled?: boolean;
}

export interface SpeakHandle {
  done: Promise<SpeakResult>;
  cancel(): void;
}

/** Which tiers the user's consent and settings currently allow. */
export interface VoicePolicy {
  allows(tier: VoiceTier): boolean;
}

export const allowAll: VoicePolicy = { allows: () => true };

/** A playback that failed before it began: used when a provider cannot even start. */
export function failedPlayback(error: unknown): ProviderPlayback {
  const p = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  p.catch(() => {});
  return { started: p, done: p, cancel() {} };
}
