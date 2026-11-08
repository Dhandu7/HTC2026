// Picks which tier speaks. Rules (docs/VOICE_ENGINE_FLOW.md):
//  1. Providers are tried in the order given (recording → cached → cloned → system).
//  2. A tier the policy forbids (no consent, paused, mode off) is skipped.
//  3. A tier that cannot start within its budget is cancelled and the next tier speaks.
//  4. If a tier fails after audio started, the next tier speaks the full text. Never silent.
//  5. A new speak() cancels the current one. Last one wins.
//  6. The system voice is the last resort and has no budget.

import { allowAll, type SpeakHandle, type SpeakResult, type VoicePolicy, type VoiceProvider, type VoiceTier } from "./provider";

export interface RouterOptions {
  providers: VoiceProvider[];
  policy?: () => VoicePolicy;
  /** Max ms to wait for first audio, per tier. Missing = wait for the provider to settle. */
  startBudgetMs?: Partial<Record<VoiceTier, number>>;
  pace?: () => number;
  volume?: () => number;
  /** Audio has started for this text, in this tier (the "generating" wait is over). */
  onStart?: (tier: VoiceTier, text: string) => void;
  onResult?: (r: SpeakResult, text: string) => void;
  now?: () => number;
}

export const DEFAULT_START_BUDGET_MS: Partial<Record<VoiceTier, number>> = {
  recording: 400,
  cached: 400,
  cloned: 1500,
};

/** Wait for `p`, or give up after `ms`. The timer is always cleared. */
async function startedWithin(p: Promise<void>, ms: number | undefined): Promise<"started" | "timeout"> {
  if (!ms) {
    await p;
    return "started";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.then(() => "started" as const), new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class VoiceRouter {
  private current: { cancel(): void } | null = null;
  /** Most recent result, for the status pill. */
  last: SpeakResult | null = null;

  constructor(private readonly opts: RouterOptions) {}

  speak(text: string): SpeakHandle {
    this.current?.cancel();
    const state = { cancelled: false, active: null as { cancel(): void } | null };
    const handle = { cancel: () => this.cancelState(state) };
    this.current = handle;
    const done = this.run(text, state).then((r) => {
      this.last = r;
      this.opts.onResult?.(r, text);
      return r;
    });
    return { done, cancel: handle.cancel };
  }

  cancel(): void {
    this.current?.cancel();
    this.current = null;
  }

  private cancelState(s: { cancelled: boolean; active: { cancel(): void } | null }) {
    s.cancelled = true;
    s.active?.cancel();
  }

  private async run(text: string, state: { cancelled: boolean; active: { cancel(): void } | null }): Promise<SpeakResult> {
    const now = this.opts.now ?? (() => Date.now());
    const t0 = now();
    const policy = (this.opts.policy ?? (() => allowAll))();
    const budgets = { ...DEFAULT_START_BUDGET_MS, ...this.opts.startBudgetMs };
    const pace = this.opts.pace?.() ?? 1;
    const volume = this.opts.volume?.();
    const result = (over: Partial<SpeakResult>): SpeakResult => ({
      tier: null,
      provider: null,
      ttfaMs: 0,
      totalMs: now() - t0,
      fellBack: false,
      ...over,
    });
    if (!text.trim()) return result({ reason: "empty text" });

    let skipped: string | undefined;
    for (const provider of this.opts.providers) {
      if (state.cancelled) return result({ cancelled: true, fellBack: !!skipped, reason: skipped });
      if (!policy.allows(provider.tier)) {
        if (provider.tier !== "system") skipped ??= `${provider.tier} not allowed`;
        continue;
      }
      let can = false;
      try {
        can = await provider.canSpeak(text);
      } catch {
        can = false;
      }
      if (!can) {
        // "Cannot speak" is normal for recording/cached misses; only count it as a fallback if the tier was meant to work.
        continue;
      }
      if (state.cancelled) return result({ cancelled: true, fellBack: !!skipped, reason: skipped });

      const playback = provider.speak(text, volume === undefined ? { pace } : { pace, volume });
      state.active = playback;
      const budget = budgets[provider.tier];
      try {
        if ((await startedWithin(playback.started, budget)) === "timeout") {
          playback.cancel();
          state.active = null;
          skipped ??= `${provider.tier} too slow (>${budget} ms)`;
          continue;
        }
        const ttfaMs = now() - t0;
        if (!state.cancelled) this.opts.onStart?.(provider.tier, text);
        await playback.done;
        state.active = null;
        return result({
          tier: provider.tier,
          provider: provider.id,
          ttfaMs,
          fellBack: !!skipped,
          reason: skipped,
          cancelled: state.cancelled || undefined,
        });
      } catch (e) {
        playback.cancel();
        state.active = null;
        if (state.cancelled) return result({ cancelled: true, fellBack: !!skipped, reason: skipped });
        skipped ??= `${provider.tier} failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return result({ fellBack: !!skipped, reason: skipped ?? "no provider could speak this text" });
  }
}
