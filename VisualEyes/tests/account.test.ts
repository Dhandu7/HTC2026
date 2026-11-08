import { describe, expect, it, vi } from "vitest";
import { AccountApi, AccountError, checkSignUp, PrefsSync, SessionStore, type Session } from "../src/account/account";
import { memoryKV } from "../src/profile/profiles";

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function fakeFetch(handler: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, init: init as Call["init"] };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { calls, f };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const USER = { userId: "u_1", email: "a@example.com", name: "A", createdAt: "" };
const session = (expiresAt: string): Session => ({ token: "tok", expiresAt, user: USER });

describe("AccountApi", () => {
  it("signs up with the password only in the body, never the url", async () => {
    const { calls, f } = fakeFetch(() => json(session("2099-01-01T00:00:00Z"), 201));
    const s = await new AccountApi(() => "http://127.0.0.1:8790/", f).signUp("a@example.com", "a long password", "A");
    expect(s.user.userId).toBe("u_1");
    expect(calls[0].url).toBe("http://127.0.0.1:8790/v1/auth/signup");
    expect(calls[0].url).not.toContain("password");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ email: "a@example.com", password: "a long password", name: "A" });
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it("sends the token for preferences", async () => {
    const { calls, f } = fakeFetch(() => json({ preferences: {}, version: 0, updatedAt: null }));
    await new AccountApi(() => "http://x", f).getPreferences("tok");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
  });

  it("turns server errors into readable messages with the status", async () => {
    const { f } = fakeFetch(() => json({ error: "email or password is wrong" }, 401));
    const err = await new AccountApi(() => "http://x", f).signIn("a@example.com", "nope").catch((e) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("Email or password is wrong.");
  });

  it("reports an unreachable service plainly", async () => {
    const f = (async () => {
      throw new TypeError("failed");
    }) as unknown as typeof fetch;
    await expect(new AccountApi(() => "http://x", f).signIn("a@b.co", "x")).rejects.toThrow(/Could not reach/);
  });
});

describe("SessionStore", () => {
  it("keeps a session until shortly before it expires", () => {
    let now = Date.parse("2026-11-07T12:00:00Z");
    const store = new SessionStore(memoryKV(), () => now);
    store.save(session("2026-11-08T12:00:00Z"));
    expect(store.get()?.token).toBe("tok");
    now = Date.parse("2026-11-08T11:59:30Z");
    expect(store.get()).toBeNull(); // under a minute left: treat as signed out
  });

  it("ignores garbage and clears on sign-out", () => {
    const kv = memoryKV();
    kv.setItem("gazetype.session.v1", "{not json");
    const store = new SessionStore(kv);
    expect(store.get()).toBeNull();
    store.save(session("2099-01-01T00:00:00Z"));
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("signing in forgets an earlier 'use without an account'", () => {
    const store = new SessionStore(memoryKV());
    store.setSkipped(true);
    expect(store.skipped()).toBe(true);
    store.save(session("2099-01-01T00:00:00Z"));
    expect(store.skipped()).toBe(false);
  });
});

describe("checkSignUp", () => {
  it("catches the common mistakes before a round trip", () => {
    expect(checkSignUp("nope", "a long password", "a long password")).toMatch(/email/);
    expect(checkSignUp("a@example.com", "short", "short")).toMatch(/at least 10/);
    expect(checkSignUp("a@example.com", "a long password", "a long passwerd")).toMatch(/match/);
    expect(checkSignUp("a@example.com", "a long password", "a long password")).toBeNull();
  });
});

describe("PrefsSync", () => {
  it("adopts the service's copy, or uploads this device's when the account has none", async () => {
    let remote = { preferences: {}, version: 0, updatedAt: null as string | null };
    const { calls, f } = fakeFetch((c) => {
      if (c.init.method === "PUT") {
        remote = { preferences: JSON.parse(c.init.body as string).preferences, version: remote.version + 1, updatedAt: "now" };
        return json(remote);
      }
      return json(remote);
    });
    const sync = new PrefsSync(new AccountApi(() => "http://x", f), () => "tok", () => ({ settings: { dwellMs: 900 } }));
    expect(await sync.pull()).toBeNull(); // new account: ours were uploaded
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ preferences: { settings: { dwellMs: 900 } }, version: 0 });
    expect(await sync.pull()).toEqual({ settings: { dwellMs: 900 } }); // now the service has them
  });

  it("debounces pushes and does nothing when signed out", async () => {
    vi.useFakeTimers();
    const { calls, f } = fakeFetch(() => json({ preferences: {}, version: 1, updatedAt: "" }));
    let token: string | null = "tok";
    const sync = new PrefsSync(new AccountApi(() => "http://x", f), () => token, () => ({}), undefined, 1000);
    sync.schedule();
    sync.schedule();
    sync.schedule();
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(1);
    token = null;
    sync.schedule();
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toHaveLength(1);
    vi.useRealTimers();
  });
});
