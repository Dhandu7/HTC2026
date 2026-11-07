// The logic behind the "My voice" screen, with no DOM so it can be tested: what phase the user is in, what they can
// do next, and what to tell them when something goes wrong.
//
// Phases: loading -> (unreachable | signed-out | none | ready | deleting). From `none`, create() goes through
// `creating` to `ready`. Consent is checked here before anything is uploaded, and again by the service.

import { HostedVoiceError, type ConsentText, type SkippedClip, type VoiceSettings, type VoiceStatus, type VoiceView, type HostedVoiceApi } from "./hostedApi";

export type Phase = "loading" | "unreachable" | "signed-out" | "none" | "creating" | "ready" | "deleting";

export interface State {
  phase: Phase;
  voice: VoiceView | null;
  consent: ConsentText | null;
  /** Something went wrong; plain language, safe to show. */
  error: string | null;
  /** Something worth knowing that is not an error. */
  notice: string | null;
  skipped: SkippedClip[];
  busy: boolean;
}

export interface CreateInput {
  mode: "self" | "authorized";
  authorizedBy: string;
  acknowledged: boolean;
  remoteProcessingAcknowledged: boolean;
}

export interface UploadFile {
  name: string;
  blob: Blob;
}

type Api = Pick<HostedVoiceApi, "consentText" | "getVoice" | "createVoice" | "updateVoice" | "deleteVoice">;

/** What to tell a person. Never shows technical detail, tokens, ids or request text. */
export function describe(e: unknown): string {
  if (!(e instanceof HostedVoiceError)) return "Something went wrong. Please try again.";
  switch (e.code) {
    case "network":
      return "Can't reach the voice service. Check that it is running and that the address is right, then try again.";
    case "timeout":
      return "The voice service took too long to answer. Try again in a moment.";
    case "auth":
      return "You are not signed in to the voice service.";
    case "locked":
      return "Your voice is paused. Resume it to use it.";
    case "rate_limited":
      return `That was too fast. Try again${e.retryAfterSec ? ` in ${e.retryAfterSec} seconds` : " shortly"}.`;
    case "upstream":
      // ElevenLabs saying no (key, permissions or plan) is a setup problem that retrying will not fix, so say so,
      // and pass on ElevenLabs' own explanation when it gave one.
      if (/refused the request/i.test(e.message)) {
        const why = /refused the request(?: \((.*)\))?\. Check the API key/.exec(e.message)?.[1];
        return why
          ? `ElevenLabs refused the request: ${why}. Check the key's permissions (it needs text to speech and voices) and the plan. Whoever runs the service can check with ./hosted.sh doctor.`
          : "ElevenLabs refused the request. This usually means the API key is missing or wrong, a restricted key lacks permission, or the plan does not allow voice cloning (it needs at least the Starter plan). Whoever runs the service can check with ./hosted.sh doctor.";
      }
      return "The voice provider (ElevenLabs) had a problem. Try again in a moment.";
    case "server":
      return "The voice service had a problem. Try again in a moment.";
    case "cancelled":
      return "Cancelled.";
    default:
      return e.message; // consent, clips, conflict, invalid, not_found: the service's own wording is already plain
  }
}

/** The router's reason for skipping your voice, in words for a person. */
export function friendlyReason(reason?: string): string {
  if (!reason) return "";
  if (/too slow/.test(reason)) return "your voice was too slow to answer";
  if (/not allowed/.test(reason)) return "your voice is switched off";
  const m = /failed:\s*(.*)$/.exec(reason);
  return m ? `your voice wasn't available (${m[1].replace(/[.\s]+$/, "")})` : reason;
}

const initial = (): State => ({ phase: "loading", voice: null, consent: null, error: null, notice: null, skipped: [], busy: false });

export class HostedVoiceController {
  state: State = initial();
  private subs = new Set<(s: State) => void>();
  /** Bumped on every refresh so a slow, older answer cannot overwrite a newer one. */
  private gen = 0;

  constructor(
    private readonly api: Api,
    /** Speak through the app's voice router, so a test sentence takes exactly the path real speech takes. */
    private readonly speakThroughRouter: (text: string) => Promise<{ tier: string | null; ttfaMs: number; fellBack: boolean; reason?: string }>,
  ) {}

  subscribe(fn: (s: State) => void): () => void {
    this.subs.add(fn);
    fn(this.state);
    return () => this.subs.delete(fn);
  }

  /** The voice's status, for the router's policy. null when there is no usable voice. */
  status(): VoiceStatus | null {
    return this.state.voice?.status ?? null;
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((f) => f(this.state));
  }

