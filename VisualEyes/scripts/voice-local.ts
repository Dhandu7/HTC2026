// Starts the voice service on this machine: `npm run voice` (or `npm run dev:voice` with the app).
//
// macOS and Linux run voice-sidecar/hosted.sh, which is the tested path. Windows cannot run that bash script
// (different folder layout: Scripts\ and python.exe), so it gets the same steps done here:
//   1. first run: make a Python 3.12 environment with uv and install the requirements
//   2. read ELEVENLABS_API_KEY from VisualEyes/.env
//   3. serve on 127.0.0.1:8790, in memory, with accounts (sign-in) plus the dev test login (this machine only)
// The key is read as text, never run as a script, never printed.
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_CORS = "http://localhost:5173,http://127.0.0.1:5173";

/** The value of `name` in .env text, read the way hosted.sh reads it: first matching line, optional `export`,
 *  trailing ` # comment` and matching quotes removed. Empty means not set. */
export function parseEnvValue(text: string, name: string): string {
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`);
  for (const raw of text.split("\n")) {
    const m = re.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    let v = m[1].replace(/\s+#.*$/, "").replace(/\s+$/, "");
    const q = /^(["'])(.*)\1$/.exec(v);
    if (q) v = q[2];
    return v;
  }
  return "";
}

const isWin = (platform: string) => platform === "win32";
const binDir = (platform: string) => (isWin(platform) ? "Scripts" : "bin");
const exe = (name: string, platform: string) => (isWin(platform) ? `${name}.exe` : name);

/** Where the service's Python lives inside its environment. */
export const venvPython = (sidecar: string, platform: string) => join(sidecar, ".venv-hosted", binDir(platform), exe("python", platform));
/** Where uv lives when we install it ourselves. */
export const localUv = (sidecar: string, platform: string) => join(sidecar, ".tools", binDir(platform), exe("uv", platform));
const localPip = (sidecar: string, platform: string) => join(sidecar, ".tools", binDir(platform), exe("pip", platform));

/** The ways a Python 3 may be called, most specific first. On Windows the `py` launcher is the reliable one. */
export function hostPythonCandidates(platform: string): string[][] {
  return isWin(platform) ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
}

/** Environment for the service: the caller's own settings win over these local-development defaults. */
export function serviceEnv(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  return {
    ...env,
    ELEVENLABS_API_KEY: key,
    VOICE_STORE: env.VOICE_STORE || "memory",
    AUTH_MODE: env.AUTH_MODE || "accounts", // sign-in works; on 127.0.0.1 the dev test login still does too
    CORS_ORIGINS: env.CORS_ORIGINS || DEFAULT_CORS,
  };
}

/** Non-secret settings that may come from VisualEyes/.env (as hosted.sh reads them); the real environment wins. */
export const ENV_FILE_SETTINGS = ["VOICE_STORE", "VOICE_TABLE_NAME", "AWS_REGION", "ACCOUNTS_SIGNING_KEY_SECRET_ID"] as const;
export function withEnvFile(env: NodeJS.ProcessEnv, envText: string): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ENV_FILE_SETTINGS) if (!out[k]) out[k] = parseEnvValue(envText, k) || undefined;
  return out;
}

export const MISSING_KEY =
  "No ElevenLabs key found. Copy VisualEyes/.env.example to VisualEyes/.env and put your key after ELEVENLABS_API_KEY= (it starts with sk_), then run this again.";

function run(cmd: string, args: string[], cwd: string): SpawnSyncReturns<Buffer> {
  return spawnSync(cmd, args, { cwd, stdio: "inherit" });
}

function works(cmd: string[], probe: string[]): boolean {
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...probe], { stdio: "ignore" });
  return r.status === 0;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Windows first run: Python 3.12 environment through uv. Exits with an explanation when a step fails. */
function setupWindows(sidecar: string, platform: string): void {
  let uv: string[] | null = works(["uv"], ["--version"]) ? ["uv"] : null;
  if (!uv) {
    const host = hostPythonCandidates(platform).find((c) => works(c, ["--version"]));
    if (!host) fail("Python 3 was not found. Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), open a new terminal, and run this again.");
    if (!existsSync(localUv(sidecar, platform))) {
      if (run(host[0], [...host.slice(1), "-m", "venv", ".tools"], sidecar).status !== 0) fail("Could not create a Python virtual environment. Reinstall Python from python.org with the standard options (pip and venv included).");
      if (run(localPip(sidecar, platform), ["install", "--quiet", "uv"], sidecar).status !== 0) fail("Could not install uv with pip (no internet, or a proxy?). Install uv yourself (https://docs.astral.sh/uv/) and run this again.");
    }
    uv = [localUv(sidecar, platform)];
  }
  const py = venvPython(sidecar, platform);
  // The service is tested on Python 3.12, so uv fetches that exact version whatever Python 3 is installed.
  if (!existsSync(join(sidecar, ".venv-hosted")) && run(uv[0], [...uv.slice(1), "venv", "--python", "3.12", ".venv-hosted"], sidecar).status !== 0)
    fail("Could not create the Python 3.12 environment. uv downloads Python 3.12 the first time, so it needs internet access.");
  if (run(uv[0], [...uv.slice(1), "pip", "install", "--python", py, "-r", "requirements.txt"], sidecar).status !== 0) fail("Installing the requirements failed (see above). Delete voice-sidecar\\.venv-hosted and run this again.");
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const poc = resolve(here, "..");
  const sidecar = join(poc, "voice-sidecar");
  const platform = process.platform;

  if (!isWin(platform)) {
    const r = spawnSync("bash", [join(sidecar, "hosted.sh"), "local", ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  const py = venvPython(sidecar, platform);
  if (!existsSync(py)) setupWindows(sidecar, platform);
  if (!existsSync(py)) fail("Setup finished but the Python environment is missing. Delete voice-sidecar\\.venv-hosted and run this again.");

  let key = process.env.ELEVENLABS_API_KEY ?? "";
  if (!key && !process.env.ELEVENLABS_SECRET_ID) {
    const envFile = join(poc, ".env");
    if (existsSync(envFile)) key = parseEnvValue(readFileSync(envFile, "utf8"), "ELEVENLABS_API_KEY");
    if (!key) fail(MISSING_KEY);
  }
  if (key && !key.startsWith("sk_")) console.error("warning: the key does not start with sk_. ElevenLabs API keys do, so this may be the key's ID, not the key. Create or rotate a key and copy the one that starts with sk_.");

  const envFile = join(poc, ".env");
  const envText = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const env = serviceEnv(withEnvFile(process.env, envText), key);
  console.log(env.VOICE_STORE === "dynamodb" ? `Voice service for this machine only, saving to DynamoDB table ${env.VOICE_TABLE_NAME}.` : "Voice service for this machine only: accounts and voices are kept in memory, so they are forgotten when this stops.");
  const child = spawn(py, ["-m", "voice_sidecar.hosted_main", "serve"], { cwd: sidecar, env, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
