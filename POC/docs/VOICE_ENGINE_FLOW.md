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

## Spike results (7 Nov 2026, step 1)

Run on one machine: **Apple M5, 16 GB, macOS 26, Python 3.9.6, torch 2.8.0.** Reference voice: the macOS `Samantha` system voice reading 13.8 s of text (a neutral voice, so no real person was cloned). Script: `voice-sidecar/spike_openvoice.py`. Raw numbers: `voice-sidecar/spike-results-{cpu,mps}.json`. Pinned versions: `voice-sidecar/requirements.spike.txt`. Watermark off in these runs. n = 30 warm renders (10 phrases × 3 rounds). One machine and one reference clip, so treat these as an indication, not a benchmark.

| | CPU | Apple GPU (MPS) |
|---|---|---|
| Warm render, p50 / p95 (base TTS + voice conversion) | **0.96 s / 1.95 s** | 0.95 s / 2.79 s |
| Short phrases (≤20 chars), p50 | **0.75 s** | 0.79 s |
| Longer phrases (up to ~70 chars), p50 / p95 | **1.42 s / 1.95 s** | 1.08 s / 2.79 s |
| First render in a fresh process (cold) | 3.7 s | 15.7 s |
| Profile extraction from 13.8 s of audio | 0.35 s | 3.3 s |
| Model load (base TTS + converter) | ~1.1 s | ~2.1 s |
| Python import (torch, MeloTTS) | ~12 s | ~13 s |
| Peak memory | 2.4 GB | 1.4 GB |

What this says:

- **Use CPU on Apple silicon.** MPS gave no median gain, a worse tail (p95 2.8 s), a 15 s cold start and a slower profile build. Not worth the extra variance.
- **Live rendering (T2) is "about a second", not instant.** Real-time factor is ~0.5 (renders in half the audio's length), but there is roughly 0.5 s of fixed cost per call. A 1.5 s start budget fits short phrases comfortably and long sentences only sometimes. This supports the plan: real recordings and the pre-render cache carry the experience, and T2 handles the rest with the system-voice fallback.
- **The first request after sidecar start is slow** (3.7 s on CPU), and importing takes ~12 s. The sidecar must warm itself at app launch with one throwaway render, and the app should not offer T2 until `/health` says `warm: true`.
- **A GPU host should help, but this spike did not measure one.** An NVIDIA instance is untested; the numbers above are the baseline to compare it against (see "Later: hosted GPU rendering").
- **Pace is controllable.** `speed` 0.8 / 1.0 / 1.2 gave 2.32 s / 2.03 s / 1.65 s of audio for the same sentence.
- **Emotion and accent style control are not exposed in V2's API.** The model card advertises "flexible voice style control", but the code exposes only `speed`, `sdp_ratio`, `noise_scale` and `noise_scale_w` on the base TTS and `tau` on the converter. Accent comes from picking the base speaker (EN-US, EN-BR, EN-AU, EN_INDIA, EN-Default). So `delivery` is pace only, as the LLM doc already assumes.
- **Voice quality was not assessed.** I can't listen to audio. Someone needs to play the clips and judge whether the clone sounds like the reference. Sample files from this run are in the session scratchpad and are not committed.

**Through the sidecar, and under load.** Rendered over HTTP with the real engine, warm, on the same Mac: about 1.5 s for short phrases and 3.8 s for a 70-character sentence. The machine was busy (iCloud sync using a lot of CPU after the 2.2 GB environment was created in `~/Documents`); rerunning the spike script at that moment gave 1.56 s and 2.2 s p50 for short and longer phrases, so the sidecar adds no measurable overhead and the earlier, quiet-machine numbers above (0.75 s and 1.4 s) are the better estimate of the best case. Real timing needs a quiet machine.

Licenses read (not legal advice): OpenVoice code MIT, MeloTTS code MIT, OpenVoice V2 weights MIT (Hugging Face model card), MeloTTS-English weights MIT, `bert-base-uncased` Apache-2.0. **Not yet checked:** the other BERT models MeloTTS downloads (it loads one per language at import), UniDic, `wavmark` (watermarking), and the NLTK data. Read those before shipping.

## Quality finding from real use (7 Nov 2026): OpenVoice V2 does not sound like the speaker

First test with the owner's own voice (4 clips, 19 s, clean levels, no clipping): **"doesn't sound like me at all."** That matches the design of the engine, and the measurements say settings will not fix it.

Measured with OpenVoice's own speaker embedding (cosine similarity, 1 = identical; same machine, same profile, same sentence):

| | Similarity to the owner |
|---|---|
| The owner's own clips against their average voice | 0.975 to 0.979 (the ceiling) |
| The stock voice, before conversion | −0.01 to 0.25 depending on the base voice |
| **After conversion, any base voice, any `tau`** | **0.83 to 0.87** |

- The converter moves the sound a long way toward the speaker (about 0.16 to 0.84) and the embedding is already stable, so **more or cleaner audio is not the bottleneck.**
- **`tau` is not a similarity control.** In the source it scales the noise in the encoder's sampling. Across 0.1 to 1.0 it changed the score by less than 0.01. An earlier version of the test page and README described it as "voice strength"; that was wrong and has been corrected.
- **The base voice changes the score by about 0.02**, but it also sets accent, rhythm and intonation, which the converter does not touch. Those are most of what a listener hears as "that's not them". The test page now has a base-voice picker (EN-US, EN-BR, EN_INDIA, EN-AU, EN-Default) so the owner can try the one closest to how they speak.
- The yardstick is the model's own embedding, so it shows direction, not perceived similarity.

Reading: OpenVoice V2 changes **timbre only**. For a person whose accent, pacing and intonation differ from the stock voice, it will sound like "someone with a similar voice reading in a stock accent". The earlier review overstated what it delivers. Options, in the order I would try them:

1. **Real recordings (T0) stay the primary experience.** Nothing synthetic can be mistaken for the owner, and that was already the plan.
2. **Try an engine that clones prosody as well as timbre** from a short reference, on the same clips, side by side with OpenVoice. Candidates from the review: Chatterbox, Qwen3-TTS (permissive licenses, to be verified), and F5-TTS or XTTS-v2 (non-commercial, usable only for a hackathon demo). The `Engine` interface in `voice-sidecar/voice_sidecar/engine.py` is meant for this. These are heavier and probably want the hosted GPU.
3. Keep OpenVoice as a lightweight fallback, labelled honestly, rather than the headline feature.

### Chatterbox test (7 Nov 2026): better on long sentences by one yardstick, far too slow on this Mac

Tested on the owner's own clips (38 s of reference, 8 clips; Chatterbox conditions on about the first 10 s). Chatterbox (Resemble AI, 500M English, MIT code and weights), Python 3.11, torch 2.6, Apple GPU (MPS). Script: `voice-sidecar/spikes/chatterbox_spike.py`; raw numbers in `chatterbox-results-mps.json`. Same sentences rendered by OpenVoice from the same clips for comparison.

| | Chatterbox (MPS) | OpenVoice (CPU, from the earlier spike) |
|---|---|---|
| Warm render, median | **25 s** (9 s of compute per second of audio) | 1 to 2 s |
| First render in a fresh process | 46 s | 3.7 s |
| Preparing the voice from the reference | 31 s | 0.35 s |
| Model load (incl. a 3 GB first-time download) | 172 s | about 1 s |
| Peak memory | 3.0 GB | 2.4 GB |

Speaker similarity, scored with Chatterbox's own voice encoder (so it favours Chatterbox; the owner's clips against their own average score 0.90 to 0.95):

