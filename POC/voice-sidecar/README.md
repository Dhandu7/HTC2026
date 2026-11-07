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

- 1 to 5 minutes of calm, natural speech in total, in clips of 5 to 15 seconds. Longer is not always better; cleaner is.
- A quiet room, one microphone distance, no music or fan noise. Each clip is checked on upload and rejected with a reason if it is too short, too quiet, clipped or silent.
- Read varied sentences, not one phrase repeated.
- **Voice strength** (`--tau`, 0.1 to 0.6) sets how hard the converter pushes toward your voice. If it sounds too much like the stock voice, raise it. If it sounds distorted, lower it.

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
| `VOICE_DEVICE` | `cpu` | `cpu` is faster and steadier than `mps` on Apple silicon (spike results) |
| `VOICE_CKPT` | `models/v2` | OpenVoice V2 weights |
| `VOICE_WATERMARK` | off | OpenVoice's `wavmark` watermark; its latency is untested |
| `VOICE_ENGINE` | `openvoice` | `fake` makes tones, for testing the plumbing without models |
| `VOICE_CORS` | Vite dev origins and `null` | browser origins allowed to call the API |

## Tests

```bash
.venv/bin/python -m pytest -q       # 33 tests, no models needed (fake engine)
```

## Limits

- English only for now (EN-US base speaker). Other languages need other base speakers and weights.
- One render at a time (the models are not thread-safe). Expect about a second per sentence on an M-series CPU.
- Voice quality depends heavily on the recordings and has to be judged by listening.
- A cloned voice is for its owner, or for someone the owner has authorised. Do not build a voice from anyone else's recordings.
