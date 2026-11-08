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
/** The deployed site only lets signed-in people use AI suggestions (it spends API credit), so calls carry the sign-in token. */
let getToken: (() => Promise<string | null>) | null = null;
export function setLlmToken(fn: (() => Promise<string | null>) | null) {
  getToken = fn;
}
async function headers(json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = json ? { "Content-Type": "application/json" } : {};
  const t = getToken ? await getToken().catch(() => null) : null;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** Why the LLM is or isn't available, for the start screen. */
export interface LlmStatus {
  on: boolean;
  /** "no-server": proxy not running. "no-key": running without ANTHROPIC_API_KEY. "sign-in": the site needs a sign-in first. */
  reason?: "no-server" | "no-key" | "sign-in";
  fastModel?: string;
  /** The server can speak in the user's cloned voice (ElevenLabs). */
  voice?: boolean;
}
let status: LlmStatus = { on: false, reason: "no-server" };
export const llmStatus = () => status;

/** Live sentence suggestions must be quick or they're useless; expansion is a panel the user waits on. Replies to
 * what the partner said arrive while they wait for an answer, so they get a little longer than a chip. */
const TIMEOUT_MS = { continue: 2500, expand: 6000, reply: 4000 } as const;
const CACHE_MAX = 100;
const cache = new Map<string, string[]>();

export function setLlmProfile(p: LlmProfile | undefined) {
  profile = p;
  cache.clear();
}

export async function llmAvailable(refresh = false): Promise<boolean> {
  if (available !== null && !refresh) return available;
  try {
    const r = await fetch(`${base()}/api/health`, { headers: await headers(), signal: AbortSignal.timeout(1500) });
    if (r.status === 401) {
      available = false;
      status = { on: false, reason: "sign-in" };
      return available;
    }
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
  task: "continue" | "expand" | "reply";
  text?: string;
  slots?: string[];
  history?: string[];
  n?: number;
  /** For "reply": what the conversation partner just said. */
  heard?: string;
  /** For "reply": the turns before that, oldest first. */
  transcript?: { who: "them" | "me"; text: string }[];
}

export async function llmPredict(body: LlmRequest, signal?: AbortSignal): Promise<string[]> {
  if (!(await llmAvailable())) return [];
  // Cache by what was typed (not history), so deleting back to an earlier point is instant.
  const key = JSON.stringify([profile?.id, body.task, body.text, body.slots, body.n, body.heard]);
  const hit = cache.get(key);
  if (hit) return hit;
  const timeout = AbortSignal.timeout(TIMEOUT_MS[body.task]);
  try {
    const r = await fetch(`${base()}/api/predict`, {
      method: "POST",
      headers: await headers(true),
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
    headers: await headers(true),
    body: JSON.stringify({ task: "continue", text: "I", n: 1, profile: profile && { ...profile, id: undefined } }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}