| Sentence | Chatterbox | OpenVoice EN-US | OpenVoice EN-Default |
|---|---|---|---|
| Long (51 chars) | 0.85 | 0.77 | 0.79 |
| Long (64 chars) | 0.90 | 0.82 | 0.80 |
| "Yes." / "Please wait a moment." (short) | 0.71 / 0.59 | not scored | not scored |

What this says:

- **Not usable for live speech on a Mac.** 12 to 38 s per sentence, with the machine also busy with iCloud sync. Real-time needs an NVIDIA GPU, which this test did not have, so Chatterbox's real speed is unmeasured. This points directly at the hosted GPU plan.
- **A modest gain on longer sentences, and a loss on short phrases**, by a yardstick biased toward Chatterbox. The numbers alone do not show a decisive win. **Listening is the real test**, and the owner's verdict on the clips decides whether this is worth pursuing.
- **The project is retired.** Its README says that as of August 2026 it is unmaintained, with no updates or support. MIT code stays usable, but there will be no fixes.
- It always embeds an inaudible watermark (Perth) in its output, which helps with labelling AI speech.
- **Turbo (350M, one-step decoder) and Nano (110M, built for CPU) were not tested.** If Chatterbox sounds right, Turbo is the one to try for latency, on an NVIDIA GPU.

Install gotchas found (all handled in the spike script or notes):

