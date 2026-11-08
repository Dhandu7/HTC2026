"""The hosted voice flows: create a voice from clips, speak, change settings, pause, delete.

Rules this layer enforces (each has a test):
  - No voice without explicit consent, including that recordings and text go to ElevenLabs.
  - A user can only reach their own voice: every call takes the authenticated user id, never a voice id.
  - Slot reservation, the ElevenLabs call and the record update fail safe: a failed clone frees its slot,
    and a delete only completes once ElevenLabs confirmed it (otherwise it stays `deleting` and is retried).
  - Recordings are not kept: they are uploaded to ElevenLabs and only metadata is stored.
  - Request text and audio are never logged.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from .audio import AudioError, analyze, load_audio, split_at_pauses, wav_bytes
from .elevenlabs import ElevenLabsClient, ElevenLabsError, RemoteVoiceMissing, VoiceNeedsVerification
from .records import PROVIDER, RecordError, VoiceRecord, VoiceRecordStore, utc_now

log = logging.getLogger("voice.hosted")

CONSENT_VERSION = "2026-11-hosted-v1"
#: Shown to the person before they create a voice, and echoed back as consentVersion so we know which text they saw.
CONSENT_TEXT = [
    "This is my own voice, or the voice owner has given me permission to clone it.",
    "My recordings will be sent to ElevenLabs, a third-party service, to create a voice. The text I speak is also sent to ElevenLabs to make the audio.",
    "ElevenLabs may keep generated audio in its history. Zero-retention mode is offered by ElevenLabs only to enterprise customers.",
    "I can delete this voice at any time. VocalEyes asks ElevenLabs to delete it and removes its own record; anything ElevenLabs has already stored is covered by ElevenLabs' own policies.",
    "Speech made with this voice is AI-generated and will be labelled that way.",
]

ALLOWED_MODELS = ("eleven_flash_v2_5", "eleven_v4_turbo", "eleven_flash_v2", "eleven_multilingual_v2", "eleven_v4", "eleven_v3", "eleven_v3_conversational")
DEFAULT_SETTINGS = {"modelId": "eleven_flash_v2_5", "stability": 0.5, "similarityBoost": 0.75, "style": 0.0, "speed": 1.0, "useSpeakerBoost": True}
#: speed has no documented range in ElevenLabs' reference; 0.7 to 1.2 is the range we allow and ElevenLabs may narrow it.
RANGES = {"stability": (0.0, 1.0), "similarityBoost": (0.0, 1.0), "style": (0.0, 1.0), "speed": (0.7, 1.2)}

MAX_CLIPS = 25
MAX_REFERENCE_SECONDS = 300.0
MIN_TOTAL_SECONDS = 10.0
MAX_TEXT_CHARS = 1000


class HostedError(Exception):
    status = 400


class ConsentRequired(HostedError):
    status = 422


class ClipsRejected(HostedError):
    status = 422

    def __init__(self, message: str, skipped: list):
        super().__init__(message)
        self.skipped = skipped


class VoiceNotFound(HostedError):
    status = 404


class VoiceNotReady(HostedError):
    status = 409


class VoicePaused(HostedError):
    status = 423


class DeleteIncomplete(HostedError):
    status = 502


class NeedsVerification(HostedError):
    """The voice exists but ElevenLabs will not let it speak until its owner verifies it there."""

    status = 409


def verification_message(voice_name: str) -> str:
    return (
        "ElevenLabs needs you to verify this voice before it can speak. Sign in to elevenlabs.io, open Voices, find the voice "
        f"named '{voice_name}', and complete its verification (you read a short phrase aloud so ElevenLabs can confirm the voice "
        "is yours). Then try again here. If verification keeps failing, ElevenLabs support can help."
    )


@dataclass
class HostedConfig:
    slot_limit: int = 10
    output_format: str = "mp3_44100_128"
    default_model: str = "eleven_flash_v2_5"
    pending_stale_minutes: int = 10
    deleting_retry_minutes: int = 2


def validate_consent(c: dict, now: str) -> dict:
    """Return the consent record to store, or raise ConsentRequired. Nothing is created without all of these."""
    if not isinstance(c, dict):
        raise ConsentRequired("consent is required")
    if c.get("mode") not in ("self", "authorized"):
        raise ConsentRequired('consent.mode must be "self" or "authorized"')
    if c.get("acknowledged") is not True:
        raise ConsentRequired("the voice owner must confirm: this is my own voice, or I have the owner's permission")
    if c.get("remoteProcessingAcknowledged") is not True:
        raise ConsentRequired("you must confirm that recordings and text are sent to ElevenLabs")
    if c.get("consentVersion") != CONSENT_VERSION:
        raise ConsentRequired(f"the consent text has changed; show the current text and send consentVersion={CONSENT_VERSION!r}")
    by = (c.get("authorizedBy") or "").strip()
    if c["mode"] == "authorized" and not by:
        raise ConsentRequired("authorized consent needs the name of the voice owner who gave permission")
    out = {"mode": c["mode"], "acknowledgedAt": now, "consentVersion": CONSENT_VERSION, "remoteProcessingAcknowledged": True}
    if c["mode"] == "authorized":
        out["authorizedBy"] = by[:120]
    return out


def normalize_settings(patch: Optional[dict], base: Optional[dict] = None) -> dict:
    """Merge `patch` over `base`, clamping numbers to our ranges and rejecting unknown keys and models."""
    out = dict(base or DEFAULT_SETTINGS)
    for k, v in (patch or {}).items():
        if k == "modelId":
            if v not in ALLOWED_MODELS:
                raise HostedError(f"unknown model {v!r}; allowed: {', '.join(ALLOWED_MODELS)}")
            out[k] = v
        elif k == "useSpeakerBoost":
            if not isinstance(v, bool):
                raise HostedError("useSpeakerBoost must be true or false")
            out[k] = v
        elif k in RANGES:
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise HostedError(f"{k} must be a number")
            lo, hi = RANGES[k]
            out[k] = float(max(lo, min(hi, v)))
        else:
            raise HostedError(f"unknown setting {k!r}")
    return out


def prepare_clips(uploads: "list[tuple[str, bytes]]") -> "tuple[list[tuple[str, bytes]], list[dict], list[dict]]":
    """Check and normalize uploads. Returns (wav files to send, stored metadata, skipped reasons).
    Recordings over 60 s are split at pauses. Audio is not kept after upload; only this metadata is."""
    files, meta, skipped = [], [], []
    total = 0.0
    for label, data in uploads:
        try:
            samples, sr = load_audio(data)
        except AudioError as e:
            skipped.append({"label": label[:60], "errors": [str(e)]})
            continue
        pieces = split_at_pauses(samples, sr) if len(samples) / sr > 60 else [samples]
        for i, piece in enumerate(pieces):
            name = f"{label} (part {i + 1})" if len(pieces) > 1 else label
            r = analyze(piece, sr)
            if not r.ok:
                skipped.append({"label": name[:60], "errors": r.errors})
                continue
            if len(files) >= MAX_CLIPS or total >= MAX_REFERENCE_SECONDS:
                skipped.append({"label": name[:60], "errors": ["over the limit for one voice (25 clips or 5 minutes)"]})
                continue
            total += r.seconds
            files.append((f"clip-{len(files) + 1:02d}.wav", wav_bytes(piece, sr)))
            meta.append({"id": f"clip-{len(meta) + 1:02d}", "seconds": r.seconds, "rmsDb": r.rms_db, "warnings": r.warnings})
    return files, meta, skipped


class HostedVoiceService:
    def __init__(self, store: VoiceRecordStore, eleven: ElevenLabsClient, cfg: Optional[HostedConfig] = None, clock=utc_now):
        self.store, self.eleven, self.cfg, self._now = store, eleven, cfg or HostedConfig(), clock

    # ---- create ----

    def create(self, user_id: str, consent: dict, uploads: "list[tuple[str, bytes]]") -> "tuple[VoiceRecord, list[dict]]":
        """Validate consent and clips, reserve a slot, clone at ElevenLabs, activate. Returns (record, skipped clips)."""
        now = self._now()
        stored_consent = validate_consent(consent, now)
        files, meta, skipped = prepare_clips(uploads)
        total = sum(m["seconds"] for m in meta)
        if not files or total < MIN_TOTAL_SECONDS:
            raise ClipsRejected(f"need at least {MIN_TOTAL_SECONDS:.0f} seconds of usable speech (got {total:.0f} s from {len(files)} clip(s))", skipped)

        name = f"vocaleyes-{hashlib.sha256(user_id.encode()).hexdigest()[:12]}-{secrets.token_hex(3)}"
        self.store.reserve(user_id, stored_consent, name, normalize_settings({"modelId": self.cfg.default_model}), self.cfg.slot_limit)
        voice_id = None
        try:
            cloned = self.eleven.clone(name, files)
            voice_id = cloned.voice_id
            record = self.store.activate(user_id, voice_id, meta, cloned.requires_verification)
        except Exception as e:
            self._undo_create(user_id, name, voice_id, e)
            raise
        return record, skipped

    @staticmethod
    def _why(e: Exception) -> str:
        """A reason that is safe to log: our own error types carry plain messages with no request text or secrets;
        for anything else only the type is logged."""
        if isinstance(e, (ElevenLabsError, HostedError, RecordError)):
            return f"{type(e).__name__} (HTTP {getattr(e, 'status', '?')}): {e}"
        return type(e).__name__

    def _undo_create(self, user_id: str, name: str, voice_id: Optional[str], cause: Optional[Exception] = None) -> None:
        """A create that failed part-way must not leak a slot or an orphan voice."""
        if cause is not None:
            log.warning("create failed: %s", self._why(cause))
        if voice_id:
            try:
                self.eleven.delete_voice(voice_id)
            except RemoteVoiceMissing:
                pass
            except ElevenLabsError:
                # The voice exists at ElevenLabs but our record could not be completed. Keep the pending record
                # (and its slot) so the reconciler and a human can find it by name; do not silently drop it.
                log.error("orphaned ElevenLabs voice after failed create; name=%s", name)
                return
        else:
            log.warning("create failed before a voice id was known; if ElevenLabs created one, it is named %s", name)
        try:
            self.store.release(user_id)
        except RecordError:
            log.error("could not release the reservation for voice name %s", name)

    # ---- use ----

    def get(self, user_id: str) -> VoiceRecord:
        r = self.store.get(user_id)
        if r is None:
            raise VoiceNotFound("you do not have a voice yet")
        return r

    def speak(self, user_id: str, text: str, overrides: Optional[dict] = None) -> "tuple[bytes, str, dict]":
        r = self.get(user_id)
        if r.status == "paused":
            raise VoicePaused("this voice is paused")
        if r.status != "active" or not r.voice_id:
            raise VoiceNotReady(f"this voice is {r.status}")
        text = (text or "").strip()
        if not text:
            raise HostedError("text is empty")
        if len(text) > MAX_TEXT_CHARS:
            raise HostedError(f"text is over {MAX_TEXT_CHARS} characters")
        s = normalize_settings(overrides, r.settings)
        t0 = time.perf_counter()
        try:
            audio, ctype = self.eleven.synthesize(r.voice_id, text, s["modelId"], s, self.cfg.output_format)
        except VoiceNeedsVerification:
            if not r.needs_verification:
                self.store.update(user_id, needs_verification=True)
            raise NeedsVerification(verification_message(r.voice_name))
        if r.needs_verification:  # it just spoke, so it has been verified
            self.store.update(user_id, needs_verification=False)
        return audio, ctype, {"renderMs": round((time.perf_counter() - t0) * 1000), "modelId": s["modelId"]}

    def update_settings(self, user_id: str, patch: dict) -> VoiceRecord:
        r = self.get(user_id)
        return self.store.update(user_id, settings=normalize_settings(patch, r.settings))

    def set_paused(self, user_id: str, paused: bool) -> VoiceRecord:
        self.get(user_id)
        return self.store.update(user_id, paused=paused)

    # ---- delete ----

    def delete(self, user_id: str) -> None:
        """Mark deleting, delete at ElevenLabs, then remove our record. If ElevenLabs fails the voice stays
        `deleting` (it can no longer speak) and the reconciler retries; we never drop the record first."""
        r = self.store.begin_delete(user_id)
        self._finish_delete(r)

    def _finish_delete(self, r: VoiceRecord) -> None:
        if r.voice_id:
            try:
                self.eleven.delete_voice(r.voice_id)
            except RemoteVoiceMissing:
                pass  # already gone at ElevenLabs: that is what we wanted
            except ElevenLabsError as e:
                raise DeleteIncomplete("could not delete the voice at ElevenLabs; it is marked for deletion and will be retried") from e
        self.store.finish_delete(r.user_id)

    # ---- reconciler (run on a schedule) ----

    def reconcile(self) -> dict:
        """Retry stuck deletes and release stale pending reservations. Safe to run repeatedly."""
        cut = lambda minutes: (datetime.fromisoformat(self._now()) - timedelta(minutes=minutes)).isoformat(timespec="milliseconds")
        out = {"deleted": 0, "deleteFailed": 0, "releasedPending": 0}
        for r in self.store.list_by_status("deleting", older_than=cut(self.cfg.deleting_retry_minutes)):
            try:
                self._finish_delete(r)
                out["deleted"] += 1
            except HostedError:
                out["deleteFailed"] += 1
                log.error("delete still failing for voice name %s", r.voice_name)
        for r in self.store.list_by_status("pending", older_than=cut(self.cfg.pending_stale_minutes)):
            try:
                self.store.release(r.user_id)
                out["releasedPending"] += 1
                log.warning("released stale pending reservation; if ElevenLabs created a voice it is named %s", r.voice_name)
            except RecordError:
                pass
        return out
