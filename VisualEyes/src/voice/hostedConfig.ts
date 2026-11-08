// Where the hosted voice service is and who is calling it. Stored in the browser; no secrets in here.
//
// Sign-in is not built yet. Until it is, the app uses a development login (a made-up user id sent as X-User-Id),
// which the service only accepts on a loopback address. When a login provider is chosen, call setTokenProvider()
// with a function that returns the current access token and the app switches to bearer tokens automatically.

import type { ApiConfig, AuthStrategy } from "./hostedApi";

export interface VoiceApiSettings {
  baseUrl: string;
  devUserId: string;
}

const KEY = "gazetype.voiceApi.v1";
const DEFAULT_URL = (import.meta as unknown as { env?: { VITE_VOICE_API_URL?: string } }).env?.VITE_VOICE_API_URL ?? "http://127.0.0.1:8790";

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function loadVoiceApiSettings(store: KV): VoiceApiSettings {
  let saved: Partial<VoiceApiSettings> = {};
  try {
    saved = JSON.parse(store.getItem(KEY) ?? "{}");
  } catch {
    /* ignore */
  }
  const s: VoiceApiSettings = {
    baseUrl: typeof saved.baseUrl === "string" && saved.baseUrl ? saved.baseUrl : DEFAULT_URL,
    devUserId: typeof saved.devUserId === "string" && /^[A-Za-z0-9_.@:-]{1,128}$/.test(saved.devUserId) ? saved.devUserId : `dev-${Math.random().toString(16).slice(2, 10)}`,
  };
  try {
    store.setItem(KEY, JSON.stringify(s)); // persist the generated dev user id so the same person keeps the same voice
  } catch {
    /* storage may be unavailable */
  }
  return s;
}

export function saveVoiceApiSettings(store: KV, s: VoiceApiSettings): void {
  try {
    store.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

let tokenProvider: (() => string | null | Promise<string | null>) | null = null;
export function setTokenProvider(fn: (() => string | null | Promise<string | null>) | null): void {
  tokenProvider = fn;
}

export function authFor(s: VoiceApiSettings): AuthStrategy {
  return tokenProvider ? { kind: "bearer", getToken: tokenProvider } : { kind: "dev", userId: s.devUserId };
}

export const usingDevLogin = (): boolean => tokenProvider === null;

export const apiConfigFrom = (get: () => VoiceApiSettings): (() => ApiConfig) => () => {
  const s = get();
  return { baseUrl: s.baseUrl, auth: authFor(s) };
};
