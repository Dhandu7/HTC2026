// T3: the system voice (speechSynthesis). Always available, never needs consent.
// This is exactly what Speak did before the voice router existed.

import type { ProviderPlayback, SpeakOptions, VoiceProvider } from "./provider";

/** The slice of speechSynthesis we use, so tests can inject a fake. */
export interface SynthLike {
  speak(u: SpeechSynthesisUtterance): void;
  cancel(): void;
}

export class SystemVoice implements VoiceProvider {
  readonly id = "system";
  readonly tier = "system" as const;

  constructor(
    private readonly synth: SynthLike | null = typeof speechSynthesis !== "undefined" ? speechSynthesis : null,
    private readonly makeUtterance: (text: string) => SpeechSynthesisUtterance = (t) => new SpeechSynthesisUtterance(t),
  ) {}

  async canSpeak(text: string): Promise<boolean> {
    return !!this.synth && text.trim().length > 0;
  }

  speak(text: string, opts: SpeakOptions): ProviderPlayback {
    const synth = this.synth;
    if (!synth) {
      const err = Promise.reject(new Error("speechSynthesis unavailable"));
      err.catch(() => {});
      return { started: err, done: err, cancel() {} };
    }
    const u = this.makeUtterance(text);
    if (opts.pace) u.rate = opts.pace;
    let cancelled = false;
    let markStarted!: () => void;
    let markDone!: () => void;
    let fail!: (e: Error) => void;
    const started = new Promise<void>((res, rej) => {
      markStarted = res;
      fail = rej;
    });
    const done = new Promise<void>((res, rej) => {
      markDone = res;
      const prev = fail;
      fail = (e) => {
        prev(e);
        rej(e);
      };
    });
    started.catch(() => {});
    done.catch(() => {});
    u.onstart = () => markStarted();
    u.onend = () => {
      markStarted();
      markDone();
    };
    u.onerror = (e) => {
      // "canceled" / "interrupted" is what speechSynthesis reports when we cancel on purpose.
      if (cancelled || e.error === "canceled" || e.error === "interrupted") {
        markStarted();
        markDone();
      } else fail(new Error(`speechSynthesis error: ${e.error}`));
    };
    synth.cancel(); // last speak wins; the browser queues utterances otherwise
    synth.speak(u);
    return {
      started,
      done,
      cancel: () => {
        cancelled = true;
        synth.cancel();
        markStarted();
        markDone();
      },
    };
  }
}
