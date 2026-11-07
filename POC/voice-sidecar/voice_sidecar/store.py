"""On-disk voice profiles: consent record, clips, embedding.

Layout, under <data_dir>/profiles/<profileId>/:
  consent.json    who agreed, when (written first; nothing else is stored without it)
  meta.json       clips (name, label, quality report), builds {engine: version}, paused
  clips/clip-NNN.wav
  embedding.pth   the OpenVoice voice embedding; other engines write embedding-<engine>.pt (written by the engine)

Delete removes the whole directory. Profile ids are random hex, validated on every access so a
caller can never walk outside the profiles directory.
"""

from __future__ import annotations

import io
import json
import os
import re
import secrets
import shutil
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

PROFILE_ID = re.compile(r"^[0-9a-f]{32}$")
CLIP_NAME = re.compile(r"^clip-\d{3}\.wav$")
ENGINE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
LEGACY_ENGINE = "openvoice-v2"  # profiles made before engines were tracked were all OpenVoice
LABEL_MAX = 80


class StoreError(Exception):
    """Base class: `status` is the HTTP status the API should answer with."""

    status = 400


class NotFound(StoreError):
    status = 404


class ConsentError(StoreError):
    status = 422


@dataclass
class Consent:
    mode: str  # "self" or "authorized"
    acknowledged: bool
    authorized_by: Optional[str] = None

    def validate(self) -> None:
        if self.mode not in ("self", "authorized"):
            raise ConsentError('consent.mode must be "self" or "authorized"')
        if self.acknowledged is not True:
            raise ConsentError("the voice owner must acknowledge: this is my own voice, or I have the owner's permission")
        if self.mode == "authorized" and not (self.authorized_by or "").strip():
            raise ConsentError("authorized consent needs the name of the voice owner who gave permission")