- **Python 3.9 is required in practice.** The machine's default Python 3.14 cannot run this stack. Use a 3.9 venv.
- **Upstream bug:** `ToneColorConverter(..., enable_watermark=...)` raises `TypeError` because the kwarg is read and then forwarded to the base class. Only the default (watermark on) works. The spike builds the converter without that kwarg.
- **NLTK:** current NLTK needs the `averaged_perceptron_tagger_eng` resource, which MeloTTS's G2P library does not download.
- **Download size:** ~526 MB UniDic dictionary (needed at import even for English), ~620 MB of Hugging Face models fetched on first render (the first process's 29 s "cold" render was mostly this download), 131 MB converter weights. The venv is 2.2 GB (UniDic is 789 MB of it). Ship these in the installer or fetch at first run; do not assume network at use time.
- **Watermark path untested.** Whether `wavmark` adds noticeable latency is still open.

**Verdict on step 1: go, with conditions.** OpenVoice V2 is licensed and fast enough for the T0/T1-first design on a modern laptop, and the live tier works as a ~1 s render. It is not proven on weaker hardware, and clone quality is unjudged. Next: listen to the samples, run the same script on one older or lower-end machine, and test the watermark on.

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
| T2 | **Cloned voice, live render** via the sidecar | New text the user just selected | ~0.8 s short, ~1.4 s long, p50 on an M5 CPU (spike results below) |
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

Built in `POC/voice-sidecar/` (README there). The contract grew from the first sketch: profiles are explicit resources, and consent is part of creating one.

| Endpoint | Purpose |
|---|---|
| `GET /health` (open) | `{ok, engine, device, warm}` |
| `GET /ui` (open, no data) | Browser page to record or upload clips, build and test a voice |
| `POST /v1/profiles` | `{consent:{mode, acknowledged, authorizedBy?}}` → `{profileId}`. Refused without acknowledgement |
| `GET /v1/profiles/{id}` | Clips with quality reports, built?, paused?, consent |
| `POST /v1/profiles/{id}/clips` | Upload one clip. Rejected with a reason if too short, too quiet, clipped or silent |
| `POST /v1/profiles/{id}/build` | Train the voice embedding from the clips |
| `POST /v1/synthesize` | `{profileId, text, pace?, tau?, raw?}` → `audio/wav`, labelled `X-Ai-Assisted: true` |
| `PATCH` / `DELETE /v1/profiles/{id}` | Pause or resume; permanent delete of clips, embedding and consent record |
| `GET /v1/profiles/{id}/export`, `GET`/`DELETE …/clips/{name}` | Export zip; audition or remove a clip |

Everything except `/health` and `/ui` needs the token.

The renderer never sees the embedding file. The sidecar starts on app launch, warms the model with one tiny render, and is restarted by Electron main if `/health` fails.

## Later: hosted GPU rendering (AWS EC2 with an NVIDIA GPU)

Planned, not started. The goal is near-realtime speech on any device, including ones too weak to render locally. Nothing in the current work should make this harder:

- **Same contract, different base URL.** The sidecar API above is the interface. `openvoice.ts` takes a base URL and token from config; local is `http://127.0.0.1:<port>`, hosted is an HTTPS endpoint. No shared filesystem is assumed: reference audio and embeddings travel over the API.
- **Only T2 moves.** Recordings (T0), the pre-rendered cache (T1) and the system voice (T3) stay on the device, so the app still speaks offline or when the host is down. Remote replaces only the live render.
- **Router config:** the T2 budget becomes per endpoint (local or hosted), and the router can try hosted first and fall back to local, or the reverse, by setting.
- **Streaming:** a GPU host makes sentence-level streaming worth adding (return audio per sentence). The router's "started" signal already supports that.
- **This is a privacy change, not just a deployment change.** Text, and either reference audio or the voice embedding, would leave the device. Before enabling it: new consent wording, an explicit opt-in separate from the voice-profile consent, encrypted transport and storage, per-user access control, a real delete on the server, and an update to the "recordings stay local" statements in the README and onboarding.
- **To measure then:** end-to-end time to first audio from a typical home connection, cold start of the instance, cost per hour against usage, and behaviour when the connection drops mid-render.

Spike numbers below are recorded per device (CPU, Apple GPU) so a GPU instance can be compared against them.

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

## Progress (7 Nov 2026)

| Step | State |
|---|---|
| 1 Spike (OpenVoice install, timings, licence check) | **Done on one machine** (M5 laptop): results above. Still open: listening test, a weaker machine, watermark on, licenses of the remaining dependencies |
| 2 Sidecar and `electron/sidecar.mjs` | **Sidecar done** (`voice-sidecar/`, 33 tests, real-model run over HTTP verified on a synthetic test voice). `electron/sidecar.mjs` (spawn, token, health, restart) not started |
| 3 `provider.ts`, `system.ts`, `pcmPlayer.ts`, `speak()` refactor | **Done.** `speak()` goes through `VoiceRouter` with the system voice registered, so behaviour is unchanged |
| 4 `clips.ts` | Matcher and `RecordedClipVoice` done and tested. Recording UI, quality checks and clip storage not started |
| 5 `consent.ts` | Consent record, profile store and tier policy done and tested. Onboarding screens not started |
| 6 `openvoice.ts`, profile build, audition | Profile build and audition work in the sidecar's browser page and CLI. **Not yet judged on a real person's voice.** `src/voice/openvoice.ts` (the app-side client) not started |
| 7 `router.ts` | **Done**, with tests for tier order, budgets, mid-play failure, cancel and policy |
| 8–10 Cache, pre-render, management UI, metrics | Not started |

Run `npm test` in `POC/`: 61 tests pass, `npm run typecheck` is clean.

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
