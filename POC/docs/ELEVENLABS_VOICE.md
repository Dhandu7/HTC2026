# Speaking in the user's own voice (ElevenLabs)

When ElevenLabs is set up, **🔊 Speak** says the sentence in the user's **cloned voice**. If it isn't set up, or ElevenLabs is slow (over 6 s) or fails, the same sentence is spoken in the system voice, so the user is never left silent.

## Setup

1. In ElevenLabs, create a voice clone from a recording of the user (or of someone who has agreed to it).
2. Create an API key with **Text to Speech** access (elevenlabs.io → Developers → API Keys). The key starts with `sk_` and is shown only once.
3. Add to `POC/.env` (it's in `.gitignore`):
   ```bash
   ELEVENLABS_API_KEY=sk_...
   ELEVENLABS_VOICE_ID=<voice id from elevenlabs.io → Voices>
   ```
4. Start the app as usual: `npm run dev:all` (or `npm run overlay:all`).

The server prints `voice: ElevenLabs (eleven_flash_v2_5)` on startup, and the start screen shows *"🗣 Speaking in your voice (ElevenLabs)"*.

Values already set in the shell take priority over `.env`. If an old `ELEVENLABS_API_KEY` is exported in your terminal, run `unset ELEVENLABS_API_KEY` before starting.

## Check it

```bash
curl localhost:8787/api/voice/health    # "ok": true means it's configured
curl -X POST localhost:8787/api/speak -H 'content-type: application/json' \
  -d '{"text":"Hello, this is my voice"}' -o test.mp3 && afplay test.mp3
```

A successful Speak logs `[gazetype-llm] speak N chars M ms`. On failure, the ElevenLabs error is logged and the app uses the system voice.

## How it fits the code

| File | Role |
|---|---|
| `server/elevenlabs.ts` | Calls the ElevenLabs text-to-speech API. |
| `server/llm.ts` | `POST /api/speak` (returns MP3) and `GET /api/voice/health`. The key never reaches the browser. |
| `src/voice/elevenlabsVoice.ts` | `speakText()`: plays the cloned voice, falling back to `speechSynthesis`. |
| `src/main.ts` | `speak()` calls `speakText()`; the start screen shows whether the voice is on. |

## Privacy

The spoken text goes to ElevenLabs, and the voice clone lives there. Video never leaves the device. Before real users, follow the consent rules in `docs/VOICE_PLAN.md`: only use a voice whose owner has agreed, and tell users their text goes to ElevenLabs.
