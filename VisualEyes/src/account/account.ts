// Accounts: sign up, sign in, and the signed-in person's preferences, kept by the hosted service in DynamoDB
// (voice-sidecar/voice_sidecar/accounts.py). The password goes to the service once over HTTPS and is never stored
// here; the service keeps only an argon2id hash. What we keep on this device is the signed token, until it expires
// or the person signs out.

export interface AccountUser {
  userId: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Session {
  token: string;
  /** ISO time the token stops working. */
  expiresAt: string;
  user: AccountUser;
}

export interface RemotePrefs {
  preferences: SyncedPrefs;
  version: number;
  updatedAt: string | null;
}

/** What follows a person between devices. Calibration and learned words stay on the device (they are per-machine or large). */
export interface SyncedPrefs {
  settings?: Record<string, unknown>;
  profile?: { name?: string; about?: string; people?: string[]; samples?: string[] };
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

const TIMEOUT_MS = 15_000;

export class AccountApi {
  constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
    const { token, ...rest } = init;
    const headers: Record<string, string> = { ...((rest.headers as Record<string, string>) ?? {}) };
    if (rest.body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.baseUrl().replace(/\/$/, "") + path, { ...rest, headers, signal: ctl.signal });
    } catch {
      throw new AccountError("Could not reach the account service. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    let body: { error?: string; detail?: unknown } & Record<string, unknown> = {};
    try {
      body = await resp.json();
    } catch {
      /* not JSON */
    }
    if (!resp.ok) {
      const msg = body.error ?? (resp.status === 422 ? "Fill in every field." : `The account service answered with an error (${resp.status}).`);
      throw new AccountError(msg.charAt(0).toUpperCase() + msg.slice(1) + (msg.endsWith(".") ? "" : "."), resp.status);
    }
    return body as T;
  }

  signUp(email: string, password: string, name: string): Promise<Session> {
    return this.call("/v1/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name }) });
  }

  signIn(email: string, password: string): Promise<Session> {
    return this.call("/v1/auth/signin", { method: "POST", body: JSON.stringify({ email, password }) });
  }

  getPreferences(token: string): Promise<RemotePrefs> {
    return this.call("/v1/me/preferences", { token });
  }

  putPreferences(token: string, preferences: SyncedPrefs, version?: number): Promise<RemotePrefs> {
    return this.call("/v1/me/preferences", { method: "PUT", token, body: JSON.stringify({ preferences, version }) });
  }
}

// ---------- the session on this device ----------

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const SESSION_KEY = "gazetype.session.v1";
/** Set when someone chose "use without an account", so the sign-in screen does not nag on every start. */
const SKIP_KEY = "gazetype.session.skipped.v1";

export class SessionStore {
  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  /** The current session, or null if there is none or it has expired. */
  get(): Session | null {
    try {
      const s = JSON.parse(this.kv.getItem(SESSION_KEY) ?? "null") as Session | null;
      if (!s?.token || !s.user?.userId || !(Date.parse(s.expiresAt) > this.now() + 60_000)) return null;
      return s;
    } catch {
      return null;
    }
  }

  save(s: Session): void {
    this.kv.setItem(SESSION_KEY, JSON.stringify(s));
    this.kv.removeItem(SKIP_KEY);
  }

  clear(): void {
    this.kv.removeItem(SESSION_KEY);
  }

  skipped(): boolean {
    return this.kv.getItem(SKIP_KEY) === "1";
  }

  setSkipped(v: boolean): void {
    if (v) this.kv.setItem(SKIP_KEY, "1");
    else this.kv.removeItem(SKIP_KEY);
  }
}

// ---------- form checks (the server checks again; these just give a quick, friendly answer) ----------

export const MIN_PASSWORD = 10;

export function checkSignUp(email: string, password: string, confirm: string): string | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim())) return "Enter a valid email address.";
  if (password.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}

/**
 * Keeps preferences in step with the service. Pushes are debounced (typing in the settings form should not send a
 * request per key) and last-write-wins: one person rarely edits on two devices at once.
 */
export class PrefsSync {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: AccountApi,
    private readonly token: () => string | null,
    private readonly collect: () => SyncedPrefs,
    private readonly onError: (e: AccountError) => void = () => {},
    private readonly delayMs = 1500,
  ) {}

  /** On sign-in: returns what the service has, or pushes this device's preferences if the service has none yet. */
  async pull(): Promise<SyncedPrefs | null> {
    const t = this.token();
    if (!t) return null;
    const remote = await this.api.getPreferences(t);
    if (remote.version > 0) return remote.preferences;
    await this.api.putPreferences(t, this.collect(), 0);
    return null;
  }

  schedule(): void {
    if (!this.token()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const t = this.token();
    if (!t) return;
    try {
      await this.api.putPreferences(t, this.collect());
    } catch (e) {
      this.onError(e instanceof AccountError ? e : new AccountError(String(e)));
    }
  }
}
