# Voice sidecar

A small local service that builds a voice from your own recordings and speaks text in it, using
[OpenVoice V2](https://github.com/myshell-ai/OpenVoice) (MIT). It runs on your computer and
listens on `127.0.0.1` only. Design and measurements: [`../docs/VOICE_ENGINE_FLOW.md`](../docs/VOICE_ENGINE_FLOW.md).

AI-assisted speech: anything rendered in a cloned voice is labelled as such (`X-Ai-Assisted: true`
on the API, a note in the test page and the CLI).

## One-time setup

```bash
cd POC/voice-sidecar
./setup.sh
```

This creates `.venv` (Python 3.9; the OpenVoice stack does not run on newer Pythons), installs the
pinned packages, and downloads the models. About 3.5 GB in total, most of it on the first run.
Nothing is installed system-wide. If you do not have `uv`, the script installs a private copy in `.tools/`.

## Engines

| | OpenVoice V2 (default) | Chatterbox |
|---|---|---|
| Setup | `./setup.sh` | `./setup-chatterbox.sh` (separate Python 3.11 environment, about 4 GB with weights) |
| Start | `./run.sh serve` | `VOICE_ENGINE=chatterbox VOICE_DEVICE=mps ./run.sh serve` |
| What it clones | Timbre only; accent and rhythm come from a stock base voice | Accent, pacing and tone, from the reference clips (zero-shot, no training) |
| Speed on a laptop | 1 to 2 s per sentence | 12 to 25 s per sentence on an Apple GPU (35 s on the CPU, so use `mps`); first start about 5 minutes. Needs an NVIDIA GPU for conversation speed (not yet measured) |
| In the owner's listening test | Did not sound like them | Sounded closer ("best so far") |
| Controls | Pace, base voice, variation | Expressiveness, pacing match |
| License | MIT | MIT. **The upstream project is retired (Aug 2026): no updates or support** |

A voice is built **per engine**: the same clips and consent record are reused, but after switching engines press **Build** once more. The page shows which controls the running engine supports.

## Train and test your own voice

**In the browser (record or upload):**

```bash
./run.sh serve
```

Open the URL it prints (it ends in `#token=...`) in Chrome or Safari, not in an embedded preview, so
the microphone works. Then: tick the consent box, record 10 to 20 prompted sentences or upload WAV
files, press **Build my voice**, type some text and press **Speak in my voice**. **Stock voice** plays the
base voice before conversion, and **Compare** plays stock then yours, so you can hear what the cloning changes.

**From clip files (no browser):**

```bash
./run.sh train --i-am-the-voice-owner ~/my-clips/*.wav     # prints a profile id
./run.sh say <profileId> "I need help." -o help.wav
./run.sh say <profileId> "I need help." -o stock.wav --raw  # stock voice, for A/B
```

Tips for a good voice:

- 20 seconds to 3 minutes of calm, natural speech is plenty. Measured: a profile built from 19 s of clean speech already has a stable voice embedding, so more audio did not change it. Cleaner beats longer.
- Only the voice owner should be speaking in the audio. Interviews and podcasts with other voices pollute the voice; the build flags clips that sound unlike the rest.
- A quiet room, one microphone distance, no music or fan noise. Each clip is checked on upload and rejected with a reason if it is too short, too quiet, clipped or silent.
- Read varied sentences, not one phrase repeated.
- **Base voice** (`--base`) matters most. OpenVoice only changes the *timbre* of a stock voice; accent, rhythm and intonation come from the base voice. Try `EN-US`, `EN-BR`, `EN_INDIA`, `EN-AU`, `EN-Default` and keep the one closest to how you speak.
- `--tau` (0.1 to 0.6) is randomness inside the converter, not a similarity dial: measured on a real profile it moved the model's similarity score by under 0.01. Lower is steadier; higher adds variation and can add artifacts.

## Your data

Profiles are stored in `~/.vocaleyes/voice-sidecar/` (override with `VOICE_SIDECAR_DATA`), outside the repository, so they cannot be committed by accident. Each profile holds a consent record, your clips and the built embedding. Nothing is uploaded anywhere.

```bash
./run.sh list
./run.sh delete <profileId>      # permanent: clips, embedding and consent record
```

The browser page also has **Pause**, **Export (zip)** and **Delete everything permanently**.

## Rules the sidecar enforces

- A profile cannot be created without an explicit consent acknowledgement (`self`, or `authorized` with the voice owner's name). There is no way to add clips or speak without that record.
- Pausing a voice blocks all speech from it until resumed.
- Pace is limited to 0.8 to 1.2, text to 500 characters, uploads to 25 MB.
- The API needs a token (`X-Sidecar-Token` or `Authorization: Bearer`); only `/health` and the static `/ui` page are open, and neither holds data.
- Profile ids are validated as 32 hex characters on every access, so no path can leave the profiles directory.

## API

See the docstring at the top of [`voice_sidecar/app.py`](voice_sidecar/app.py). The Electron app will start this process, pass a random token in `VOICE_SIDECAR_TOKEN` and its `userData` path in `VOICE_SIDECAR_DATA`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_SIDECAR_DATA` | `~/.vocaleyes/voice-sidecar` | where profiles are stored |
| `VOICE_SIDECAR_TOKEN` | random each start | shared secret |
| `VOICE_SIDECAR_PORT` / `_HOST` | `8790` / `127.0.0.1` | listen address |
| `VOICE_DEVICE` | `cpu` | `cpu` is faster and steadier than `mps` for OpenVoice on Apple silicon; Chatterbox: see its timings; `cuda` for NVIDIA is untested |
| `VOICE_CKPT` | `models/v2` | OpenVoice V2 weights |
| `VOICE_WATERMARK` | off | OpenVoice's `wavmark` watermark; its latency is untested |
| `VOICE_ENGINE` | `openvoice` | `openvoice`, `chatterbox` (needs `.venv-cb`), or `fake` (tones, for testing the plumbing without models) |
| `VOICE_CORS` | Vite dev origins and `null` | browser origins allowed to call the API |

## Tests

```bash
.venv/bin/python -m pytest -q       # 47 tests, no models needed (fake engine)
```

## Limits

- English only for now. Other languages need other base speakers and weights (OpenVoice) or Chatterbox's multilingual models (not wired in).
- One render at a time (the models are not thread-safe). Expect about a second per sentence on an M-series CPU.
- Voice quality depends heavily on the recordings and has to be judged by listening.
- A cloned voice is for its owner, or for someone the owner has authorised. Do not build a voice from anyone else's recordings.
