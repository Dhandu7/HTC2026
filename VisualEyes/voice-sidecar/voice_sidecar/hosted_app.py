"""HTTP API for the hosted voice. Every /v1/me/... route acts on the authenticated user's own voice only.

  GET    /health                  no auth
  GET    /v1/consent-text         no auth: the exact text a person must agree to (versioned)
  GET    /v1/me/voice             the caller's voice (status, settings, consent, clip metadata)
  POST   /v1/me/voice             multipart: consent (JSON), files (audio, any common format) -> 201
  PATCH  /v1/me/voice             {settings?: {...}, paused?: bool}
  POST   /v1/me/voice/speak       {text, settings?} -> audio (AI-assisted)
  DELETE /v1/me/voice             delete at ElevenLabs, then here (502 + retried later if ElevenLabs fails)

With Auth0 sign-in (AUTH_MODE=auth0, see users.py) also:
  GET    /v1/me                   the signed-in person's profile (email and name from Auth0)
  GET    /v1/me/preferences       {preferences, version, updatedAt}
  PUT    /v1/me/preferences       {preferences, version?} -> 409 if version is given and stale
Sign-up, sign-in, passwords and resets are Auth0's; this service never sees a password.
"""

from __future__ import annotations

import json
import threading
import time
from collections import defaultdict, deque
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from . import __version__
from .auth import AuthError, bearer_token
from .elevenlabs import ElevenLabsError
from .hosted import CONSENT_TEXT, CONSENT_VERSION, ClipsRejected, HostedError, HostedVoiceService
from .records import RecordError

MAX_FILES = 40
MAX_FILE_BYTES = 100 * 1024 * 1024  # a long recording or a video file; only its first 30 minutes are decoded
MAX_UPLOAD_BYTES = 200 * 1024 * 1024


class PatchIn(BaseModel):
    paused: Optional[bool] = None
    settings: Optional[dict] = None


class SpeakIn(BaseModel):
    text: str
    settings: Optional[dict] = None


class PrefsIn(BaseModel):
    preferences: dict
    version: Optional[int] = None


class RateLimiter:
    """Per-user sliding window, in memory. It protects the ElevenLabs quota from one runaway client; with several
    server instances each keeps its own count, so also set throttling at the gateway."""

    def __init__(self, per_minute: int):
        self.per_minute, self._hits, self._lock = per_minute, defaultdict(deque), threading.Lock()

    def check(self, user_id: str) -> Optional[int]:
        """None if allowed, else seconds to wait."""
        if self.per_minute <= 0:
            return None
        now = time.monotonic()
        with self._lock:
            q = self._hits[user_id]
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= self.per_minute:
                return max(1, int(60 - (now - q[0])) + 1)
            q.append(now)
            return None


