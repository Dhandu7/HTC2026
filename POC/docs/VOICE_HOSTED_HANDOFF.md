# Handoff: running the OpenVoice voice engine on AWS (GPU)

> **SUPERSEDED (7 Nov 2026).** The team is using ElevenLabs on its own servers, so there is no model to host on an EC2 GPU. The AWS work is now a DynamoDB table, a secret and an API: see `AWS_VOICE_HANDOFF.md`. This file is kept only as history; its privacy points still apply.


For: the teammate taking the hosted voice component. Written 7 Nov 2026. Branch: `voice/openvoice-engine`.
Read first: [`VOICE_ENGINE_FLOW.md`](VOICE_ENGINE_FLOW.md) (design, spike numbers) and [`../voice-sidecar/README.md`](../voice-sidecar/README.md) (how to run it).

## 1. The one thing to know first: this is EC2, not Bedrock

Bedrock is a managed API for hosted foundation models (it is where **Claude Haiku 5.5** runs for the prediction layer, a separate task on `llm/bedrock-haiku-prediction`). OpenVoice V2 is a PyTorch speech pipeline (MeloTTS plus a tone-colour converter) that you run yourself. As far as I know it cannot be put on Bedrock; I have not checked Bedrock's current custom-model import rules against it, so confirm that if anyone wants to try.

The plan (also in the voice doc) is **an EC2 instance with an NVIDIA GPU**, running the sidecar in `POC/voice-sidecar/`:

```
Device (any laptop)                          AWS
  Gaze UI / app  ── HTTPS + token ──►  EC2 GPU instance: voice sidecar (FastAPI, OpenVoice V2)
  T0 real recordings, T1 cache stay local          └─ profiles, clips, embeddings on an encrypted EBS volume
  T3 system voice fallback stays local
```

Only the **live render tier (T2)** moves to the server. Real recordings, the pre-rendered cache and the system voice stay on the device, so the app still speaks offline or if the server is down.

## 1b. Update: host Chatterbox, not OpenVoice

After this doc was first written, the owner listened to both engines on their own clips and preferred **Chatterbox** (see the "Chatterbox test" in `VOICE_ENGINE_FLOW.md`). It is now a selectable engine in the sidecar (`VOICE_ENGINE=chatterbox`, its own environment from `./setup-chatterbox.sh`, Python 3.11). Everything above about EC2, privacy, auth and the API still applies; what changes for the GPU host:

- **It needs the GPU.** On an Apple GPU a sentence takes 12 to 25 s and the first start about 5 minutes. Nobody has run it on NVIDIA, so its real speed is unknown. **Measuring a warm sentence on a T4 and an A10G is the first job**, and it decides whether near-realtime is reachable.
- **Weights are about 3.2 GB** (the speech model 2.1 GB, the decoder 1.06 GB). A 16 GB GPU (T4) is probably enough; that is a guess, not a measurement. Bake the weights into the AMI.
- **Setup on the instance:** `./setup-chatterbox.sh`, then `VOICE_ENGINE=chatterbox VOICE_DEVICE=cuda ./run.sh serve`. Pins: torch 2.6, transformers 5.2. Check `torch.cuda.is_available()` first.
- **Try Turbo.** Chatterbox-Turbo (350M, a one-step decoder, built for low-latency agents) is the likeliest way to reach conversation speed. It is **not wired into the sidecar yet** (`ChatterboxTurboTTS` in the upstream package) and nobody has judged how it sounds on the owner's voice.
- **The upstream project is retired** (no updates or support since August 2026). Pin the commit (done in `requirements-chatterbox.txt`) and treat any bug as ours to fix.
- **Watermark:** Chatterbox always embeds an inaudible Perth watermark in its output, which fits the "AI-assisted" labelling.
- **Voices are per engine.** A profile built for OpenVoice must be built again for Chatterbox. Building is one step (about 35 s on a Mac) and needs no training.

## 2. What exists and what does not

| Exists, tested locally (M5 Mac, CPU) | Does not exist yet |
|---|---|
| Sidecar HTTP API: profiles, consent gate, clip upload with quality checks, build, synthesize, pause, export, delete | **Anything run on CUDA.** `cuda` is accepted as a device value but has never been executed |
| Browser test page (`/ui`) and CLI (`train`, `say`, `list`, `delete`) | Any AWS resources, deployment script, TLS, or a hosted URL |
| 33 automated tests (fake engine, no models) | Per-user authentication (see section 5) |
| Real-model end-to-end: three clips → built voice → rendered speech, over HTTP, with token auth | The TypeScript client (`src/voice/openvoice.ts`) that the app will use to call it |
| Spike timings on CPU and Apple GPU (voice doc) | Electron main-process code that launches a local sidecar |

## 3. Suggested steps

