import { describe, expect, it } from "vitest";
import { DEFAULT_CORS, hostPythonCandidates, localUv, parseEnvValue, serviceEnv, venvPython, withEnvFile } from "../scripts/voice-local";

describe("voice-local launcher", () => {
  it("reads the key from .env text the way hosted.sh does", () => {
    const get = (t: string) => parseEnvValue(t, "ELEVENLABS_API_KEY");
    expect(get("ELEVENLABS_API_KEY=sk_plain\n")).toBe("sk_plain");
    expect(get('ELEVENLABS_API_KEY="sk_double"')).toBe("sk_double");
    expect(get("ELEVENLABS_API_KEY='sk_single'")).toBe("sk_single");
    expect(get("export ELEVENLABS_API_KEY=sk_export")).toBe("sk_export");
    expect(get("  ELEVENLABS_API_KEY = sk_spaced   # my key")).toBe("sk_spaced");
    expect(get("# note\n\nOTHER=1\nELEVENLABS_API_KEY=sk_after_others")).toBe("sk_after_others");
    expect(get("ELEVENLABS_API_KEY=sk_first\nELEVENLABS_API_KEY=sk_second")).toBe("sk_first");
  });

  it("copes with Windows line endings from Notepad", () => {
    expect(parseEnvValue("ANTHROPIC_API_KEY=a\r\nELEVENLABS_API_KEY=sk_crlf\r\nOTHER=1\r\n", "ELEVENLABS_API_KEY")).toBe("sk_crlf");
  });

  it("treats empty and commented-out keys as not set", () => {
    for (const t of ["", "ELEVENLABS_API_KEY=\n", 'ELEVENLABS_API_KEY=""\n', "# ELEVENLABS_API_KEY=sk_commented\n", "OTHER=1\n"]) expect(parseEnvValue(t, "ELEVENLABS_API_KEY")).toBe("");
  });

  it("does not mistake another variable for the key", () => {
    expect(parseEnvValue("MY_ELEVENLABS_API_KEY=sk_nope\n", "ELEVENLABS_API_KEY")).toBe("");
  });

  it("finds Python inside the environment with the right layout per platform", () => {
    expect(venvPython("/s", "win32").replace(/\\/g, "/")).toBe("/s/.venv-hosted/Scripts/python.exe");
    expect(venvPython("/s", "darwin").replace(/\\/g, "/")).toBe("/s/.venv-hosted/bin/python");
    expect(localUv("/s", "win32").replace(/\\/g, "/")).toBe("/s/.tools/Scripts/uv.exe");
    expect(localUv("/s", "linux").replace(/\\/g, "/")).toBe("/s/.tools/bin/uv");
  });

  it("tries the py launcher first on Windows", () => {
    expect(hostPythonCandidates("win32")[0]).toEqual(["py", "-3"]);
    expect(hostPythonCandidates("darwin")[0]).toEqual(["python3"]);
  });

  it("uses safe local defaults but lets the caller override them", () => {
    const e = serviceEnv({ PATH: "/bin" }, "sk_x");
    expect(e).toMatchObject({ ELEVENLABS_API_KEY: "sk_x", VOICE_STORE: "memory", AUTH_MODE: "accounts", CORS_ORIGINS: DEFAULT_CORS });
    const o = serviceEnv({ VOICE_STORE: "dynamodb", AUTH_MODE: "jwt", CORS_ORIGINS: "http://x.test" }, "sk_x");
    expect(o).toMatchObject({ VOICE_STORE: "dynamodb", AUTH_MODE: "jwt", CORS_ORIGINS: "http://x.test" });
  });

  it("reads the DynamoDB settings from .env, but the real environment wins", () => {
    const text = "VOICE_STORE=dynamodb\nVOICE_TABLE_NAME=vocaleyes-voices\nAWS_REGION=us-east-1\n";
    expect(withEnvFile({}, text)).toMatchObject({ VOICE_STORE: "dynamodb", VOICE_TABLE_NAME: "vocaleyes-voices", AWS_REGION: "us-east-1" });
    expect(withEnvFile({ VOICE_STORE: "memory" }, text).VOICE_STORE).toBe("memory");
    expect(withEnvFile({}, "").VOICE_STORE).toBeUndefined();
  });
});
