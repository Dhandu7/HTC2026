// T0: the user's own recordings. Matching is by normalized text, so "I need help!" and
// "i need help" both find the same clip. Audio decoding is injected so this runs in tests.

import { normalizeText } from "../metrics/session";
import type { Pcm } from "./pcmPlayer";
import { PcmPlayer } from "./pcmPlayer";
import { failedPlayback, type ProviderPlayback, type SpeakOptions, type VoiceProvider } from "./provider";

export interface ClipPhrase {
  id: string;
  text: string;
  /** Storage key of the audio in the clip store. */
  clipFile: string;
}

export class ClipMatcher {
  private byNorm = new Map<string, ClipPhrase>();

  constructor(phrases: ClipPhrase[] = []) {
    this.set(phrases);
  }

  set(phrases: ClipPhrase[]): void {
    this.byNorm.clear();
    for (const p of phrases) {
      const n = normalizeText(p.text);
      if (n) this.byNorm.set(n, p);
    }
  }

  match(text: string): ClipPhrase | null {
    const n = normalizeText(text);
    return n ? (this.byNorm.get(n) ?? null) : null;
  }

  get size(): number {
    return this.byNorm.size;
  }
}

export interface ClipSource {
  /** Returns the decoded audio for a stored clip. */
  load(clipFile: string): Promise<Pcm>;
}

export class RecordedClipVoice implements VoiceProvider {
  readonly id = "recording";
  readonly tier = "recording" as const;

  constructor(
    private readonly matcher: ClipMatcher,
    private readonly source: ClipSource,
    private readonly player: PcmPlayer,
  ) {}

  async canSpeak(text: string): Promise<boolean> {
    return this.matcher.match(text) !== null;
  }

  speak(text: string, _opts: SpeakOptions): ProviderPlayback {
    const phrase = this.matcher.match(text);
    if (!phrase) return failedPlayback(new Error("no recording for this text"));
    let inner: ProviderPlayback | null = null;
    let cancelled = false;
    let finish!: () => void;
    let begin!: () => void;
    let fail!: (e: Error) => void;
    const started = new Promise<void>((res, rej) => {
      begin = res;
      fail = rej;
    });
    const done = new Promise<void>((res, rej) => {
      finish = res;
      const prev = fail;
      fail = (e) => {
        prev(e);
        rej(e);
      };
    });
    started.catch(() => {});
    done.catch(() => {});
    this.source.load(phrase.clipFile).then(
      (pcm) => {
        if (cancelled) return;
        inner = this.player.play(pcm);
        inner.started.then(begin, fail);
        inner.done.then(finish, fail);
      },
      (e) => fail(e instanceof Error ? e : new Error(String(e))),
    );
    return {
      started,
      done,
      cancel: () => {
        cancelled = true;
        inner?.cancel();
        begin();
        finish();
      },
    };
  }
}
