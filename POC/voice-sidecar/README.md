# Hosted voice service

Lets a person create a voice from their own recordings and have VocalEyes speak in it. **ElevenLabs** clones the
voice and makes the speech (on its servers). This service keeps what ElevenLabs does not know, in **DynamoDB**: which
user owns which voice, their consent, their settings, where the voice is in its lifecycle, and the account's
voice-slot cap.

AWS side, decisions and the checklist for the person deploying it: [`../docs/AWS_VOICE_HANDOFF.md`](../docs/AWS_VOICE_HANDOFF.md).
Why the local engines (OpenVoice, Chatterbox) were dropped, with the measurements: [`../docs/VOICE_ENGINE_FLOW.md`](../docs/VOICE_ENGINE_FLOW.md).

## Run it

```bash
./hosted.sh setup        # .venv-hosted, Python 3.12, about 160 MB
./hosted.sh test         # 189 tests; no AWS account and no ElevenLabs key needed

# try the app screens with NO key and no AWS: the service plus a fake ElevenLabs that makes tones, not speech
./hosted.sh dev          # then, in another terminal:  cd POC && npm run dev   and open the app's "🗣 My voice" button

# your ElevenLabs key: put it in ONE of these places (the scripts look in this order)
#   1. the .env file in this folder: open it, paste after ELEVENLABS_API_KEY=, save (git ignores it)
#   2. the macOS Keychain:   ./hosted.sh key-set      (prompts; nothing is shown)
./hosted.sh key-check    # says where a key was found, never shows it
# local development against the real ElevenLabs, in memory, with a test login:
VOICE_STORE=memory AUTH_MODE=dev ./hosted.sh serve     # picks the key up from the Keychain

./hosted.sh doctor       # read-only: is your key accepted, does the plan allow cloning, how many voice slots are free?
./hosted.sh smoke --clip my-voice.wav --i-am-the-voice-owner   # live ElevenLabs check with YOUR key
VOICE_TABLE_NAME=... ./hosted.sh check-table                    # lifecycle check against the real DynamoDB table
./hosted.sh reconcile                                           # retry stuck deletes, free stale reservations (schedule this)
./hosted.sh config                                              # effective configuration, never a secret value
```

**Never paste the ElevenLabs key into a chat, type it after `export` in a terminal (that lands in your shell history), or commit it.** Put it in `.env` (copy of `.env.example`; git ignores `.env`, and it is created with owner-only permissions) or use `./hosted.sh key-set`. The `.env` file is read as text and never run as a script, and only `ELEVENLABS_API_KEY` is read from it. In AWS it comes from Secrets Manager (`ELEVENLABS_SECRET_ID`). If a key ever does leak, rotate it in the ElevenLabs dashboard. Every configuration variable is
documented at the top of [`voice_sidecar/hosted_main.py`](voice_sidecar/hosted_main.py) and in the handoff.

## API

All `/v1/me/...` routes act only on the signed-in user's own voice. The user id is the verified token's `sub`, never a
request field.

```
GET    /health                    GET /v1/consent-text   (the exact text a person must agree to, versioned)
GET    /v1/me/voice               POST /v1/me/voice      (multipart: consent JSON + audio files in any common format)
PATCH  /v1/me/voice               {settings?, paused?}
POST   /v1/me/voice/speak         {text, settings?} -> audio, labelled AI-assisted
DELETE /v1/me/voice               deletes at ElevenLabs, then here
```

## Rules the service enforces (each has a test)

- **No voice without consent**, including that recordings and text are sent to ElevenLabs, and the person must have been shown the current consent text.
- **A user can only reach their own voice.** The ElevenLabs voice id never leaves the server.
- **A failed create frees its slot** and does not leave an orphan voice; the account's slot cap is enforced atomically in DynamoDB.
- **A voice ElevenLabs wants verified is not used until it is.** ElevenLabs requires the voice's owner to verify a cloned voice (reading a short phrase aloud on its website) before it will speak; the API cannot do that step. The service records `needsVerification`, tells the person exactly what to do, stops calling ElevenLabs for that voice, and clears the flag the first time a speak succeeds. Try it without a key: `FAKE_REQUIRE_VERIFICATION=1 ./hosted.sh dev`, then `curl -X POST http://127.0.0.1:8794/fake/verify-all`.
- **A delete completes only after ElevenLabs confirms.** Until then the voice is silenced and marked `deleting`, and it is retried.
- **Recordings are not kept:** clips are checked, uploaded and dropped; only length, loudness and warnings are stored.
- **Request text, audio, tokens and the API key are never logged**, and error messages never echo them.
- Tokens are verified (RS256 only, issuer, expiry, optional audience); `AUTH_MODE=dev` refuses to run off loopback.

## Layout

```
voice_sidecar/records.py        record store: in-memory and DynamoDB, one behaviour
voice_sidecar/elevenlabs.py     ElevenLabs client (clone, speak, delete)
voice_sidecar/hosted.py         consent, clip checks, create / speak / settings / pause / delete / reconcile
voice_sidecar/hosted_app.py     HTTP API         voice_sidecar/auth.py     JWT and dev auth
voice_sidecar/hosted_main.py    configuration and entry points
voice_sidecar/audio.py          decoding any audio format, quality checks, splitting long recordings at pauses
voice_sidecar/records_check.py  lifecycle check used by `./hosted.sh check-table`
infra/                          DynamoDB table (CloudFormation JSON) and an example least-privilege IAM policy
scripts/elevenlabs_smoke.py     live check you run yourself
scripts/dev_stack.py            `./hosted.sh dev`: the service with an in-process fake ElevenLabs
tests_hosted/                   the tests, with a fake ElevenLabs and moto for DynamoDB
```

## Limits

- Not yet run against real AWS or the live ElevenLabs API. See the handoff for what is verified and what is not.
- Speech is returned as a whole file, not streamed.
- The consent text is a draft without legal or privacy review.
- Which ElevenLabs plan is used decides how many users can have a voice (Starter 10, Creator 30, Pro 160, Scale and Business 660).

## The app side

The "🗣 My voice" button in the app opens the screen: read and accept the consent, record or add audio, create the voice, try it,
change its settings, pause it, delete it. Speaking then goes through the app's voice router: your voice when it is active,
the system voice otherwise or when the service is slow or down.

```
POC/src/voice/hostedApi.ts         client for the API above (dev login on loopback only, or a bearer token)
POC/src/voice/hostedController.ts  the screen's logic and its plain-language messages
POC/src/voice/hostedVoice.ts       the router tier that speaks in the hosted voice
POC/src/voice/hostedConfig.ts      service address and who is calling; setTokenProvider() is where sign-in plugs in
POC/src/voice/recorder.ts          microphone recording
POC/src/ui/myVoice.ts              the screen (plain DOM calls; service text is never used as HTML)
```

Sign-in is not built. Until it is, the app uses a test login that the service accepts only on a loopback address. When a login
provider is chosen, call `setTokenProvider(() => accessToken)` and the app switches to bearer tokens. Set `VITE_VOICE_API_URL` at build
time to point the app at the real service. The screen is for the person setting up the voice or a carer, with a mouse or keyboard;
speaking in the voice afterwards works with gaze like everything else.
