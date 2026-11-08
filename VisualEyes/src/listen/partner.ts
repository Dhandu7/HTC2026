// Transcribes the conversation partner through the browser's speech recognition (Web Speech API), so the user can
// get replies to what was just said. Chrome and Edge only; Chrome sends the microphone audio to Google's speech
// service for transcription, which the Settings screen says plainly. Off by default. No audio is kept.
//
// Chrome stops a continuous session after a pause, so the listener restarts it while `active` is set. While the
// app itself is speaking the recogniser is muted (its results are ignored), and listen/conversation.ts drops any
// echo that still gets through.

export type ListenState = "off" | "starting" | "on" | "muted" | "unsupported" | "denied" | "error";

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

export function speechRecognitionCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface PartnerListenerOpts {
  lang?: string;
  /** A sentence is finished. */
  onFinal(text: string): void;
  /** Words so far of the sentence being spoken (may be empty when it resets). */
  onInterim?(text: string): void;
  onState?(state: ListenState): void;
  ctor?: RecognitionCtor | null;
}

export class PartnerListener {
  state: ListenState = "off";
  /** Why the state is "error": "network" (speech service unreachable), "audio-capture" (no microphone), ... */
  lastError: string | null = null;
  private rec: RecognitionLike | null = null;
  private active = false;
  private mutedUntil = 0;
  private readonly ctor: RecognitionCtor | null;

  constructor(private readonly o: PartnerListenerOpts) {
    this.ctor = o.ctor === undefined ? speechRecognitionCtor() : o.ctor;
    // Quietly: the owner hears about it when it tries to start, never during its own construction.
    if (!this.ctor) this.state = "unsupported";
  }

  get supported() {
    return !!this.ctor;
  }

  start() {
    if (!this.ctor) return this.o.onState?.("unsupported");
    if (this.active) return;
    this.active = true;
    this.set("starting");
    this.open();
  }

  stop() {
    this.active = false;
    const r = this.rec;
    this.rec = null;
    try {
      r?.abort();
    } catch {
      /* already stopped */
    }
    this.set("off");
  }

  /** Ignore results for a while: the app is speaking and the microphone will hear it. */
  mute(ms: number) {
    this.mutedUntil = Math.max(this.mutedUntil, Date.now() + ms);
    if (this.active && this.state === "on") this.set("muted");
    this.o.onInterim?.("");
  }

  unmute() {
    this.mutedUntil = 0;
    if (this.active && this.state === "muted") this.set("on");
  }

  private get muted() {
    return Date.now() < this.mutedUntil;
  }

  private set(s: ListenState) {
    if (this.state === s) return;
    this.state = s;
    this.o.onState?.(s);
  }

  private open() {
    if (!this.active || !this.ctor) return;
    const r = new this.ctor();
    this.rec = r;
    r.lang = this.o.lang ?? "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      if (this.rec !== r) return;
      if (this.muted) return;
      if (this.state === "muted" || this.state === "starting") this.set("on");
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) this.o.onFinal(text);
        else interim += (interim ? " " : "") + text;
      }
      this.o.onInterim?.(interim);
    };
    r.onerror = (e) => {
      if (this.rec !== r) return;
      // "no-speech" and "aborted" are routine; the session ends and is reopened below.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.active = false;
        this.rec = null;
        this.set("denied");
      } else if (e.error === "audio-capture" || e.error === "network" || e.error === "language-not-supported") {
        // "network": the browser can't reach its speech service. Brave ships the API but blocks the service,
        // so every session fails this way; restarting would loop silently.
        this.lastError = e.error;
        this.active = false;
        this.rec = null;
        this.set("error");
      }
    };
    r.onend = () => {
      if (this.rec !== r) return;
      this.rec = null;
      // Chrome ends a session after silence or about a minute: keep listening.
      if (this.active) setTimeout(() => this.open(), 250);
    };
    try {
      r.start();
      if (this.state !== "muted") this.set(this.muted ? "muted" : "on");
    } catch {
      this.rec = null;
      if (this.active) setTimeout(() => this.open(), 1000);
    }
  }
}
