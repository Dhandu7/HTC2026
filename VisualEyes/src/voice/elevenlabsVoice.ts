// Speaks sentences in the user's cloned ElevenLabs voice via the local server (POST /api/speak),
// with the system voice as a fallback.
//
// If the server is off, has no ElevenLabs key, is slow or errors, the same sentence is spoken
// with speechSynthesis (the app's original behaviour), so the user is never left silent.

const base = () => ((window as unknown as { gazetype?: unknown }).gazetype ? "http://localhost:8787" : "");
/** Give up on the cloned voice and use the system voice after this long. */
const TIMEOUT_MS = 6000;
/** Re-check whether the cloned voice is available at most this often. */
const RECHECK_MS = 30_000;

interface Job {
  ctrl: AbortController;
  audio?: HTMLAudioElement;
  url?: string;
}
let current: Job | null = null;
let voiceOn: boolean | null = null;
let checkedAt = 0;

/** True if the server has ElevenLabs set up. Cached so Speak doesn't wait on a health check. */
export async function cloudVoiceAvailable(): Promise<boolean> {
  if (voiceOn !== null && Date.now() - checkedAt < RECHECK_MS) return voiceOn;
  checkedAt = Date.now();
  try {
    const r = await fetch(`${base()}/api/voice/health`, { signal: AbortSignal.timeout(1500) });
    voiceOn = r.ok && !!(await r.json()).ok;
  } catch {
    voiceOn = false;
  }
  return voiceOn;
}

function systemSpeak(text: string) {
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

/** Stop whatever is being spoken, in either voice. */
export function stopSpeaking() {
  if (current) {
    current.ctrl.abort();
    current.audio?.pause();
    if (current.url) URL.revokeObjectURL(current.url);
    current = null;
  }
  speechSynthesis.cancel();
}

/** Speak `text`. A new call replaces anything still playing (last one wins). */
export function speakText(text: string) {
  stopSpeaking();
  const job: Job = { ctrl: new AbortController() };
  current = job;
  void (async () => {
    try {
      if (!(await cloudVoiceAvailable())) throw new Error("cloud voice not configured");
      const r = await fetch(`${base()}/api/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.any([job.ctrl.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!r.ok) throw new Error(`speak ${r.status}`);
      const blob = await r.blob();
      if (current !== job) return; // a newer sentence replaced this one
      job.url = URL.createObjectURL(blob);
      job.audio = new Audio(job.url);
      job.audio.onended = () => {
        if (current === job) {
          URL.revokeObjectURL(job.url!);
          current = null;
        }
      };
      await job.audio.play();
    } catch (err) {
      if (current !== job) return; // cancelled on purpose
      if (voiceOn) console.warn("[gazetype] cloned voice failed, using the system voice:", err);
      if (job.url) URL.revokeObjectURL(job.url);
      current = null;
      systemSpeak(text);
    }
  })();
}
