import { describe, expect, it, vi } from "vitest";
import { AccountApi, AccountError, PrefsSync, setSkippedSignIn, skippedSignIn } from "../src/account/account";
import { auth0Config, canRedirect, returnUrl } from "../src/account/auth0";
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
const loc = (href: string) => new URL(href) as unknown as Location;

describe("auth0Config", () => {
  it("needs all three settings and tidies a pasted domain", () => {
    expect(auth0Config({})).toBeNull();
    expect(auth0Config({ VITE_AUTH0_DOMAIN: "t.us.auth0.com", VITE_AUTH0_CLIENT_ID: "abc" })).toBeNull();
    expect(auth0Config({ VITE_AUTH0_DOMAIN: " https://t.us.auth0.com/ ", VITE_AUTH0_CLIENT_ID: "abc", VITE_AUTH0_AUDIENCE: "https://api" })).toEqual({
      domain: "t.us.auth0.com",
      clientId: "abc",
      audience: "https://api",
    });
  });

  it("only redirects from a web page, back to the same page without its query", () => {
    expect(canRedirect(loc("http://localhost:5173/"))).toBe(true);
    expect(canRedirect(loc("file:///Applications/GazeType/index.html"))).toBe(false);
    expect(returnUrl(loc("https://34-196-250-93.sslip.io/?code=x&state=y"))).toBe("https://34-196-250-93.sslip.io/");
  });
});

describe("AccountApi", () => {
  it("sends Auth0's token and never a user id", async () => {
    const { calls, f } = fakeFetch(() => json({ user: { userId: "auth0|1", email: "a@example.com", name: "A", emailVerified: true } }));
    const me = await new AccountApi(() => "http://127.0.0.1:8790/", f).me("tok");
    expect(me.email).toBe("a@example.com");
    expect(calls[0].url).toBe("http://127.0.0.1:8790/v1/me");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
    expect(calls[0].init.headers["X-User-Id"]).toBeUndefined();
  });

  it("turns server errors into readable messages with the status", async () => {
    const { f } = fakeFetch(() => json({ error: "invalid or expired token" }, 401));
    const err = await new AccountApi(() => "http://x", f).getPreferences("tok").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect((err as AccountError).status).toBe(401);
    expect((err as AccountError).message).toBe("Invalid or expired token.");
  });

  it("reports an unreachable service plainly", async () => {
    const f = (async () => {
      throw new TypeError("failed");
    }) as unknown as typeof fetch;
    await expect(new AccountApi(() => "http://x", f).me("t")).rejects.toThrow(/Could not reach/);
  });
});

describe("use without an account", () => {
  it("is remembered until cleared", () => {
    const kv = memoryKV();
    expect(skippedSignIn(kv)).toBe(false);
    setSkippedSignIn(kv, true);
    expect(skippedSignIn(kv)).toBe(true);
    setSkippedSignIn(kv, false);
    expect(skippedSignIn(kv)).toBe(false);
  });
});

describe("PrefsSync", () => {
  it("adopts the service's copy, or uploads this device's when the account has none", async () => {
    let remote = { preferences: {}, version: 0, updatedAt: null as string | null };
    const { calls, f } = fakeFetch((c) => {
      if (c.init.method === "PUT") remote = { preferences: JSON.parse(c.init.body as string).preferences, version: remote.version + 1, updatedAt: "now" };
      return json(remote);
    });
    const sync = new PrefsSync(new AccountApi(() => "http://x", f), async () => "tok", () => ({ settings: { dwellMs: 900 } }));
    expect(await sync.pull()).toBeNull(); // new account: ours were uploaded
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ preferences: { settings: { dwellMs: 900 } }, version: 0 });
    expect(await sync.pull()).toEqual({ settings: { dwellMs: 900 } });
  });

  it("debounces pushes and does nothing when signed out", async () => {
    vi.useFakeTimers();
    const { calls, f } = fakeFetch(() => json({ preferences: {}, version: 1, updatedAt: "" }));
    let signedIn = true;
    const sync = new PrefsSync(new AccountApi(() => "http://x", f), async () => "tok", () => ({}), undefined, 1000, () => signedIn);
    sync.schedule();
    sync.schedule();
    sync.schedule();
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(1);
    signedIn = false;
    sync.schedule();
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toHaveLength(1);
    vi.useRealTimers();
  });

  it("reports a failed push", async () => {
    const { f } = fakeFetch(() => json({ error: "invalid or expired token" }, 401));
    const errors: number[] = [];
    await new PrefsSync(new AccountApi(() => "http://x", f), async () => "tok", () => ({}), (e) => errors.push(e.status)).flush();
    expect(errors).toEqual([401]);
  });
});