1. **Check quotas before anything else.** New AWS accounts often have **zero** vCPU quota for G-family GPU instances ("Running On-Demand G and VT instances"). Request an increase early; it can take a day.
2. **Pick an instance.** `g4dn.xlarge` (one T4, 16 GB) is the cheapest sensible start; `g5.xlarge` (A10G) is faster. Use an Ubuntu 22.04 Deep Learning AMI (PyTorch) so the NVIDIA driver is already installed. Check current pricing for your region; on-demand GPU instances bill by the hour while running, so stop it when idle.
3. **Get the code and set up.** Clone the repo, check out `voice/openvoice-engine`, then `cd POC/voice-sidecar && ./setup.sh`. Expect to fix some pins: `requirements.spike.txt` was frozen on **macOS arm64**, and torch on Linux installs a CUDA build. Confirm `python -c "import torch; print(torch.cuda.is_available())"` prints `True` before going further. Setup downloads about 3.5 GB; bake the result (the venv, `models/v2/`, and the Hugging Face cache) into an AMI so new instances do not repeat it.
4. **Run it on the GPU, privately first.**
   ```bash
   VOICE_DEVICE=cuda VOICE_SIDECAR_TOKEN=$(openssl rand -hex 24) ./run.sh serve   # binds 127.0.0.1
   ```
   Reach it from your laptop with an SSM or SSH port-forward (`ssh -L 8790:127.0.0.1:8790 ...`), not by opening the port. Open `http://127.0.0.1:8790/ui#token=...` locally, record or upload clips, build, speak.
5. **Measure.** Run `python spike_openvoice.py --ref <clip.wav> --ckpt models/v2 --out out --device cuda` on the instance and compare with the table in the voice doc. Then measure **end to end from a laptop over the real network** (time to first audio), which is what users feel. Suggested target, to be agreed: under about 1 s for a sentence of 40 characters or fewer.
6. **Only then expose it.** Put it behind TLS (an ALB with an ACM certificate, or Caddy/nginx), a security group that allows only HTTPS, and keep the sidecar bound to `127.0.0.1` behind the proxy.

Rough expectation, **not measured**: a T4 or A10G should render a short phrase well under the CPU numbers, but nobody has run it, so do not promise a figure.

## 4. Known gotchas (all hit during the spike)

- **Python 3.9 only.** Newer Pythons cannot run the OpenVoice and MeloTTS stack. `setup.sh` handles this with `uv`.
- **Upstream bug:** `ToneColorConverter(..., enable_watermark=...)` raises `TypeError`. The sidecar works around it (`engine.py`). Do not "simplify" that class away.
- **NLTK:** current NLTK needs the `averaged_perceptron_tagger_eng` resource; `setup.sh` fetches it.
- **UniDic (526 MB)** is needed at import even for English.
- **First render downloads ~620 MB** of language models from Hugging Face into the cache. Pre-download on the AMI; the first request on a fresh instance otherwise takes 30 s or more.
- **Import takes about 12 s** and the first render is slow, so the sidecar warms itself at start. `/health` reports `warm: true` when ready; do not send traffic before that.
- **One render at a time.** The models are not thread-safe and the engine holds a lock. Throughput is one request at a time per process. For several users at once you need more processes or instances, or a queue. GPU batching is not implemented.
- **Machine load matters.** On the Mac, iCloud sync running in the background roughly doubled render times (0.96 s p50 became 1.84 s for the same script). Measure on a quiet instance.

## 5. Decisions and work that must happen before real users

1. **Privacy and consent change.** Locally, recordings never leave the device. Hosted, **text and voice clips (or the embedding) go to a server**. That needs new consent wording, an opt-in separate from the voice-profile consent, a real server-side delete, and updates to the README and onboarding text that say "stays on this device". Do not enable it quietly.
2. **Authentication.** The sidecar has **one shared token and no concept of a user**. Anyone with the token can read, build and delete every profile on that server. For more than one person you need per-user auth (for example Cognito or signed JWTs) and each profile bound to its owner. Not built.
3. **Encryption and retention.** Encrypted EBS, TLS in transit, no clip or text logging, a retention policy, and a documented delete path (the delete endpoint already removes the whole profile directory; snapshots and backups would also need handling).
4. **Voice owner consent still applies.** The API requires a consent acknowledgement to create a profile and records it. Hosted use must keep that gate and must not let anyone build a voice from someone else's recordings.
5. **Availability.** Decide what the app does when the server is slow or down. The plan: the router's T2 budget (about 1.5 s) falls back to the system voice. Cold starts of a stopped instance take minutes, so "stop when idle" and "instant speech" pull against each other.
6. **Cost.** Estimate cost per active user-hour against the hours the instance is up.

## 6. Where to look in the code

| What | Where |
|---|---|
| API routes and their rules | `POC/voice-sidecar/voice_sidecar/app.py`, `service.py`, `store.py` |
| The real engine (device, watermark, models) | `voice_sidecar/engine.py` (`OpenVoiceEngine`) |
| Settings from environment variables | `voice_sidecar/config.py` (table in the README) |
| Tests | `POC/voice-sidecar/tests/test_api.py` (run with `.venv/bin/python -m pytest -q`) |
| Timing script | `POC/voice-sidecar/spike_openvoice.py` |
| App-side router that will call the server | `POC/src/voice/router.ts` (tiers, budgets, fallbacks); the OpenVoice provider is not written |

## 7. Not yet verified

- Anything on CUDA, including whether `Melo TTS(device="cuda")` and the converter run cleanly with the pinned versions.
- Whether the macOS-frozen requirements install unchanged on Linux.
- Network latency from users' homes, and how the sidecar behaves under concurrent requests.
- The watermark option (`VOICE_WATERMARK=1`): its latency and audibility.
- How good a cloned voice sounds. It has only been run on a synthetic test voice, and judging quality takes a person listening to the owner's real recordings.