  /** Reload from the service. `keepMessages` is for a resync after a failure, which must not wipe the explanation. */
  async refresh(keepMessages = false): Promise<void> {
    const g = ++this.gen;
    this.set({ busy: true });
    try {
      const [voice, consent] = await Promise.all([this.api.getVoice(), this.state.consent ?? this.api.consentText().catch(() => null)]);
      if (g !== this.gen) return;
      const phase: Phase = !voice ? "none" : voice.status === "deleting" ? "deleting" : "ready";
      this.set({ voice, consent: consent ?? this.state.consent, phase, ...(keepMessages ? {} : { error: null, notice: null }), busy: false });
    } catch (e) {
      if (g !== this.gen) return;
      const signedOut = e instanceof HostedVoiceError && e.code === "auth";
      this.set({ phase: signedOut ? "signed-out" : "unreachable", voice: null, error: describe(e), ...(keepMessages ? {} : { notice: null }), busy: false });
    }
  }

  async create(input: CreateInput, files: UploadFile[]): Promise<boolean> {
    const consent = this.state.consent;
    const problem = !consent
      ? "The consent text could not be loaded. Try again."
      : !input.acknowledged
        ? "Please confirm that this is your own voice, or that the voice owner gave permission."
        : !input.remoteProcessingAcknowledged
          ? "Please confirm that your recordings and the text you speak are sent to ElevenLabs."
          : input.mode === "authorized" && !input.authorizedBy.trim()
            ? "Please enter the name of the voice owner who gave permission."
            : files.length === 0
              ? "Add at least one recording first."
              : null;
    if (problem) {
      this.set({ error: problem });
      return false;
    }
    this.set({ phase: "creating", error: null, notice: null, skipped: [], busy: true });
    try {
      const r = await this.api.createVoice(
        {
          mode: input.mode,
          ...(input.mode === "authorized" ? { authorizedBy: input.authorizedBy.trim() } : {}),
          acknowledged: true,
          remoteProcessingAcknowledged: true,
          consentVersion: consent!.version,
        },
        files,
      );
      this.set({ voice: r.voice, phase: "ready", skipped: r.skippedClips, notice: r.skippedClips.length ? "Your voice is ready. Some recordings could not be used." : "Your voice is ready.", busy: false });
      return true;
    } catch (e) {
      const skipped = e instanceof HostedVoiceError ? (e.skippedClips ?? []) : [];
      this.set({ phase: "none", voice: null, error: describe(e), skipped, busy: false });
      return false;
    }
  }

  async saveSettings(patch: Partial<VoiceSettings>): Promise<boolean> {
    return this.mutate(() => this.api.updateVoice({ settings: patch }), "Saved.");
  }

  async setPaused(paused: boolean): Promise<boolean> {
    return this.mutate(() => this.api.updateVoice({ paused }), paused ? "Voice paused. Speech uses the system voice." : "Voice resumed.");
  }

  private async mutate(run: () => Promise<VoiceView>, notice: string): Promise<boolean> {
    this.set({ busy: true, error: null, notice: null });
    try {
      this.set({ voice: await run(), notice, busy: false });
      return true;
    } catch (e) {
      this.set({ error: describe(e), busy: false });
      if (e instanceof HostedVoiceError && (e.code === "not_found" || e.code === "conflict")) void this.refresh(true);
      return false;
    }
  }

  /** Speak a sentence through the router and report which voice actually spoke. */
  async test(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return this.set({ error: "Type something to say." });
    this.set({ busy: true, error: null, notice: null });
    try {
      const r = await this.speakThroughRouter(t);
      const who = r.tier === "cloned" ? `your voice, ${r.ttfaMs} ms` : r.tier === "system" ? "the system voice" : "nothing";
      this.set({
        busy: false,
        notice: r.tier === "cloned" ? `Spoken in ${who}.` : `Spoken in ${who}${r.reason ? ` because ${friendlyReason(r.reason)}` : ""}.`,
      });
    } catch (e) {
      this.set({ busy: false, error: describe(e) });
    }
  }

  /** Delete the voice at ElevenLabs and here. If ElevenLabs cannot be reached it stays "deleting" and can be retried. */
  async remove(): Promise<boolean> {
    this.set({ phase: "deleting", busy: true, error: null, notice: null });
    try {
      await this.api.deleteVoice();
      this.set({ voice: null, phase: "none", notice: "Your voice was deleted.", busy: false });
      return true;
    } catch (e) {
      await this.refresh();
      this.set({ error: e instanceof HostedVoiceError && e.code === "upstream" ? "The voice could not be deleted at ElevenLabs yet. It is switched off and marked for deletion; try again in a moment." : describe(e), busy: false });
      return false;
    }
  }
}
