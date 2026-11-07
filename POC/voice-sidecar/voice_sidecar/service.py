"""The rules, independent of HTTP. Both the API (app.py) and the CLI (cli.py) call this."""

from __future__ import annotations

from typing import Optional

from .audio import AudioError, analyze, load_audio, split_at_pauses, write_wav
from .config import Settings
from .engine import Engine, EngineError
from .store import Consent, ConsentError, ProfileStore, StoreError

PACE_RANGE = (0.8, 1.2)
TAU_RANGE = (0.1, 0.6)
EXAGGERATION_RANGE = (0.25, 1.5)  # Chatterbox: expressiveness; 0.5 is the default
CFG_RANGE = (0.0, 1.0)  # Chatterbox: how closely it follows the reference's pacing
#: A clip whose voice is this dissimilar from the average of all clips is flagged as possibly another speaker.
SIMILARITY_FLAG = 0.8


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
        return self.store.status(pid, self.engine.name)

    def set_paused(self, pid: str, paused: bool) -> dict:
        self.store.consent(pid)
        self.store.set_paused(pid, paused)
        return self.store.status(pid, self.engine.name)

    def delete_profile(self, pid: str) -> None:
        self.store.delete(pid)

    # ---- training ----

    MAX_SEGMENTS = 40  # per upload, so a one-hour podcast does not become 240 clips

    def add_clip(self, pid: str, label: str, data: bytes) -> dict:
        """Add audio to a profile. A normal clip is stored as is. A long recording (over 60 s) is split
        at pauses into pieces of about 15 s; pieces that fail the quality checks are skipped and
        reported. Returns {"clips": [...stored], "skipped": [{label, errors}], "split": bool}."""
        self.store.consent(pid)
        if len(data) > self.settings.max_upload_bytes:
            raise TooLarge(f"file is over {self.settings.max_upload_bytes // (1024 * 1024)} MB")
        try:
            samples, sr = load_audio(data)
        except AudioError as e:
            raise ClipRejected({"errors": [str(e)], "warnings": []})
        split = len(samples) / sr > 60.0
        pieces = split_at_pauses(samples, sr) if split else [samples]
        stored, skipped = [], []
        for i, piece in enumerate(pieces):
            name = f"{label} (part {i + 1})" if split else label
            report = analyze(piece, sr)
            if not report.ok:
                if not split:
                    raise ClipRejected(report.to_dict())
                skipped.append({"label": name, "errors": report.errors})
                continue
            if len(stored) >= self.MAX_SEGMENTS:
                skipped.append({"label": name, "errors": [f"over the limit of {self.MAX_SEGMENTS} pieces per file"]})
                continue
            stored.append(self.store.add_clip(pid, name, piece, sr, report.to_dict(), write_wav))
        if not stored:
            raise ClipRejected({"errors": ["no usable speech found in this file"] + sorted({e for s in skipped for e in s["errors"]})[:3], "warnings": []})
        return {"clips": stored, "skipped": skipped, "split": split}

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
            info = self.engine.build_embedding(paths, self.store.embedding_path(pid, self.engine.name))
        except EngineError as e:
            raise Conflict(str(e))
        version = self.store.mark_built(pid, self.engine.name)
        out = {"embeddingVersion": version, "clipsUsed": len(chosen), "referenceSeconds": round(seconds, 1), **info}
        # Flag clips that do not sound like the rest (another speaker in an interview, a different room).
        # Reported, never removed automatically: the thresholds are not validated on real data yet.
        if len(chosen) >= 3:
            sims = self.engine.clip_similarity(paths)
            out["similarity"] = [{"clip": c["name"], "label": c["label"], "similarity": v} for c, v in zip(chosen, sims)]
            out["flagged"] = [x["clip"] for x in out["similarity"] if x["similarity"] < SIMILARITY_FLAG]
        return out

    # ---- speaking ----

    def synthesize(self, pid: str, text: str, pace: float = 1.0, tau: float = 0.3, raw: bool = False, base: str = "EN-US", exaggeration: float = 0.5, cfg_weight: float = 0.5) -> "tuple[bytes, dict]":
        self.store.consent(pid)  # no consent record, no audio: ConsentError
        status = self.store.status(pid, self.engine.name)
        if status["paused"]:
            raise Locked("this voice is paused")
        text = (text or "").strip()
        if not text:
            raise BadRequest("text is empty")
        if len(text) > self.settings.max_text_chars:
            raise BadRequest(f"text is over {self.settings.max_text_chars} characters")
        if not raw and not status["built"]:
            raise Conflict(f"this voice has not been built with {self.engine.name} yet: add clips and press Build" + (f" (it was built with: {', '.join(status['builtWith'])})" if status["builtWith"] else ""))
        try:
            wav, timing = self.engine.synthesize(
                text, self.store.embedding_path(pid, self.engine.name), _clamp(pace, PACE_RANGE), _clamp(tau, TAU_RANGE), raw, base,
                exaggeration=_clamp(exaggeration, EXAGGERATION_RANGE), cfg_weight=_clamp(cfg_weight, CFG_RANGE),
            )
        except EngineError as e:
            raise Conflict(str(e))
        return wav, {**timing, "embeddingVersion": status["embeddingVersion"], "raw": raw, "base": base}
