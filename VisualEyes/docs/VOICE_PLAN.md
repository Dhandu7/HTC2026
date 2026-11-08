# Plan: speaking in the user's own voice (VoiceStudio integration)

Status: **planned, not built.** Written 5 Nov 2026.

> **Both engine choices were dropped (7 Nov 2026):** VoiceStudio, then OpenVoice, in favour of hosted ElevenLabs (`AWS_VOICE_HANDOFF.md`). The app-side provider, router, PCM player and phrase-cache design below still applies.
>
> **Earlier note, engine choice superseded:** the default engine is now OpenVoice V2, behind a phrase-first, consent-first flow. See `VOICE_ENGINE_FLOW.md`. The provider interface, router, PCM player and phrase cache below still apply, and VoiceStudio remains an optional provider.

Goal: when the user selects **🔊 Speak**, GazeType speaks in *their own* (banked or cloned) voice, starting within about 300 ms, fully on-device. It must still speak, in the system voice, if anything in the voice pipeline is missing or slow.

## Why VoiceStudio

[VoiceStudio](https://github.com/debpalash/VoiceStudio) v0.5.7 is already installed at `/Applications/VoiceStudio.app`. It's an open-source local voice-cloning app (AGPL-3.0; the default OmniVoice engine is Apache-2.0), and it uses Apple Silicon's GPU (Metal). Its backend already exposes what we need. Facts below are from reading its bundled source (`Contents/Resources/backend/`), not from running it:

| Need | VoiceStudio provides | Source |
|---|---|---|
| Local, no cloud | Backend on `127.0.0.1:3900`; local clients need no credential | `backend/main.py`, `docs/speech-platform.md` |
| Streaming speech | `WS /ws/tts`. Send JSON `{"text", "voice", "engine"?, "language"?, "speed"?}`. Receive binary **PCM16 mono at 24 kHz** in ~200 ms chunks, then `{"type":"done", "ttfa_ms", "rtf", …}` or `{"type":"error", "detail"}`. Splits the text into sentences. Targets **< 100 ms time to first audio** on a warm model | `backend/api/routers/tts_stream.py` |
| One-shot fallback | `POST /v1/audio/speech` (OpenAI-compatible). Generates the whole clip *before* sending it, so it's not real time | `backend/api/routers/openai_compat.py` |
| Voices | `GET /v1/audio/voices`, `GET /profiles`. A voice can be referenced by profile ID or name | same |
| Consent | `POST /profiles/{id}/consent`, `/attestation`, `/lock`; provenance watermarking | routers + `services.watermark` |
| Health | `GET /health` | `backend/main.py` |

**License position (not legal advice):** GazeType talks to VoiceStudio as a **separate program over a local API**. It doesn't bundle, link or modify it. That should keep GazeType's own license choice independent of AGPL. Don't vendor VoiceStudio code into this repo.

## Architecture

```
GazeType renderer
  └─ src/voice/
       ├─ provider.ts        interface VoiceProvider { id; available(); speak(text, opts): SpeakHandle; warm?() }
       ├─ system.ts          SystemVoice: wraps speechSynthesis (today's behaviour). Always available
       ├─ voicestudio.ts     VoiceStudioVoice: WebSocket client for /ws/tts, plays PCM chunks as they arrive
       ├─ pcmPlayer.ts       Web Audio player: PCM16 24 kHz → Float32 → gapless queued AudioBufferSourceNodes
       ├─ phraseCache.ts     pre-generated audio for the top-N personal phrases (IndexedDB)
       └─ router.ts          picks a provider; falls back on timeout or error; records latency metrics
main.ts → doAction("speak") → voiceRouter.speak(text)
```

### Provider contract
```ts
interface SpeakHandle { done: Promise<SpeakResult>; cancel(): void }
interface SpeakResult { provider: string; ttfaMs: number; totalMs: number; fellBack: boolean; error?: string }
interface VoiceProvider {
  id: "system" | "voicestudio" | "builtin-neural";
  available(): Promise<boolean>;           // cheap, cached for 10 s
  speak(text: string, opts: { voiceId?: string; speed?: number; signal?: AbortSignal }): SpeakHandle;
  warm?(): Promise<void>;                   // e.g. a tiny request to load the model into memory
}
```

### Fallback rules (router.ts)
1. If the user's chosen provider is `voicestudio` and `available()` is true, start the stream.
2. **If no audio chunk arrives within 400 ms** (a cold model, VoiceStudio busy), cancel and speak the same text with `SystemVoice`. Mark `fellBack: true`.
3. On a WebSocket error or close mid-sentence: let what already played finish, then speak the *rest* (sentences not yet sent) with the system voice. Never stay silent.
4. A new Speak while one is playing: cancel the current one. Last one wins.
5. Show a small status: `🗣 My voice · 140 ms`, or `🗣 System voice (VoiceStudio offline)`.

### Gapless playback (pcmPlayer.ts)
- One `AudioContext` (sample rate 24 000, or resample if the browser forces 48 kHz).
- For each binary message: `Int16Array` → `Float32Array` (/32768) → `AudioBuffer` → schedule at `max(ctx.currentTime, nextStartTime)`, then advance `nextStartTime`.
- `ttfa` = time from `send()` to the first chunk being scheduled.
- `cancel()` stops all scheduled nodes and closes the socket.

### Phrase cache (phraseCache.ts): makes the most common phrases instant
- After calibration, and whenever the phrase store changes, pre-generate audio in the background for the **top 20 phrases**, plus emergency phrases ("I need suction", "Call the nurse").
- Store the PCM in **IndexedDB**, keyed by `voiceId + normalized text`. It's per-device and never uploaded.
- Speak checks the cache first: a hit plays in about 10 ms, regardless of VoiceStudio's state.
- Throttle: one generation at a time, only while the app is idle (no selection in the last 3 s), and paused during calibration.

### Settings additions
- **Voice:** System · My voice (VoiceStudio) · Built-in neural (phase 3).
- **VoiceStudio voice profile:** dropdown filled from `GET /v1/audio/voices`. It should also be gaze-operable (A1 in the Saturday plan).
- **Echo each word as chosen:** off by default. Speaks each committed word at 1.2× speed, using the cache or the system voice.
- **Pre-cache top phrases:** on by default.

### Electron specifics
- The renderer connects straight to `ws://127.0.0.1:3900/ws/tts`. Nothing needs to change in the main process.
- Optional: a tray menu item "Start VoiceStudio" that runs `open -a VoiceStudio`, plus waiting for `/health` to pass.
- Never auto-install VoiceStudio. It's a large install (PyTorch, about 5 GB); link to it from the settings screen instead.

## Consent and safety (non-negotiable)
- Only use a profile that has **consent recorded** (`/profiles/{id}/consent`). If it doesn't, show "This voice has no consent on file" and use the system voice.
- A one-time in-app confirmation: "This is my own voice, or I have permission to use it." Store the profile ID plus a timestamp.
- Keep VoiceStudio's watermarking on. Never offer to clone a voice from arbitrary audio inside GazeType: banking happens in VoiceStudio, by the user.
- Only text is sent, and only to the local machine. Nothing changes in the "video never leaves the device" promise.

## Voice-banking flow (ALS users, outside GazeType)
1. While the user can still speak: record 1–5 minutes in VoiceStudio's clone workspace (quiet room, natural sentences).
2. Create the profile, record consent, and lock the profile.
3. In GazeType: Settings → Voice → My voice → pick the profile → **Test** ("Hello, this is my voice").
4. The caregiver checklist, a printable page, explains this. Banking early matters, because quality drops once speech is affected.

## Implementation steps (when we build it)

| # | Step | Files | Est. |
|---|---|---|---|
| 1 | **Spike:** start VoiceStudio, hit `/health`, `/v1/audio/voices`, and a `/ws/tts` round-trip from a Node script. Record TTFA cold vs warm on this Mac. **Confirm** the browser-origin behaviour: does a page on `localhost:5173` connect without a ticket? (VoiceStudio has a `/api/auth/ws-ticket` flow for browser clients.) | `scripts/voicestudio-probe.mjs` | 45 min |
| 2 | `VoiceProvider` interface + `SystemVoice` (move today's `speak()` into it) | `src/voice/provider.ts`, `system.ts`, `main.ts` | 20 min |
| 3 | `pcmPlayer.ts` with unit tests (Int16→Float32 conversion, scheduling order, cancel) | `src/voice/pcmPlayer.ts`, `tests/pcm.test.ts` | 45 min |
| 4 | `VoiceStudioVoice` WebSocket client: send, receive chunks, done/error, cancel | `src/voice/voicestudio.ts` | 45 min |
| 5 | Router with the 400 ms first-chunk timeout + mid-stream fallback; unit tests with a fake provider | `src/voice/router.ts`, `tests/voice-router.test.ts` | 45 min |
| 6 | Settings UI (provider, profile, echo, cache), status pill | `index.html`, `main.ts` | 30 min |
| 7 | Phrase cache (IndexedDB) + background warm-up | `src/voice/phraseCache.ts` | 45 min |
| 8 | Consent check + confirmation dialog | `voicestudio.ts`, `main.ts` | 20 min |
| 9 | Metrics: log `ttfaMs`, `fellBack`, provider per Speak into the session export | `metrics/session.ts` | 15 min |
| 10 | Docs: README section + caregiver voice-banking page | `README.md`, `docs/VOICE_BANKING.md` | 20 min |

**Total: about 5.5 hours.** Steps 1–5 (about 3 h) give a demoable "speaks in my voice, falls back safely". Steps 6–10 are polish.

## How we'll verify it
- **Unit tests:** PCM conversion, gapless scheduling order, router fallback on timeout / error / mid-stream close, cache hit and miss.
- **Manual, VoiceStudio running:** speak 10 phrases and record TTFA p50/p95 cold vs warm. Target: warm p50 under 300 ms, cached phrases under 50 ms.
- **Manual, VoiceStudio stopped:** Speak still works in the system voice within 500 ms, and the status says so.
- **Kill VoiceStudio mid-sentence:** the rest is spoken in the system voice with no silent gap over 1 s.
- **Consent:** a profile without consent is refused and falls back.

## Risks and open questions
| Risk | Mitigation |
|---|---|
| A browser-origin WebSocket needs a ticket (the auth flow in `docs/api-auth.md`) | Step 1 spike decides. If needed, the Electron main process proxies the socket, or we fetch a ticket via the loopback API first |
| Cold-model TTFA is seconds, not milliseconds | `warm()` on app start and after idle; the phrase cache; 400 ms fallback to the system voice |
| VoiceStudio API changes (pre-1.0, v0.5.7) | Pin the tested version in the docs; the probe script runs in CI-less smoke checks; keep the provider adapter thin |
| 24 kHz vs the AudioContext's forced 48 kHz | Let Web Audio resample (an AudioBuffer created at 24 kHz plays correctly in a 48 kHz context) |
| Large install for judges | It's optional; the demo machine has it pre-installed; the system voice covers everyone else |
| Ethics of voice cloning | Consent gate, own-voice confirmation, watermarking on, no in-app cloning |

## Later: a built-in voice that doesn't need VoiceStudio (phase 3)
For users without VoiceStudio, bundle a small preset neural voice that runs in the renderer: **Kokoro** (82M parameters, preset voices only, Apache-2.0; runs in the browser via ONNX/WebGPU), or **Kyutai Pocket TTS** (~100M, MIT, reported faster than real time on a laptop CPU; check whether it can clone). Neither replaces the user's *own* voice. They only improve on the robotic system voice. Pick by measured TTFA on a mid-range laptop.
