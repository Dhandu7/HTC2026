# Voice engine flow: OpenVoice V2, phrase-first, consent-first

Status: **planned, not built.** Branch: `voice/openvoice-engine`. Written 7 Nov 2026.
Companion doc (other branch): `docs/LLM_PREDICTION_FLOW.md` (`llm/bedrock-haiku-prediction`). It defines the shared `UserProfile` contract that this branch fills in under `voice`.

This supersedes the **engine choice** in `VOICE_PLAN.md` (VoiceStudio). The provider interface, router, PCM player and phrase cache described there still apply. OpenVoice V2 becomes one more `VoiceProvider`, and the default one. VoiceStudio stays as an optional alternative provider and is no longer on the critical path.

## Decisions taken from the engine review

| Decision | Reason |
|---|---|
| Default engine: **OpenVoice V2** | MIT, runs locally on CPU or GPU, clones from a short reference clip |
| Primary experience: **the user's real recorded clips** | Most authentic, least risk, zero synthesis latency |
| Fallback: system TTS now, Piper later | Never silent. Piper is an optional phase 3 swap |
| XTTS-v2 is out of the default path | Weights and outputs are non-commercial. Hackathon-only if ever used, and it must be disclosed on Devpost |

**Things I have not verified** (the review text states them; check before relying on them): OpenVoice V2's license and weight terms, its CPU latency, and whether V2 exposes emotion or speed control or only language and accent. Step 1 is a spike that settles all three on the demo machine.

## How OpenVoice V2 shapes the design

OpenVoice is two stages: a **base TTS** (MeloTTS in V2) produces speech in a generic voice, then a **tone-colour converter** re-voices it to match a reference embedding. Consequences:

- It is **not a streaming server**. It renders a whole clip, then plays it. The VoiceStudio-style 100 ms first-audio target does not apply.
- It needs a **Python sidecar** (PyTorch). The browser cannot run it. Electron's main process spawns the sidecar.
- So latency is managed by **pre-rendering**, not streaming: the top phrases and the suggestions currently on screen are rendered before the user picks one.

## The four speaking tiers

Router picks the first tier that applies. Each tier falls through to the next on error or timeout.

| Tier | What plays | When | Latency |
|---|---|---|---|
| T0 | The user's **real recording** | Text matches an approved recorded phrase (normalized match) | ~10 ms |
| T1 | **Cloned voice, pre-rendered** clip from the phrase cache | Text was rendered earlier (top phrases, emergency phrases, speculative renders) | ~10 ms |
| T2 | **Cloned voice, live render** via the sidecar | New text the user just selected | ~0.5–3 s, measured in step 1 |
| T3 | **System voice** | Profile missing, not consented, paused, sidecar down, or T2 slower than the budget | ~100 ms |

T2 starts only after the user selects the exact text (dwell on the chip, or Speak on typed text). Selecting is the confirmation. Nothing is ever spoken automatically.

If T2 is slower than its budget (default 1.5 s, tunable after the spike), speak T3 immediately and finish the render for the cache. Nobody waits in silence.

## Flow 1: onboarding and consent (once)

```
Settings → My voice
  1. Explain: recordings stay on this machine, cloned speech is labelled, you can pause/export/delete.
  2. Consent screen: "This is my own voice." Typed or gaze-selected confirmation.
     Caregiver path: only with documented authorization from the voice owner (checkbox + name + date).
  3. Store consent record {profileId, ownerLabel, ts, mode: "self"|"authorized"} before any audio is kept.
```

No recordings are written until step 3 completes. Consent is bound to the app profile, not to an audio file, so uploading someone else's clip cannot create a profile.

## Flow 2: recording and profile build

```
Record     10–20 prompted phrases ("Hello", "I'm okay", "I need help", "Yes", "No",
           "Please wait", "Thank you", + personal ones). Quiet room, one take each, re-record allowed.
Check      Per clip: length, clipping, noise floor, silence ratio. Reject and re-prompt on bad clips.
Bank       Save each accepted clip as a T0 phrase → instant "real voice" mode works already.
Build      Sidecar POST /v1/profile {clips[]} → tone-colour embedding for the best 30–60 s of audio.
Audition   Play "Hello, this is my voice" in T2. User (or carer) accepts, or re-records.
Pre-render Queue the top phrases and emergency phrases into the T1 cache.
Persist    userData/voice/<profileId>/{clips/, embedding, consent.json, manifest.json}
```

Quality floor: if the audition fails twice, keep the profile in **clips-only mode** (T0 and T3) rather than speaking low-quality cloned audio.

## Flow 3: runtime speak

```
Gaze selects a chip or Speak
  → text
  → router:
       normalize(text) ∈ recorded phrases?        → T0 play clip
       cache hit (profileId + normalized text)?   → T1 play cached
       profile active + consent + sidecar healthy → T2 render (budgeted) → play, store in cache
       else                                       → T3 system voice
  → status pill: "🗣 My recording" | "🗣 My voice (AI-assisted)" | "🗣 System voice (reason)"
  → learn(text) in the speech profile; log {tier, ttfaMs, fellBack}
```

Cloned output is always labelled "AI-assisted" in the UI. T0 is labelled "My recording".

## Flow 4: speculative pre-render (the latency trick)

When the suggestion strip updates (see LLM doc), the router receives the visible chips:

1. Skip any already in T0 or T1.
2. Render the rest in the sidecar, **one at a time, highest-ranked first**.
3. Cancel the queue as soon as the chips change or the user selects.
4. Pause during calibration and while the sidecar is busy with a selected T2 render.

A chip that finished rendering before the dwell completes plays as T1. Dwell is ~700 ms, so the first one or two chips often make it.

