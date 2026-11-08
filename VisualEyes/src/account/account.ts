// The signed-in person's profile and preferences, kept by the hosted service in DynamoDB
// (voice-sidecar/voice_sidecar/users.py). Sign-in is Auth0's (auth0.ts): this file only ever sends Auth0's access token.

export interface Me {
  userId: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
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

  private async call<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.body) headers["Content-Type"] = "application/json";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.baseUrl().replace(/\/$/, "") + path, { ...init, headers, signal: ctl.signal });
    } catch {
      throw new AccountError("Could not reach the service. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    let body: { error?: string } & Record<string, unknown> = {};
    try {
      body = await resp.json();
    } catch {
      /* not JSON */
    }
    if (!resp.ok) {
      const msg = body.error ?? `The service answered with an error (${resp.status}).`;
      throw new AccountError(msg.charAt(0).toUpperCase() + msg.slice(1) + (msg.endsWith(".") ? "" : "."), resp.status);
    }
    return body as T;
  }

  async me(token: string): Promise<Me> {
    return (await this.call<{ user: Me }>("/v1/me", token)).user;
  }

  getPreferences(token: string): Promise<RemotePrefs> {
    return this.call("/v1/me/preferences", token);
  }

  putPreferences(token: string, preferences: SyncedPrefs, version?: number): Promise<RemotePrefs> {
    return this.call("/v1/me/preferences", token, { method: "PUT", body: JSON.stringify({ preferences, version }) });
  }
}

// ---------- "use without an account" ----------

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Set when someone chose "use without an account", so the sign-in screen does not nag on every start. */
const SKIP_KEY = "gazetype.session.skipped.v1";
export const skippedSignIn = (kv: KV): boolean => kv.getItem(SKIP_KEY) === "1";
export const setSkippedSignIn = (kv: KV, v: boolean): void => (v ? kv.setItem(SKIP_KEY, "1") : kv.removeItem(SKIP_KEY));

/**
 * Keeps preferences in step with the service. Pushes are debounced (typing in the settings form should not send a
 * request per key) and last-write-wins: one person rarely edits on two devices at once.
 */
export class PrefsSync {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: AccountApi,
    private readonly token: () => Promise<string | null>,
    private readonly collect: () => SyncedPrefs,
    private readonly onError: (e: AccountError) => void = () => {},
    private readonly delayMs = 1500,
    private readonly signedIn: () => boolean = () => true,
  ) {}

  /** On sign-in: returns what the service has, or pushes this device's preferences if the service has none yet. */
  async pull(): Promise<SyncedPrefs | null> {
    const t = await this.token();
    if (!t) return null;
    const remote = await this.api.getPreferences(t);
    if (remote.version > 0) return remote.preferences;
    await this.api.putPreferences(t, this.collect(), 0);
    return null;
  }

  schedule(): void {
    if (!this.signedIn()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.signedIn()) return;
    const t = await this.token();
    if (!t) return;
    try {
      await this.api.putPreferences(t, this.collect());
    } catch (e) {
      this.onError(e instanceof AccountError ? e : new AccountError(String(e)));
    }
  }
}
