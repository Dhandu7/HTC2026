"""The rules, independent of HTTP. Both the API (app.py) and the CLI (cli.py) call this."""

from __future__ import annotations

from typing import Optional

from .audio import AudioError, analyze, load_audio, write_wav
from .config import Settings
from .engine import Engine, EngineError
from .store import Consent, ConsentError, ProfileStore, StoreError

PACE_RANGE = (0.8, 1.2)
TAU_RANGE = (0.1, 0.6)


class BadRequest(StoreError):
    status = 400


class ClipRejected(StoreError):
    status = 422

    def __init__(self, report: dict):
        super().__init__("; ".join(report["errors"]))
        self.report = report


class Conflict(StoreError):
    status = 409


class Locked(StoreError):
    status = 423


class TooLarge(StoreError):
    status = 413


def _clamp(v: float, lo_hi) -> float:
    lo, hi = lo_hi
    return max(lo, min(hi, float(v)))


class VoiceService:
    def __init__(self, settings: Settings, store: ProfileStore, engine: Engine):
        self.settings = settings
        self.store = store
        self.engine = engine

    # ---- profiles ----

    def create_profile(self, consent: Consent) -> str:
        return self.store.create(consent)

    def status(self, pid: str) -> dict:
        return self.store.status(pid)

    def set_paused(self, pid: str, paused: bool) -> dict:
        self.store.consent(pid)
        self.store.set_paused(pid, paused)
        return self.store.status(pid)

    def delete_profile(self, pid: str) -> None:
        self.store.delete(pid)

    # ---- training ----

    def add_clip(self, pid: str, label: str, data: bytes) -> dict:
        self.store.consent(pid)
        if len(data) > self.settings.max_upload_bytes:
            raise TooLarge(f"file is over {self.settings.max_upload_bytes // (1024 * 1024)} MB")
        try:
            samples, sr = load_audio(data)
        except AudioError as e:
            raise ClipRejected({"errors": [str(e)], "warnings": []})
        report = analyze(samples, sr)
        if not report.ok:
            raise ClipRejected(report.to_dict())
        return self.store.add_clip(pid, label, samples, sr, report.to_dict(), write_wav)

    def build(self, pid: str) -> dict:
        """Build the voice embedding from this profile's clips (newest first, up to the reference cap)."""
        self.store.consent(pid)
        clips = self.store.meta(pid)["clips"]
        if not clips:
            raise Conflict("add at least one clip before building the voice")
        chosen, seconds = [], 0.0
        for c in reversed(clips):
            if seconds >= self.settings.max_reference_seconds:
                break
            chosen.append(c)
            seconds += c["report"]["seconds"]
        paths = [self.store.clip_file(pid, c["name"]) for c in chosen]
        try:
            info = self.engine.build_embedding(paths, self.store.embedding_path(pid))
        except EngineError as e:
            raise Conflict(str(e))
        version = self.store.mark_built(pid)
        return {"embeddingVersion": version, "clipsUsed": len(chosen), "referenceSeconds": round(seconds, 1), **info}

    # ---- speaking ----

    def synthesize(self, pid: str, text: str, pace: float = 1.0, tau: float = 0.3, raw: bool = False) -> "tuple[bytes, dict]":
        self.store.consent(pid)  # no consent record, no audio: ConsentError
        status = self.store.status(pid)
        if status["paused"]:
            raise Locked("this voice is paused")
        text = (text or "").strip()
        if not text:
            raise BadRequest("text is empty")
        if len(text) > self.settings.max_text_chars:
            raise BadRequest(f"text is over {self.settings.max_text_chars} characters")
        if not raw and not status["built"]:
            raise Conflict("this voice has not been built yet: add clips and build it first")
        try:
            wav, timing = self.engine.synthesize(
                text, self.store.embedding_path(pid), _clamp(pace, PACE_RANGE), _clamp(tau, TAU_RANGE), raw
            )
        except EngineError as e:
            raise Conflict(str(e))
        return wav, {**timing, "embeddingVersion": status["embeddingVersion"], "raw": raw}
