import { describe, expect, it } from "vitest";
import { HostedVoiceApi, HostedVoiceError, isLoopback, type ApiConfig } from "../src/voice/hostedApi";
import { apiConfigFrom, loadVoiceApiSettings, setTokenProvider, usingDevLogin } from "../src/voice/hostedConfig";

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, init: init as Call["init"] };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { calls, f };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const dev = (userId = "alice", baseUrl = "http://127.0.0.1:8790"): (() => ApiConfig) => () => ({ baseUrl, auth: { kind: "dev", userId } });
const VOICE = { status: "active", settings: {}, consent: {}, clips: [], createdAt: "", updatedAt: "" };

describe("authentication", () => {
  it("dev login sends only the X-User-Id header, and never puts the user id in the url or body", async () => {
    const { calls, f } = fakeFetch(() => json({ voice: VOICE }));
    const api = new HostedVoiceApi(dev("alice"), f);
    await api.getVoice();
    await api.updateVoice({ paused: true });
    await api.speak("hi");
    for (const c of calls) {
      expect(c.init.headers["X-User-Id"]).toBe("alice");
      expect(c.url).not.toContain("alice");
      expect(String(c.init.body ?? "")).not.toContain("alice");
    }
  });

  it("bearer login sends the token, and a missing token never reaches the network", async () => {
    const { calls, f } = fakeFetch(() => json({ voice: VOICE }));
    let token: string | null = "tok123";
    const api = new HostedVoiceApi(() => ({ baseUrl: "https://voice.example.com", auth: { kind: "bearer", getToken: () => token } }), f);
    await api.getVoice();
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok123");
    token = null;
    await expect(api.getVoice()).rejects.toMatchObject({ code: "auth" });
    expect(calls).toHaveLength(1);
  });

  it("refuses dev login against a service that is not on this computer", async () => {
    const { calls, f } = fakeFetch(() => json({ voice: VOICE }));
    const api = new HostedVoiceApi(dev("alice", "https://voice.example.com"), f);
    await expect(api.getVoice()).rejects.toMatchObject({ code: "auth" });
    expect(calls).toHaveLength(0);
    expect(["http://localhost:1", "http://127.0.0.1:8790", "http://[::1]:8790"].every(isLoopback)).toBe(true);
    expect(["https://voice.example.com", "http://127.0.0.1.evil.com", "nonsense"].some(isLoopback)).toBe(false);
  });

  it("the consent text needs no login", async () => {
    const { calls, f } = fakeFetch(() => json({ version: "v1", statements: ["a"] }));
    await new HostedVoiceApi(dev(), f).consentText();
    expect(calls[0].init.headers["X-User-Id"]).toBeUndefined();
  });
});

