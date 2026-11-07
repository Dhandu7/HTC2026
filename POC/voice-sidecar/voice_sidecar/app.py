"""HTTP API. Bound to 127.0.0.1 and guarded by a shared token: only the app that launched the
sidecar can use it. Endpoints:

  GET    /health                          no auth. {ok, engine, device, warm}
  GET    /ui                              no auth. The browser page for recording and testing a voice
  POST   /v1/profiles                     {consent:{mode, acknowledged, authorizedBy?}} -> {profileId}
  GET    /v1/profiles/{id}                clips with quality reports, built?, paused?
  PATCH  /v1/profiles/{id}                {paused}
  POST   /v1/profiles/{id}/clips          multipart: file (any audio/video format), label? -> {clips, skipped, split}; recordings over 60 s are split at pauses
  GET    /v1/profiles/{id}/clips/{name}   the stored clip (WAV), to audition it
  DELETE /v1/profiles/{id}/clips/{name}
  POST   /v1/profiles/{id}/build          train the voice embedding from the clips
  POST   /v1/synthesize                   {profileId, text, pace?, tau?, raw?, base?} -> audio/wav
  GET    /v1/profiles/{id}/export         zip of clips, embedding and consent record
  DELETE /v1/profiles/{id}                permanently delete everything for this voice
"""

from __future__ import annotations

import secrets
import threading
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings
from .engine import Engine, make_engine
from .service import ClipRejected, VoiceService
from .store import Consent, ProfileStore, StoreError

STATIC = Path(__file__).resolve().parent.parent / "static"


class ConsentIn(BaseModel):
    mode: str
    acknowledged: bool = False
    authorizedBy: Optional[str] = None


class CreateProfileIn(BaseModel):
    consent: ConsentIn


class PatchProfileIn(BaseModel):
    paused: bool


class SynthIn(BaseModel):
    profileId: str
    text: str
    pace: float = Field(1.0, description="speaking rate, 0.8 to 1.2")
    tau: float = Field(0.3, description="randomness in the voice converter, 0.1 to 0.6. Not a similarity control: measured to change similarity by under 0.01")
    base: str = Field("EN-US", description="stock voice the result is built on; it sets accent, rhythm and intonation (see /health bases)")
    raw: bool = Field(False, description="return the stock base voice, before conversion (for A/B)")


def create_app(settings: Optional[Settings] = None, engine: Optional[Engine] = None, warm_in_background: bool = True) -> FastAPI:
    settings = settings or Settings()
    engine = engine or make_engine(settings)
    store = ProfileStore(settings.data_dir)
    svc = VoiceService(settings, store, engine)

    app = FastAPI(title="VocalEyes voice sidecar", version=__version__, docs_url=None, redoc_url=None)
    app.state.settings, app.state.service, app.state.engine = settings, svc, engine
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Sidecar-Token"],
        expose_headers=["X-Render-Ms", "X-Base-Ms", "X-Convert-Ms", "X-Ai-Assisted", "X-Embedding-Version"],
    )

    def auth(authorization: Optional[str] = Header(None), x_sidecar_token: Optional[str] = Header(None)) -> None:
        given = x_sidecar_token or (authorization[7:] if authorization and authorization.lower().startswith("bearer ") else "")
        if not given or not secrets.compare_digest(given, settings.token):
            raise HTTPException(status_code=401, detail="missing or wrong token")

    @app.exception_handler(StoreError)
    async def store_error(_: Request, e: StoreError):
        body = {"error": str(e)}
        if isinstance(e, ClipRejected):
            body["report"] = e.report
        return JSONResponse(status_code=e.status, content=body)

    # ---- unauthenticated: liveness and the static page (it holds no secrets) ----

    @app.get("/health")
    def health():
        return {"ok": True, "engine": engine.name, "device": engine.device, "warm": engine.warm, "version": __version__, "bases": engine.bases}

    @app.get("/ui", response_class=HTMLResponse)
    def ui():
        return (STATIC / "test.html").read_text(encoding="utf-8")

    # ---- profiles ----

    @app.post("/v1/profiles", dependencies=[Depends(auth)])
    def create_profile(body: CreateProfileIn):
        c = body.consent
        pid = svc.create_profile(Consent(mode=c.mode, acknowledged=c.acknowledged, authorized_by=c.authorizedBy))
        return {"profileId": pid}

    @app.get("/v1/profiles/{pid}", dependencies=[Depends(auth)])
    def get_profile(pid: str):
        return svc.status(pid)

    @app.patch("/v1/profiles/{pid}", dependencies=[Depends(auth)])
    def patch_profile(pid: str, body: PatchProfileIn):
        return svc.set_paused(pid, body.paused)

    @app.delete("/v1/profiles/{pid}", dependencies=[Depends(auth)])
    def delete_profile(pid: str):
        svc.delete_profile(pid)
        return {"deleted": True}

    @app.get("/v1/profiles/{pid}/export", dependencies=[Depends(auth)])
    def export_profile(pid: str):
        return Response(store.export_zip(pid), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="voice-{pid[:8]}.zip"'})

    # ---- training ----

    @app.post("/v1/profiles/{pid}/clips", dependencies=[Depends(auth)])
    async def add_clip(pid: str, file: UploadFile = File(...), label: str = Form("")):
        # Read at most one byte over the cap so a huge upload cannot fill memory.
        data = await file.read(settings.max_upload_bytes + 1)
        return svc.add_clip(pid, label or (file.filename or ""), data)

    @app.get("/v1/profiles/{pid}/clips/{name}", dependencies=[Depends(auth)])
    def get_clip(pid: str, name: str):
        store.consent(pid)
        return Response(store.clip_file(pid, name).read_bytes(), media_type="audio/wav", headers={"Cache-Control": "no-store"})

    @app.delete("/v1/profiles/{pid}/clips/{name}", dependencies=[Depends(auth)])
    def delete_clip(pid: str, name: str):
        store.delete_clip(pid, name)
        return svc.status(pid)

    @app.post("/v1/profiles/{pid}/build", dependencies=[Depends(auth)])
    def build(pid: str):
        return svc.build(pid)

    # ---- speaking ----

    @app.post("/v1/synthesize", dependencies=[Depends(auth)])
    def synthesize(body: SynthIn):
        import time

        t0 = time.perf_counter()
        wav, info = svc.synthesize(body.profileId, body.text, body.pace, body.tau, body.raw, body.base)
        return Response(
            wav,
            media_type="audio/wav",
            headers={
                "X-Render-Ms": str(round((time.perf_counter() - t0) * 1000)),
                "X-Base-Ms": str(info["baseMs"]),
                "X-Convert-Ms": str(info["convertMs"]),
                "X-Embedding-Version": str(info["embeddingVersion"]),
                # Cloned speech is always labelled; the app shows this to the listener.
                "X-Ai-Assisted": "false" if body.raw else "true",
                "Cache-Control": "no-store",
            },
        )

    if warm_in_background:
        threading.Thread(target=_warm, args=(engine,), daemon=True).start()
    return app


def _warm(engine: Engine) -> None:
    try:
        engine.warm_up()
    except Exception as e:  # keep serving: /health reports warm=false and synth surfaces the real error
        print(f"[voice-sidecar] warm-up failed: {e}")
