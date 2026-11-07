// Client for the optional LLM proxy (server/llm.ts). Every call has a hard
// timeout and can be cancelled, so a slow network can never stall typing —
// local predictions always show first.

const base = () => ((window as unknown as { gazetype?: unknown }).gazetype ? "http://localhost:8787" : "");

/** The active user's profile, sent so suggestions sound like them. Text only. */
export interface LlmProfile {
  id: string;
  name: string;
  about: string;
  people: string[];
  samples: string[];
}

let available: boolean | null = null;
let profile: LlmProfile | undefined;

/** Why the LLM is or isn't available, for the start screen. */
export interface LlmStatus {
  on: boolean;
  /** "no-server": proxy not running. "no-key": running without ANTHROPIC_API_KEY. */
  reason?: "no-server" | "no-key";
  fastModel?: string;
  /** The server can speak in the user's cloned voice (ElevenLabs). */
  voice?: boolean;
}
let status: LlmStatus = { on: false, reason: "no-server" };
export const llmStatus = () => status;

/** Live sentence suggestions must be quick or they're useless; expansion is a panel the user waits on. */
const TIMEOUT_MS = { continue: 2500, expand: 6000 } as const;
const CACHE_MAX = 100;
const cache = new Map<string, string[]>();

export function setLlmProfile(p: LlmProfile | undefined) {
  profile = p;
  cache.clear();
}

export async function llmAvailable(refresh = false): Promise<boolean> {
  if (available !== null && !refresh) return available;
  try {
    const r = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(1500) });
    const h = r.ok ? await r.json() : {};
    // Older servers don't report keySet; treat missing as set.
    available = !!h.ok && h.keySet !== false;
    status = available
      ? { on: true, fastModel: h.fastModel, voice: !!h.voice }
      : { on: false, reason: h.ok ? "no-key" : "no-server", voice: !!h.voice };
  } catch {
    available = false;
    status = { on: false, reason: "no-server" };
  }
  return available;
}

export interface LlmRequest {
  task: "continue" | "expand";
  text?: string;
  slots?: string[];
  history?: string[];
  n?: number;
}

export async function llmPredict(body: LlmRequest, signal?: AbortSignal): Promise<string[]> {
  if (!(await llmAvailable())) return [];
  // Cache by what was typed (not history), so deleting back to an earlier point is instant.
  const key = JSON.stringify([profile?.id, body.task, body.text, body.slots, body.n]);
  const hit = cache.get(key);
  if (hit) return hit;
  const timeout = AbortSignal.timeout(TIMEOUT_MS[body.task]);
  try {
    const r = await fetch(`${base()}/api/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, profile: profile && { ...profile, id: undefined } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!r.ok) return [];
    const out: string[] = (await r.json()).suggestions ?? [];
    if (out.length) {
      cache.set(key, out);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    return out;
  } catch {
    return []; // aborted, timed out, or offline
  }
}

/** Send one tiny request so the server has the profile prompt cached before the first real sentence. */
export async function llmWarm(): Promise<void> {
  if (!(await llmAvailable())) return;
  void fetch(`${base()}/api/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "continue", text: "I", n: 1, profile: profile && { ...profile, id: undefined } }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}