describe("requests", () => {
  it("getVoice returns null when the user has no voice yet", async () => {
    const { f } = fakeFetch(() => json({ error: "you do not have a voice yet" }, 404));
    expect(await new HostedVoiceApi(dev(), f).getVoice()).toBeNull();
  });

  it("createVoice sends the consent as JSON and the clips as files, as multipart", async () => {
    const { calls, f } = fakeFetch(() => json({ voice: VOICE, skippedClips: [] }, 201));
    const consent = { mode: "self" as const, acknowledged: true, remoteProcessingAcknowledged: true, consentVersion: "v1" };
    await new HostedVoiceApi(dev(), f).createVoice(consent, [{ name: "a.webm", blob: new Blob(["x"], { type: "audio/webm" }) }, { name: "b.wav", blob: new Blob(["y"]) }]);
    const c = calls[0];
    expect(c.url).toBe("http://127.0.0.1:8790/v1/me/voice");
    expect(c.init.method).toBe("POST");
    expect(c.init.headers["Content-Type"]).toBeUndefined(); // the browser must set the multipart boundary itself
    const fd = c.init.body as FormData;
    expect(JSON.parse(fd.get("consent") as string)).toEqual(consent);
    expect(fd.getAll("files").map((x) => (x as File).name)).toEqual(["a.webm", "b.wav"]);
  });

  it("speak posts text as JSON and returns the audio and render time", async () => {
    const { calls, f } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg", "x-render-ms": "123" } }));
    const r = await new HostedVoiceApi(dev(), f).speak("Hello there.");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ text: "Hello there." });
    expect(r.renderMs).toBe(123);
    expect(r.contentType).toBe("audio/mpeg");
    expect(new Uint8Array(r.audio)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("strips a trailing slash from the service address", async () => {
    const { calls, f } = fakeFetch(() => json({ voice: VOICE }));
    await new HostedVoiceApi(() => ({ baseUrl: "http://localhost:8790/", auth: { kind: "dev", userId: "a" } }), f).getVoice();
    expect(calls[0].url).toBe("http://localhost:8790/v1/me/voice");
  });
});

describe("errors", () => {
  const status = async (s: number, body: unknown = { error: "x" }, headers = {}): Promise<HostedVoiceError> => {
    const { f } = fakeFetch(() => json(body, s, headers));
    try {
      await new HostedVoiceApi(dev(), f).updateVoice({ paused: true });
    } catch (e) {
      return e as HostedVoiceError;
    }
    throw new Error("expected the call to fail");
  };

  it.each([
    [401, "auth"],
    [400, "invalid"],
    [409, "conflict"],
    [423, "locked"],
    [429, "rate_limited"],
    [502, "upstream"],
    [504, "upstream"],
    [500, "server"],
  ])("HTTP %i becomes %s", async (s, code) => {
    const e = await status(s as number);
    expect(e).toBeInstanceOf(HostedVoiceError);
    expect(e.code).toBe(code);
    expect(e.status).toBe(s);
  });

  it("a 422 with skipped clips is a clips problem, otherwise a consent problem, and keeps the service's wording", async () => {
    const clips = await status(422, { error: "need at least 10 seconds", skippedClips: [{ label: "a", errors: ["too quiet"] }] });
    expect(clips.code).toBe("clips");
    expect(clips.skippedClips).toEqual([{ label: "a", errors: ["too quiet"] }]);
    const consent = await status(422, { error: "you must confirm" });
    expect(consent.code).toBe("consent");
    expect(consent.message).toBe("you must confirm");
  });

  it("passes Retry-After through and survives a non-JSON error page", async () => {
    expect((await status(429, {}, { "retry-after": "7" })).retryAfterSec).toBe(7);
    const { f } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const e = await new HostedVoiceApi(dev(), f).deleteVoice().catch((x) => x);
    expect(e.code).toBe("upstream");
    expect(e.message).not.toContain("<html>");
  });

  it("a network failure, a timeout and a cancel are told apart", async () => {
    const net = new HostedVoiceApi(dev(), (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch);
    await expect(net.getVoice()).rejects.toMatchObject({ code: "network" });

    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const ctl = new AbortController();
    const p = new HostedVoiceApi(dev(), hang).speak("hi", undefined, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
  });

  it("never puts request text into an error message", async () => {
    const { f } = fakeFetch(() => json({ error: "the voice service had a problem" }, 502));
    const e = await new HostedVoiceApi(dev(), f).speak("my private sentence about my health").catch((x) => x);
    expect(e.message).not.toContain("private");
  });
});

describe("configuration", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it("generates a dev user once and keeps it, so the same person keeps the same voice", () => {
    const store = mem();
    const a = loadVoiceApiSettings(store);
    const b = loadVoiceApiSettings(store);
    expect(a.devUserId).toMatch(/^dev-[0-9a-f]+$/);
    expect(b.devUserId).toBe(a.devUserId);
    expect(a.baseUrl).toBe("http://127.0.0.1:8790");
  });

  it("ignores a stored user id that is not a safe value", () => {
    const store = mem();
    store.setItem("gazetype.voiceApi.v1", JSON.stringify({ baseUrl: "http://localhost:9", devUserId: "../etc" }));
    const s = loadVoiceApiSettings(store);
    expect(s.baseUrl).toBe("http://localhost:9");
    expect(s.devUserId).toMatch(/^dev-/);
  });

  it("switches to bearer tokens as soon as a token provider is set", () => {
    const s = loadVoiceApiSettings(mem());
    expect(usingDevLogin()).toBe(true);
    expect(apiConfigFrom(() => s)().auth.kind).toBe("dev");
    setTokenProvider(() => "t");
    expect(usingDevLogin()).toBe(false);
    expect(apiConfigFrom(() => s)().auth.kind).toBe("bearer");
    setTokenProvider(null);
  });
});