def _atomic_write(path: Path, data: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    os.replace(tmp, path)


class ProfileStore:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "profiles"
        self.root.mkdir(parents=True, exist_ok=True)

    # ---- paths ----

    def dir(self, pid: str) -> Path:
        if not PROFILE_ID.match(pid or ""):
            raise NotFound("no such profile")
        d = self.root / pid
        if not d.is_dir():
            raise NotFound("no such profile")
        return d

    def embedding_path(self, pid: str, engine: str = LEGACY_ENGINE) -> Path:
        """One voice file per engine: they are not interchangeable. OpenVoice keeps its original filename."""
        if not ENGINE_NAME.match(engine):
            raise NotFound("no such engine")
        return self.dir(pid) / ("embedding.pth" if engine == LEGACY_ENGINE else f"embedding-{engine}.pt")

    def clip_paths(self, pid: str) -> list[Path]:
        return [self.dir(pid) / "clips" / c["name"] for c in self.meta(pid)["clips"]]

    # ---- create / read ----

    def create(self, consent: Consent) -> str:
        consent.validate()
        pid = secrets.token_hex(16)
        d = self.root / pid
        (d / "clips").mkdir(parents=True)
        record = {
            "profileId": pid,
            "mode": consent.mode,
            "ts": int(time.time() * 1000),
            **({"authorizedBy": consent.authorized_by.strip()} if consent.mode == "authorized" and consent.authorized_by else {}),
        }
        # Consent first, so a half-created profile can never exist without it.
        _atomic_write(d / "consent.json", json.dumps(record, indent=2))
        _atomic_write(d / "meta.json", json.dumps({"clips": [], "builds": {}, "versions": {}, "paused": False, "nextClip": 1}, indent=2))
        return pid

    def consent(self, pid: str) -> dict:
        try:
            c = json.loads((self.dir(pid) / "consent.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise ConsentError("this profile has no valid consent record")
        if c.get("profileId") != pid or c.get("mode") not in ("self", "authorized"):
            raise ConsentError("this profile has no valid consent record")
        return c

    def meta(self, pid: str) -> dict:
        m = json.loads((self.dir(pid) / "meta.json").read_text(encoding="utf-8"))
        if "builds" not in m:  # profile written before engines were tracked: it was built (or not) with OpenVoice
            legacy = int(m.get("embeddingVersion", 0))
            m["builds"] = {LEGACY_ENGINE: legacy} if m.get("built") else {}
            m["versions"] = {LEGACY_ENGINE: legacy} if legacy else {}
        m.setdefault("versions", {})
        m.pop("built", None)
        m.pop("embeddingVersion", None)
        return m

    def _save_meta(self, pid: str, meta: dict) -> None:
        _atomic_write(self.dir(pid) / "meta.json", json.dumps(meta, indent=2))

    def list_ids(self) -> list[str]:
        return sorted(p.name for p in self.root.iterdir() if p.is_dir() and PROFILE_ID.match(p.name))

    def status(self, pid: str, engine: str = LEGACY_ENGINE) -> dict:
        """Profile state as seen by `engine`: a voice built with another engine does not count as built."""
        consent = self.consent(pid)  # raises if consent is missing
        m = self.meta(pid)
        return {
            "profileId": pid,
            "consent": consent,
            "clips": m["clips"],
            "referenceSeconds": round(sum(c["report"]["seconds"] for c in m["clips"]), 1),
            "built": engine in m["builds"],
            "embeddingVersion": m["builds"].get(engine, 0),
            "builtWith": sorted(m["builds"]),
            "paused": m["paused"],
        }

    # ---- clips ----

    def add_clip(self, pid: str, label: str, samples, sr: int, report: dict, write_wav) -> dict:
        self.consent(pid)
        m = self.meta(pid)
        name = f"clip-{m['nextClip']:03d}.wav"
        write_wav(self.dir(pid) / "clips" / name, samples, sr)
        clip = {"name": name, "label": re.sub(r"[^\w .,'!?()-]", "", label or "")[:LABEL_MAX] or name, "report": report, "addedAt": int(time.time() * 1000)}
        m["clips"].append(clip)
        m["nextClip"] += 1
        m["builds"] = {}  # every voice built from the old clip set is now stale
        self._save_meta(pid, m)
        return clip

    def clip_file(self, pid: str, name: str) -> Path:
        if not CLIP_NAME.match(name or ""):
            raise NotFound("no such clip")
        p = self.dir(pid) / "clips" / name
        if not p.is_file():
            raise NotFound("no such clip")
        return p

    def delete_clip(self, pid: str, name: str) -> None:
        p = self.clip_file(pid, name)
        m = self.meta(pid)
        m["clips"] = [c for c in m["clips"] if c["name"] != name]
        m["builds"] = {}
        p.unlink()
        self._save_meta(pid, m)

    # ---- embedding / state ----

    def mark_built(self, pid: str, engine: str = LEGACY_ENGINE) -> int:
        """Record a fresh build. The version only ever goes up, even when clips change in between, so
        anything cached against an old voice (rendered audio) can never match a rebuilt one."""
        m = self.meta(pid)
        m["versions"][engine] = m["versions"].get(engine, 0) + 1
        m["builds"][engine] = m["versions"][engine]
        self._save_meta(pid, m)
        return m["versions"][engine]

    def set_paused(self, pid: str, paused: bool) -> None:
        m = self.meta(pid)
        m["paused"] = bool(paused)
        self._save_meta(pid, m)

    # ---- export / delete ----

    def export_zip(self, pid: str) -> bytes:
        d = self.dir(pid)
        self.consent(pid)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(d.rglob("*")):
                if f.is_file() and not f.name.endswith(".tmp"):
                    z.write(f, f.relative_to(d).as_posix())
        return buf.getvalue()

    def delete(self, pid: str) -> None:
        """Permanently remove the profile: clips, embedding, consent record. Not recoverable."""
        shutil.rmtree(self.dir(pid))
