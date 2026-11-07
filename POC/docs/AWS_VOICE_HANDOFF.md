# Handoff for Rajvir: the AWS side of the hosted voice (ElevenLabs + DynamoDB)

Written 7 Nov 2026. Branch `voice/openvoice-engine` (the name is historical; the OpenVoice and Chatterbox work was dropped). This replaces an earlier handoff that described hosting a model on an EC2 GPU. We are not doing that any more (that file was removed; it is in git history).

## 1. What this is, in one minute

VocalEyes users can create a voice from their own recordings and have the app speak in it. **ElevenLabs does the cloning and the speech** (their servers). What ElevenLabs does not know is *who our users are*. All voices live in one ElevenLabs account under one API key, so anyone holding that key can speak in any voice. We therefore need our own per-user records:

- which user owns which ElevenLabs `voice_id` (and that no user can reach another's),
- the consent each user gave,
- their voice settings,
- the lifecycle state, so that **deleting a user's voice really deletes it at ElevenLabs**,
- a counter for the account's voice-slot cap.

**The split.** The application code for all of that is written and tested (section 3). **You own AWS**: the DynamoDB table, the secret, the compute that runs the API, identity, IAM, networking, monitoring and deploys. Section 4 lists what we need from you; section 7 lists decisions that are yours.

```
App (browser / Electron)         AWS (yours)                                       ElevenLabs
  user signs in (JWT)   ──HTTPS──►  API (container or function)  ──HTTPS + xi-api-key──►  clone / speak / delete
                                       │   ├─ DynamoDB table: per-user records, consent audit, slot counter
                                       │   └─ Secrets Manager: the ElevenLabs API key (never in the app)
                                       └─ scheduled reconciler: retries stuck deletes, frees stale reservations
```

## 2. Facts about ElevenLabs that shape the design

Read on 7 Nov 2026 from their docs and help center; re-check before relying on them.

- **Voice slots are capped per plan:** Free 3, Starter 10, Creator 30, Pro 160, Scale and Business 660; cloning needs Starter or above ([help center](https://help.elevenlabs.io/hc/en-us/articles/24351056337937-How-many-voice-slots-do-I-get-per-tier-and-how-can-i-increase-it)). So one voice per user is created only on opt-in and deleted on removal. **The plan decides how many users can have a voice.**
- **Generated audio is retained by default.** Zero-retention (`enable_logging=false`) is for enterprise customers only ([API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)). The consent text discloses this.
- **Endpoints used:** `POST /v1/voices/add` (multipart, returns `voice_id`), `POST /v1/text-to-speech/{voice_id}`, `DELETE /v1/voices/{voice_id}`; auth is the `xi-api-key` header. Regional endpoints (US, EU, India, Singapore) exist; set `ELEVENLABS_BASE_URL` to match your region.
- **Fast models:** `eleven_flash_v2_5` and `eleven_v4_turbo` are listed at about 100 ms median before network time; the Turbo v2.5 model is deprecated ([models](https://elevenlabs.io/docs/overview/models)). Default is `eleven_flash_v2_5`.
- **Verification:** ElevenLabs makes the owner verify a cloned voice (they read a short phrase aloud on the ElevenLabs website) before it will speak, even their own. `POST /v1/voices/add` returns `requires_verification`, and the API has no way to complete the step. Our service handles it: the voice is created and flagged `needsVerification`, the app tells the person what to do, and the first successful speak clears the flag. **Anyone who creates a voice needs an ElevenLabs login to verify it, or a plan/workspace arrangement that makes this work for end users. This is a product question for the team**, because our users cannot be assumed to have, or to be able to use, an ElevenLabs account.
- **Consent:** ElevenLabs' policy appears to require the speaker's consent for cloning ([use policy](https://elevenlabs.io/use-policy)); I only saw that in secondary summaries, so someone should read the official text. Our flow already requires it.

## 3. What is built and tested (application side)

All in `POC/voice-sidecar/`. `./hosted.sh setup` then `./hosted.sh test` runs **196 tests with no AWS account and no ElevenLabs key**.

| Piece | File | Notes |
|---|---|---|
| Record store, two implementations with one test suite | `voice_sidecar/records.py` | In-memory (dev) and DynamoDB. The DynamoDB one is tested against moto. |
| ElevenLabs client | `voice_sidecar/elevenlabs.py` | Request shapes checked against a fake that behaves like the docs. Key only ever in the header; never logged or in errors. |
| Flows | `voice_sidecar/hosted.py` | Consent, clip checks, slot reservation, clone, speak, settings, pause, delete, reconciler. |
| HTTP API | `voice_sidecar/hosted_app.py` | Routes below. |
| Auth | `voice_sidecar/auth.py` | OIDC/JWT (Cognito works) with a dev mode that only runs on loopback. |
| Config and entry point | `voice_sidecar/hosted_main.py` | `serve`, `reconcile`, `check-config`. Everything via environment variables. |
| Table template | `infra/voices-table.cfn.json` | A test keeps it identical to what the code expects. |
| IAM example | `infra/iam-policy.example.json` | Least privilege; a test fails if the code starts using an action the policy lacks. |
| Post-deploy check | `./hosted.sh check-table` | Runs the whole record lifecycle against the real table with a throwaway user. |
| Live ElevenLabs check | `./hosted.sh smoke ...` | Run by whoever holds the key. Never touches DynamoDB. |
| App screens | `POC/src/voice/hosted*.ts`, `POC/src/ui/myVoice.ts` | The "My voice" screen: consent, record or upload, create, try, settings, pause, delete. 58 tests on the logic. Tried end to end in a browser against `./hosted.sh dev` (a fake ElevenLabs). |
| Local stack, no key, no AWS | `./hosted.sh dev` | The service in memory with a fake ElevenLabs, for building and demoing the screens. |

API (all `/v1/me/...` routes act only on the signed-in user's own voice; the user id is the token's `sub`, never a request field):

```
GET  /health                 GET /v1/consent-text
GET    /v1/me/voice          POST /v1/me/voice   (multipart: consent JSON + audio files)
PATCH  /v1/me/voice          POST /v1/me/voice/speak          DELETE /v1/me/voice
```

**Not done, or not verified, and you should know:**

- **Nothing has run in AWS.** The DynamoDB code is tested against moto, a mock. Real DynamoDB can differ (reserved words are handled with placeholders, but run `./hosted.sh check-table` against the real table first).
- **Never run against the live ElevenLabs API.** Request shapes follow their docs; the first live run is the smoke script, by whoever holds the key.
- No Lambda adapter, container image, API Gateway or IaC for the compute. Your call (section 4.3).
- Speech is returned as a whole file, not streamed. Streaming would cut time to first audio; it is a later change.
- The "retry stuck deletes" job exists as a command but nothing schedules it yet.
- The consent text is a draft and has not had a legal or privacy review.

## 4. What we need from you

Each item has a check so you and I can agree when it is done.

1. **The DynamoDB table.** Start from `infra/voices-table.cfn.json` (CloudFormation JSON; port it to CDK or Terraform if that is the team's standard). On-demand billing, point-in-time recovery, encryption, deletion protection, TTL on `ttl`, one GSI `gsi1`. *Check:* `VOICE_TABLE_NAME=... ./hosted.sh check-table` prints every step `ok`.
2. **The ElevenLabs API key in Secrets Manager.** Suggested name `vocaleyes/elevenlabs-api-key`, value `{"api_key": "..."}` (a plain string also works). The app reads it by `ELEVENLABS_SECRET_ID`. **The key must never appear in chat, in the repo, in CloudFormation parameters or in logs.** If ElevenLabs lets you scope the key, limit it to text-to-speech and voices (I did not verify that option exists). Decide a rotation routine. *Check:* `./hosted.sh serve` starts with only `ELEVENLABS_SECRET_ID` set.
3. **Compute for the API.** The app is a FastAPI service. Options, none chosen: (a) a container on App Runner or ECS Fargate behind HTTPS runs it unchanged and is the least work; (b) Lambda behind API Gateway or a function URL works but needs an adapter that is not in the repo, and you should check current payload, timeout and streaming limits against speech responses and against uploads: onboarding now accepts up to 200 MB per request (100 MB per file), which is far above API Gateway's and Lambda's request-size limits, so a Lambda design would need uploads to go through S3 first or the limits lowered in `hosted_app.py` and `clipInput.ts`; (c) EC2, which I would avoid for this. Whatever you pick must run `python -m voice_sidecar.hosted_main serve`, with the environment from section 5, and a second scheduled task for `python -m voice_sidecar.hosted_main reconcile` every few minutes (EventBridge Scheduler is the obvious fit).
4. **Identity.** The app expects an RS256 JWT whose `sub` is the user id (a Cognito user pool is the natural fit). Set `JWT_ISSUER`, `JWT_AUDIENCE` (the app client id) and optionally `JWT_JWKS_URL`. The API verifies the token itself even if API Gateway also does. The app has no login today: it uses a test login that the service accepts only on loopback. The client is ready for the switch: it calls the service through `POC/src/voice/hostedConfig.ts`, where one call, `setTokenProvider(() => accessToken)`, makes every request carry a bearer token instead. Tell me which provider you choose and I will wire the sign-in screen and token refresh. The app reads the service address from `VITE_VOICE_API_URL` at build time (default `http://127.0.0.1:8790`), and its origin must be in `CORS_ORIGINS`. **Never** run with `AUTH_MODE=dev` anywhere except a laptop; the server refuses it on a non-loopback address.
5. **IAM.** Use `infra/iam-policy.example.json` as the role for the API and the reconciler: item-level DynamoDB actions (`GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`) on the table, `Query` on the table and `gsi1`, and `GetSecretValue` on that one secret. No wildcards, no `Scan`. Add `kms:Decrypt` if the secret uses a customer-managed key.
6. **Network and abuse limits.** HTTPS only. Set `CORS_ORIGINS` to the real app origins. Put throttling at the gateway: the in-app per-user limit (`SPEAK_PER_MINUTE`, default 60) only counts within one server instance, and every request spends ElevenLabs characters.
7. **Logging and alarms.** Application logs deliberately contain **no request text, audio or tokens**, only ElevenLabs voice *names* on failures. Do not turn on request-body logging at the gateway or load balancer. Please alarm on: `reconcile` reporting `deleteFailed > 0`; records stuck in `pending` or `deleting` for more than about 10 minutes; ElevenLabs 5xx or 429 rates; slot use near the cap (read `META#elevenlabs / SLOTS.used`; publishing it as a metric is not built).
8. **Environments.** The slot counter lives in the table and the limit is `VOICE_SLOT_LIMIT`. **If dev and prod share one ElevenLabs account, each table thinks it owns the whole cap.** Either use a separate ElevenLabs account and key per environment, or set each environment's limit so the total stays under the plan's cap.
9. **Data protection.** Encryption at rest and in transit are on. Think about point-in-time recovery: it can restore a deleted voice record for up to its retention window, which matters for "delete means delete". Decide the window and say so in the privacy notice.

## 5. Configuration the app reads (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_STORE` | `dynamodb` | `memory` for local development only |
| `VOICE_TABLE_NAME` | required | the table |
| `AWS_REGION` | SDK default | region of the table and secret |
| `ELEVENLABS_SECRET_ID` | none | Secrets Manager secret holding the key (production) |
| `ELEVENLABS_API_KEY` | none | local development only |
| `ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io` | regional endpoint if needed |
| `ELEVENLABS_MODEL_ID` | `eleven_flash_v2_5` | default model for new voices |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | audio format returned (`mp3_44100_128` is the API default; some formats need higher plans) |
| `VOICE_SLOT_LIMIT` | `10` | the plan's custom-voice cap |
| `SPEAK_PER_MINUTE` | `60` | per-user limit, per instance |
| `AUTH_MODE` | `jwt` | `jwt`, or `dev` on loopback only |
| `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_JWKS_URL` | none | for `jwt` (JWKS defaults to the issuer's `/.well-known/jwks.json`; the service needs outbound access to it) |
| `HOST`, `PORT` | `127.0.0.1`, `8790` | listen address (set `0.0.0.0` inside a container) |
| `CORS_ORIGINS` | none | comma-separated allowed origins |

`./hosted.sh config` prints the effective configuration without any secret value, and `./hosted.sh reconcile` runs the scheduled cleanup once.

## 6. The DynamoDB design (so you can review or change it)

Single table, on-demand.

| `pk` | `sk` | Purpose |
|---|---|---|
| `USER#<userId>` | `VOICE#elevenlabs` | the user's current voice: status (`pending`, `active`, `paused`, `deleting`), `voiceId`, `voiceName`, settings, consent, clip metadata (no audio), timestamps, `version` |
| `USER#<userId>` | `CONSENT#<ts>#granted` or `#deleted` | append-only audit; carries `ttl` (400 days after writing, a default I chose) |
| `META#elevenlabs` | `SLOTS` | `used`: voices in use |

`gsi1` (`gsi1pk = STATUS#elevenlabs#<status>`, `gsi1sk = updatedAt`) lets the reconciler find stale `pending` and `deleting` records without a scan.

**The slot cap is enforced by a transaction.** Creating a record adds 1 to `used` with the condition `used < limit`, and puts the voice item with `attribute_not_exists(pk)`, in one `TransactWriteItems`. Two simultaneous creates cannot both win the last slot, and one user cannot hold two voices. Deleting finishes with another transaction that removes the item, subtracts 1 and writes the audit entry.

**Create:** validate consent (including "recordings and text go to ElevenLabs" and the consent text version) and clips → reserve slot (pending) → clone at ElevenLabs → mark active. A failure at any point frees the slot; if activation fails after a successful clone the app deletes the remote voice, and if that also fails it keeps the pending record and logs the voice name.
**Delete:** mark `deleting` (the voice is silenced at once) → delete at ElevenLabs (404 counts as done) → remove the record. If ElevenLabs fails the record stays `deleting` and returns 502; the user can retry and the reconciler retries too.
**Any input is accepted:** a recording made in the app (up to 3 minutes each) or any file, whatever its name or type. Up to 40 files, 100 MB per file, 200 MB per request; only the first 30 minutes of each file are decoded. Files that are not audio or video, or are unusable, are skipped and listed back to the person; they do not fail the request.

**Recordings are not kept:** clips are checked, uploaded and dropped; only length, loudness and warnings are stored.

## 7. Decisions that are yours (or the team's)

1. Compute: container, Lambda, or something else (4.3).
2. Identity provider and how the app signs users in (4.4).
3. Environments, accounts, and how the ElevenLabs key and slot cap are split between them (4.8).
4. Retention: audit items live 400 days after writing (my default), plus the point-in-time-recovery window (4.9). Needs a policy decision and a privacy-notice line.
5. Who owns the ElevenLabs account, which plan it is on (this sets how many users can have a voice), and who creates and rotates the key.
6. IaC tool and where the template lives.
7. Alarm destination (SNS topic, Slack, pager).
8. A legal or privacy review of the consent text in `voice_sidecar/hosted.py` (`CONSENT_TEXT`). It is a draft.

## 8. Known gaps (so nothing surprises you later)

- **Orphaned remote voices.** If the server crashes in the instant between ElevenLabs creating a voice and our record being marked active, ElevenLabs holds a voice with no active record. Voices are named `vocaleyes-<12-char hash of the user id>-<random>`, the pending record holds that name, and a failed cleanup logs it, so a person can find and delete it in the ElevenLabs dashboard. Automatically listing and cleaning orphans is not built.
- The rate limiter is per instance (section 4.6).
- The reconciler releases a stale pending slot but cannot know whether ElevenLabs created a voice for it (same cause as above).
- User-account deletion across the rest of the product (calibration, the speech profile) is not part of this; this service only knows about voices.
- JWKS keys are fetched on first use and cached; the service needs outbound HTTPS to the issuer.

## 9. How to verify end to end once things exist

```bash
cd POC/voice-sidecar && ./hosted.sh setup && ./hosted.sh test            # 196 tests, no cloud needed
VOICE_TABLE_NAME=... AWS_REGION=... ./hosted.sh check-table              # the real table
ELEVENLABS_API_KEY=... ./hosted.sh smoke --clip my-voice.wav --i-am-the-voice-owner   # whoever holds the key
```

Then start the service with the production environment, sign in as a test user, create a voice with the consent text, speak a sentence, delete the voice, and confirm in the ElevenLabs dashboard that the voice is gone and the record is gone from the table.
