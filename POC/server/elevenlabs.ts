// ElevenLabs text-to-speech, used by server/llm.ts for POST /api/speak.
// Speaks a sentence in the user's cloned voice. Only text is sent — never video or images.
//
// Settings (POC/.env):
//   ELEVENLABS_API_KEY=sk_...      key with Text to Speech access (elevenlabs.io → Developers → API Keys)
//   ELEVENLABS_VOICE_ID=...        the cloned voice (elevenlabs.io → Voices → copy ID)
//   ELEVENLABS_MODEL=...           optional; default eleven_flash_v2_5 (fastest)

// Read on each call, not at import time: server/llm.ts loads POC/.env after its imports run.
const env = (key: string, fallback = "") => process.env[key] ?? fallback;

export const elevenModel = () => env("ELEVENLABS_MODEL", "eleven_flash_v2_5");
export const voiceConfigured = () => !!(env("ELEVENLABS_API_KEY") && env("ELEVENLABS_VOICE_ID"));

/** Speak `text` in the cloned voice. Returns MP3 audio. */
export async function elevenSpeak(text: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env("ELEVENLABS_VOICE_ID"))}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": env("ELEVENLABS_API_KEY"), "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: elevenModel(),
        voice_settings: { stability: 0.5, similarity_boost: 0.85 },
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${await res.text()}`);
  return res.arrayBuffer();
}
