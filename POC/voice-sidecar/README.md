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
./hosted.sh test         # 135 tests; no AWS account and no ElevenLabs key needed

# local development: in memory, no real login (dev auth only works on a loopback address)
VOICE_STORE=memory AUTH_MODE=dev ELEVENLABS_API_KEY=... ./hosted.sh serve

./hosted.sh smoke --clip my-voice.wav --i-am-the-voice-owner   # live ElevenLabs check with YOUR key
VOICE_TABLE_NAME=... ./hosted.sh check-table                    # lifecycle check against the real DynamoDB table
./hosted.sh reconcile                                           # retry stuck deletes, free stale reservations (schedule this)
./hosted.sh config                                              # effective configuration, never a secret value
```

**Never paste the ElevenLabs key into a chat or commit it.** Locally it is an environment variable
(`ELEVENLABS_API_KEY`); in AWS it comes from Secrets Manager (`ELEVENLABS_SECRET_ID`). Every configuration variable is
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
tests_hosted/                   the tests, with a fake ElevenLabs and moto for DynamoDB
```

## Limits

- Not yet run against real AWS or the live ElevenLabs API. See the handoff for what is verified and what is not.
- Speech is returned as a whole file, not streamed.
- The consent text is a draft without legal or privacy review.
- Which ElevenLabs plan is used decides how many users can have a voice (Starter 10, Creator 30, Pro 160, Scale and Business 660).