## Flow 5: profile management

| Action | Behaviour |
|---|---|
| Pause | Router skips T0–T2 for cloned audio. Recorded clips can stay enabled separately |
| Export | Zip of clips, embedding, consent record, manifest. Local file only |
| Delete | Removes clips, embedding, cache and consent record, then confirms. Not recoverable |
| Re-record | New embedding replaces the old one. The cache is invalidated by `profileId + embeddingVersion` |

## Sidecar contract (`voice-sidecar/`, Python)

Bound to `127.0.0.1`. Electron main generates a random token at launch and passes it to the sidecar and the renderer. Requests without it get 401.

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{ok, engine, device, warm}` |
| `POST /v1/profile` | multipart clips → `{embeddingId}`; writes the embedding under `userData` |
| `POST /v1/synthesize` | `{text, embeddingId, pace?, language?}` → `audio/wav` (PCM16 mono; sample rate declared in a header) |
| `DELETE /v1/profile/:id` | removes the embedding |

The renderer never sees the embedding file. The sidecar starts on app launch, warms the model with one tiny render, and is restarted by Electron main if `/health` fails.

## Code layout (extends `VOICE_PLAN.md`)

```
src/voice/
  provider.ts        VoiceProvider interface (as in VOICE_PLAN.md)
  system.ts          T3
  clips.ts           T0: recorded phrase store + normalized matcher (reuse normalizeText from metrics/session.ts)
  openvoice.ts       T2 client for the sidecar (fetch + AbortSignal)
  phraseCache.ts     T1 (IndexedDB, keyed profileId + embeddingVersion + normalized text)
  prerender.ts       Flow 4 queue with cancel and throttle
  consent.ts         consent record read/write, "is this profile usable?" check
  router.ts          tier selection, budgets, fallback, metrics
  pcmPlayer.ts       WAV/PCM playback (reuse design from VOICE_PLAN.md)
src/ui/voiceSetup.ts onboarding, recording, audition, management screens (gaze-operable)
electron/sidecar.mjs spawn, token, health, restart
voice-sidecar/       Python service, requirements pinned, model download script
```

## Fields this branch owns in `UserProfile`

```ts
voice: {
  profileId: string;
  consent: { mode: "self" | "authorized"; ts: number; authorizedBy?: string };
  embeddingVersion: number;
  mode: "off" | "clips-only" | "cloned";   // cloned also uses clips
  paused: boolean;
  phrases: { id: string; text: string; normalized: string; clipFile: string }[];
  delivery: { pace: number };               // 0.8–1.2, set during audition
  tierBudgetMs: { t2: number };
}
```

## Implementation steps

| # | Step | Done when |
|---|---|---|
| 1 | **Spike**: install OpenVoice V2 in a venv, clone from a 30 s clip, render 10 phrases, record cold and warm render time on the demo laptop (CPU and Metal if usable), check the license text of code and weights, check for speed and style controls | Numbers recorded in this doc; go / no-go |
| 2 | Sidecar HTTP service + `electron/sidecar.mjs` (token, spawn, health, restart) | `/v1/synthesize` returns audio from the renderer |
| 3 | `provider.ts`, `system.ts`, `pcmPlayer.ts`, refactor `speak()` in `main.ts` | Existing Speak behaviour unchanged |
| 4 | `clips.ts` + recording UI + quality checks | T0 plays the user's own clip for an approved phrase |
| 5 | `consent.ts` + onboarding screens | No audio saved before consent; delete wipes everything |
| 6 | `openvoice.ts` + profile build + audition | Profile builds from the recorded clips |
| 7 | `router.ts` with budgets and fallbacks, unit tests with fake providers | Tests cover timeout, sidecar down, no consent, paused |
| 8 | `phraseCache.ts` + `prerender.ts` | Top-20 phrases are instant; suggestions pre-render |
| 9 | Management UI: pause, export, delete, re-record | Each works and is covered by a test |
| 10 | Metrics into the session export; Devpost and README notes (license, consent, "not a medical device") | Export contains tier and latency per Speak |

Steps 1–4 and 7 give a safe demo: real-voice phrases, system-voice fallback, nothing synthetic. Steps 5–6 and 8 add the cloned voice.

## Verification

- **Unit**: router tier order and every fallback, matcher normalization, cache key invalidation on re-record, consent gate.
- **Manual, sidecar running**: 10 phrases, record the T2 p50 and p95, cold and warm. Compare with the budget.
- **Manual, sidecar stopped**: Speak still produces audio within 500 ms and the pill says why.
- **Kill the sidecar mid-render**: the system voice speaks the text; no silence over 1 s.
- **Consent**: with no consent record, T0–T2 are refused for cloned audio. Delete leaves no files under `userData/voice/`.
- **A/B with a listener** who knows the user: real clip vs cloned vs system voice. Record how many judge the clone "recognizably them".

## Risks

| Risk | Mitigation |
|---|---|
| T2 render time too slow to feel conversational | Pre-render, short phrases, the T3 budget fallback. If the spike shows seconds on the demo laptop, ship T0/T1 only and call T2 "preview" |
| Python and PyTorch install is large and fragile | Pre-install on the demo machine; sidecar is optional; T0 and T3 work without it |
| Clone quality drops on weak or affected speech | Quality checks, audition gate, clips-only fallback; encourage banking early |
| Misuse: cloning someone else's voice | Consent bound to the app profile, owner/authorized record, no in-app cloning from arbitrary audio |
| Embedding or clips leak | Local only, `userData`, optional Electron `safeStorage` encryption of the embedding, delete is a real delete |
| Licence surprise in model weights | Step 1 checks it; do not ship until the actual license files are read |