def create_hosted_app(
    service: HostedVoiceService,
    auth,
    cors_origins=(),
    speak_per_minute: int = 60,
    users=None,
) -> FastAPI:
    app = FastAPI(title="VocalEyes hosted voice", version=__version__, docs_url=None, redoc_url=None)
    limiter = RateLimiter(speak_per_minute)
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cors_origins),
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "X-User-Id"],  # X-User-Id is the dev login; the jwt login ignores it
            expose_headers=["X-Render-Ms", "X-Model-Id", "X-Ai-Assisted"],
        )

    def user(request: Request) -> str:
        return auth.user_id(request)

    @app.exception_handler(AuthError)
    async def _auth(_: Request, e: AuthError):
        return JSONResponse(status_code=401, content={"error": str(e)}, headers={"WWW-Authenticate": "Bearer"})

    @app.exception_handler(HostedError)
    async def _hosted(_: Request, e: HostedError):
        body = {"error": str(e)}
        if isinstance(e, ClipsRejected):
            body["skippedClips"] = e.skipped
        return JSONResponse(status_code=e.status, content=body)

    @app.exception_handler(RecordError)
    async def _record(_: Request, e: RecordError):
        return JSONResponse(status_code=e.status, content={"error": str(e)})

    @app.exception_handler(ElevenLabsError)
    async def _eleven(_: Request, e: ElevenLabsError):
        return JSONResponse(status_code=e.status, content={"error": str(e)}, headers={"Retry-After": e.retry_after} if e.retry_after else {})

    if users is not None:
        from .users import UserError

        @app.exception_handler(UserError)
        async def _user(_: Request, e: UserError):
            return JSONResponse(status_code=e.status, content={"error": str(e)})

        add_user_routes(app, users, user)

    @app.get("/health")
    def health():
        return {"ok": True, "provider": "elevenlabs", "auth": auth.name, "version": __version__}

    @app.get("/v1/consent-text")
    def consent_text():
        return {"version": CONSENT_VERSION, "statements": CONSENT_TEXT}

    @app.get("/v1/me/voice")
    def get_voice(uid: str = Depends(user)):
        return {"voice": service.get(uid).public()}

    @app.post("/v1/me/voice", status_code=201)
    async def create_voice(uid: str = Depends(user), consent: str = Form(...), files: "list[UploadFile]" = File(...)):
        try:
            consent_obj = json.loads(consent)
        except ValueError:
            raise HostedError("consent must be a JSON object")
        if len(files) > MAX_FILES:
            raise HostedError(f"at most {MAX_FILES} files")
        uploads, total = [], 0
        for f in files:
            data = await f.read(MAX_FILE_BYTES + 1)  # one byte over the cap is enough to refuse it, without buffering a huge upload
            if len(data) > MAX_FILE_BYTES:
                raise HostedError(f"a file is over {MAX_FILE_BYTES // (1024 * 1024)} MB")
            total += len(data)
            if total > MAX_UPLOAD_BYTES:
                raise HostedError(f"upload is over {MAX_UPLOAD_BYTES // (1024 * 1024)} MB in total")
            uploads.append(((f.filename or "clip").rsplit(".", 1)[0][:60], data))
        record, skipped = service.create(uid, consent_obj, uploads)
        return {"voice": record.public(), "skippedClips": skipped}

    @app.patch("/v1/me/voice")
    def patch_voice(body: PatchIn, uid: str = Depends(user)):
        if body.settings is None and body.paused is None:
            raise HostedError("send settings and/or paused")
        record = None
        if body.settings is not None:
            record = service.update_settings(uid, body.settings)
        if body.paused is not None:
            record = service.set_paused(uid, body.paused)
        return {"voice": record.public()}

    @app.post("/v1/me/voice/speak")
    def speak(body: SpeakIn, uid: str = Depends(user)):
        wait = limiter.check(uid)
        if wait is not None:
            return JSONResponse(status_code=429, content={"error": "too many requests, slow down"}, headers={"Retry-After": str(wait)})
        audio, ctype, info = service.speak(uid, body.text, body.settings)
        return Response(
            audio,
            media_type=ctype,
            headers={"X-Render-Ms": str(info["renderMs"]), "X-Model-Id": info["modelId"], "X-Ai-Assisted": "true", "Cache-Control": "no-store"},
        )

    @app.delete("/v1/me/voice")
    def delete_voice(uid: str = Depends(user)):
        service.delete(uid)
        return {"deleted": True}

    return app


def add_user_routes(app: FastAPI, users, user) -> None:
    """Profile and preferences for the signed-in person (the token's sub). See users.py."""

    @app.get("/v1/me")
    def me(request: Request, uid: str = Depends(user)):
        try:
            token = bearer_token(request)
        except AuthError:
            token = None  # the dev login on a laptop: no Auth0 profile to fetch
        return {"user": users.me(uid, token).public()}

    @app.get("/v1/me/preferences")
    def get_prefs(uid: str = Depends(user)):
        return users.get_prefs(uid).public()

    @app.put("/v1/me/preferences")
    def put_prefs(body: PrefsIn, uid: str = Depends(user)):
        return users.put_prefs(uid, body.preferences, body.version).public()
