// The "cloned" tier of the voice router: speaks in the user's own hosted voice (ElevenLabs via our service).
// Plugs into router.ts like any other provider, so a slow, failing, paused or missing voice falls back to the
// system voice instead of leaving the user silent.

import type { HostedVoiceApi } from "./hostedApi";
import { PcmPlayer, type Pcm } from "./pcmPlayer";
import { failedPlayback, type ProviderPlayback, type SpeakOptions, type VoiceProvider } from "./provider";

/** Decodes the service's audio (MP3 or WAV) and plays it. Browser: BrowserAudioSink. Tests: a fake. */
export interface AudioSink {
  decode(bytes: ArrayBuffer): Promise<Pcm>;
  play(pcm: Pcm): ProviderPlayback;
}

export class BrowserAudioSink implements AudioSink {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private player: PcmPlayer | null = null;
  private level = 1;

  private get(): { ctx: AudioContext; player: PcmPlayer } {
    // Created on first use, which happens after the user's click, so the browser lets it play.
    this.ctx ??= new AudioContext();
    if (!this.gain) {
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.level;
      this.gain.connect(this.ctx.destination);
    }
    this.player ??= new PcmPlayer(this.ctx as unknown as ConstructorParameters<typeof PcmPlayer>[0], this.gain);
    return { ctx: this.ctx, player: this.player };
  }

  /** Loudness 0..1 for everything this sink plays. */
  setVolume(v: number) {
    this.level = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.level;
  }

  /** Pause and resume whatever is playing (the clip keeps its place). */
  pause() {
    void this.ctx?.suspend().catch(() => {});
  }

  resume() {
    void this.ctx?.resume().catch(() => {});
  }

  async decode(bytes: ArrayBuffer): Promise<Pcm> {
    const buf = await this.get().ctx.decodeAudioData(bytes.slice(0));
    return { samples: buf.getChannelData(0), sampleRate: buf.sampleRate };
  }

  play(pcm: Pcm): ProviderPlayback {
    return this.get().player.play(pcm);
  }
}

export const MAX_SPOKEN_CHARS = 1000; // the service's own limit; longer text is left to the system voice

export class HostedVoice implements VoiceProvider {
  readonly id = "elevenlabs";
  readonly tier = "cloned" as const;

  constructor(
    private readonly api: Pick<HostedVoiceApi, "speak">,
    private readonly audio: AudioSink,
    private readonly isActive: () => boolean,
  ) {}

  async canSpeak(text: string): Promise<boolean> {
    const t = text.trim();
    return this.isActive() && t.length > 0 && t.length <= MAX_SPOKEN_CHARS;
  }

  speak(text: string, _opts: SpeakOptions): ProviderPlayback {
    if (!text.trim()) return failedPlayback(new Error("nothing to say"));
    const ctl = new AbortController();
    let cancelled = false;
    let inner: ProviderPlayback | null = null;
    let begin!: () => void;
    let finish!: () => void;
    let failStarted!: (e: Error) => void;
    let failDone!: (e: Error) => void;
    const started = new Promise<void>((res, rej) => ((begin = res), (failStarted = rej)));
    const done = new Promise<void>((res, rej) => ((finish = res), (failDone = rej)));
    started.catch(() => {});
    done.catch(() => {});
    const fail = (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      failStarted(err);
      failDone(err);
    };

    this.api
      .speak(text, undefined, ctl.signal)
      .then(async (r) => {
        if (cancelled) return;
        const pcm = await this.audio.decode(r.audio);
        if (cancelled) return;
        inner = this.audio.play(pcm);
        inner.started.then(begin, fail);
        inner.done.then(finish, fail);
      })
      .catch((e) => (cancelled ? (begin(), finish()) : fail(e)));

    return {
      started,
      done,
      cancel: () => {
        cancelled = true;
        ctl.abort();
        inner?.cancel();
        begin();
        finish();
      },
    };
  }
}
