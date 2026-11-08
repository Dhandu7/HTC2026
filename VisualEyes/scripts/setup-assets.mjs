// Copies MediaPipe WASM into public/ and downloads model files so the app runs fully offline.
//   node scripts/setup-assets.mjs            -> wasm + face landmarker model
//   node scripts/setup-assets.mjs --voice    -> also the offline Vosk voice-command model (~40 MB)
//   node scripts/setup-assets.mjs --wasm-only (postinstall; never fails the install)
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const wasmOnly = args.has("--wasm-only");

const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const VOSK_MODEL_URL =
  "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz";

async function copyWasm() {
  const src = join(root, "node_modules/@mediapipe/tasks-vision/wasm");
  if (!existsSync(src)) {
    console.warn("[setup] @mediapipe/tasks-vision not installed yet; skipping wasm copy");
    return;
  }
  const dest = join(root, "public/mediapipe/wasm");
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log("[setup] copied MediaPipe wasm -> public/mediapipe/wasm");
}

async function download(url, dest) {
  if (existsSync(dest) && (await stat(dest)).size > 0) {
    console.log(`[setup] ${dest.replace(root + "/", "")} already present`);
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  console.log(`[setup] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`[setup] saved ${dest.replace(root + "/", "")}`);
}

try {
  await copyWasm();
  if (!wasmOnly) {
    await download(FACE_MODEL_URL, join(root, "public/models/face_landmarker.task"));
    if (args.has("--voice")) {
      await download(VOSK_MODEL_URL, join(root, "public/models/vosk-model-small-en-us-0.15.tar.gz"));
    }
  }
} catch (err) {
  console.error("[setup]", err.message);
  if (!wasmOnly) process.exit(1);
}
