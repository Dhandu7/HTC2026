// Client for the hosted voice service (ElevenLabs behind our API; see voice-sidecar/README.md).
//
// Safety properties, each covered by tests/hosted-api.test.ts:
//  - The user is identified by the login (a bearer token, or a dev header on loopback only). The user id is never
//    sent in a body or query, and the app never sees or sends an ElevenLabs voice id or API key.
//  - Dev login (X-User-Id) is refused unless the service address is a loopback address.
//  - Request text is never logged.

export type VoiceStatus = "pending" | "active" | "paused" | "deleting";

export interface VoiceSettings {
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  useSpeakerBoost: boolean;
}

export interface ClipMeta {
  id: string;
  seconds: number;
  rmsDb: number;
  warnings: string[];
}

export interface VoiceView {
  status: VoiceStatus;
  settings: VoiceSettings;
  consent: { mode?: "self" | "authorized"; authorizedBy?: string; acknowledgedAt?: string; consentVersion?: string };
  clips: ClipMeta[];
  createdAt: string;
  updatedAt: string;
  /** ElevenLabs will not let this voice speak until its owner verifies it in the ElevenLabs dashboard. */
  needsVerification?: boolean;
  /** Present only while verification is needed: the name to look for in the ElevenLabs dashboard. */
  voiceName?: string;
}

export interface ConsentText {
  version: string;
  statements: string[];
}

export interface ConsentInput {
  mode: "self" | "authorized";
  authorizedBy?: string;
  acknowledged: boolean;
  remoteProcessingAcknowledged: boolean;
  consentVersion: string;
}

export interface SkippedClip {
  label: string;
  errors: string[];
}

export type ErrorCode =
  | "network"
  | "timeout"
  | "cancelled"
  | "auth"
  | "not_found"
  | "invalid"
  | "consent"
  | "clips"
  | "conflict"
  | "locked"
  | "rate_limited"
  | "upstream"
  | "server";

export class HostedVoiceError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly status = 0,
    readonly retryAfterSec?: number,
    readonly skippedClips?: SkippedClip[],
  ) {
    super(message);
    this.name = "HostedVoiceError";
  }
}

export type AuthStrategy =
  | { kind: "dev"; userId: string }
  | { kind: "bearer"; getToken: () => string | null | Promise<string | null> };

export interface ApiConfig {
  baseUrl: string;
  auth: AuthStrategy;
}

export const isLoopback = (url: string): boolean => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
};

const TIMEOUT_MS = { quick: 15_000, speak: 30_000, create: 180_000 };

function codeFor(status: number, body: { skippedClips?: unknown }): ErrorCode {
  if (status === 401) return "auth";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 422) return Array.isArray(body.skippedClips) ? "clips" : "consent";
  if (status === 409) return "conflict";
  if (status === 423) return "locked";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 504) return "upstream";
  return "server";
}

export class HostedVoiceApi {
  constructor(
    private readonly getConfig: () => ApiConfig,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async headers(cfg: ApiConfig): Promise<Record<string, string>> {
    const a = cfg.auth;
    if (a.kind === "dev") {
      if (!isLoopback(cfg.baseUrl)) throw new HostedVoiceError("Dev login is only allowed for a service on this computer.", "auth");
      return { "X-User-Id": a.userId };
    }
    const token = await a.getToken();
    if (!token) throw new HostedVoiceError("You are not signed in.", "auth", 401);
    return { Authorization: `Bearer ${token}` };
  }

  private async call(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal, needsAuth = true): Promise<Response> {
    const cancelled = () => new HostedVoiceError("Cancelled.", "cancelled");
    if (signal?.aborted) throw cancelled();
    const cfg = this.getConfig();
    const headers = { ...(needsAuth ? await this.headers(cfg) : {}), ...((init.headers as Record<string, string>) ?? {}) };
    // The caller may have cancelled while we were preparing the headers; an abort that already happened fires no event.
    if (signal?.aborted) throw cancelled();
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort);
    let resp: Response;
    try {
      resp = await this.fetchImpl(cfg.baseUrl.replace(/\/$/, "") + path, { ...init, headers, signal: ctl.signal });
    } catch {
      if (timedOut) throw new HostedVoiceError("The voice service took too long to answer.", "timeout");
      if (signal?.aborted) throw cancelled();
      throw new HostedVoiceError("Could not reach the voice service.", "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (resp.ok) return resp;
    let body: { error?: string; skippedClips?: SkippedClip[] } = {};
    try {
      body = await resp.json();
    } catch {
      /* not JSON */
    }
    const retry = Number(resp.headers.get("retry-after"));
    throw new HostedVoiceError(body.error || `The voice service answered with an error (${resp.status}).`, codeFor(resp.status, body), resp.status, Number.isFinite(retry) && retry > 0 ? retry : undefined, body.skippedClips);
  }

  async consentText(): Promise<ConsentText> {
    return (await this.call("/v1/consent-text", {}, TIMEOUT_MS.quick, undefined, false)).json();
  }

  /** The caller's voice, or null if they do not have one yet. */
  async getVoice(signal?: AbortSignal): Promise<VoiceView | null> {
    try {
      return (await (await this.call("/v1/me/voice", {}, TIMEOUT_MS.quick, signal)).json()).voice;
    } catch (e) {
      if (e instanceof HostedVoiceError && e.code === "not_found") return null;
      throw e;
    }
  }

  async createVoice(consent: ConsentInput, files: { name: string; blob: Blob }[]): Promise<{ voice: VoiceView; skippedClips: SkippedClip[] }> {
    const fd = new FormData();
    fd.append("consent", JSON.stringify(consent));
    for (const f of files) fd.append("files", f.blob, f.name);
    return (await this.call("/v1/me/voice", { method: "POST", body: fd }, TIMEOUT_MS.create)).json();
  }

  async updateVoice(patch: { settings?: Partial<VoiceSettings>; paused?: boolean }): Promise<VoiceView> {
    const r = await this.call("/v1/me/voice", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }, TIMEOUT_MS.quick);
    return (await r.json()).voice;
  }

  async speak(text: string, settings?: Partial<VoiceSettings>, signal?: AbortSignal): Promise<{ audio: ArrayBuffer; contentType: string; renderMs: number }> {
    const r = await this.call("/v1/me/voice/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, settings }) }, TIMEOUT_MS.speak, signal);
    return { audio: await r.arrayBuffer(), contentType: r.headers.get("content-type") ?? "audio/mpeg", renderMs: Number(r.headers.get("x-render-ms")) || 0 };
  }

  async deleteVoice(): Promise<void> {
    await this.call("/v1/me/voice", { method: "DELETE" }, TIMEOUT_MS.create);
  }
}
