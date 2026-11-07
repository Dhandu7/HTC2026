"""A small ElevenLabs client: create a voice from clips, speak text in it, delete it.

Endpoints and fields, from ElevenLabs' API reference (read 7 Nov 2026):
  POST   /v1/voices/add                    multipart: name, files[], remove_background_noise?, description?  -> {voice_id}
  POST   /v1/text-to-speech/{voice_id}     query output_format; json {text, model_id, voice_settings{...}}   -> audio bytes
  DELETE /v1/voices/{voice_id}                                                                               -> {status:"ok"}
  GET    /v1/user/subscription                       -> {tier, status, voice_limit, voice_slots_used, can_use_instant_voice_cloning, ...}
Authentication is the `xi-api-key` header. The key is only ever sent there: it is never logged, never put in a
URL, and never included in an error message. Request text and audio are not logged either.
"""

from __future__ import annotations

import re
from typing import Optional

import httpx

DEFAULT_BASE_URL = "https://api.elevenlabs.io"  # regional endpoints (US, EU, India, Singapore) exist: set ELEVENLABS_BASE_URL
VOICE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


KEY_SHAPE_WARNING = (
    "the key does not start with 'sk_'. ElevenLabs API keys do, so this is probably the key's ID (shown in the key list), "
    "not the key itself. The key is shown only once, when you create or rotate it: make a new one and copy that value."
)


def key_shape_warning(key: str) -> "Optional[str]":
    """A warning if `key` does not look like an ElevenLabs API key, else None. Never includes the value."""
    return None if key.strip().startswith("sk_") else KEY_SHAPE_WARNING


class ElevenLabsError(Exception):
    """`status` is the HTTP status our API should answer with; `message` is safe to show a user."""

    def __init__(self, message: str, status: int = 502, retry_after: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class RemoteVoiceMissing(ElevenLabsError):
    """The voice is already gone at ElevenLabs (404). For a delete that is the outcome we wanted."""


def _detail(resp: httpx.Response) -> str:
    """The `msg` strings of a 422, nothing else: the `input` field of a validation error can echo user text."""
    try:
        d = resp.json().get("detail")
    except Exception:
        return ""
    if isinstance(d, list):
        return "; ".join(str(x.get("msg", "")) for x in d if isinstance(x, dict))[:300]
    if isinstance(d, dict):
        return str(d.get("message", ""))[:300]
    return ""


def _raise_for(resp: httpx.Response, what: str) -> None:
    code = resp.status_code
    if code < 400:
        return
    if code == 404:
        raise RemoteVoiceMissing(f"{what}: not found at ElevenLabs", 404)
    if code in (401, 403):
        raise ElevenLabsError(f"{what}: ElevenLabs refused the request (check the API key, its permissions and the plan)", 502)
    if code == 422 or code == 400:
        d = _detail(resp)
        raise ElevenLabsError(f"{what}: ElevenLabs rejected the input" + (f" ({d})" if d else ""), 400)
    if code == 429:
        raise ElevenLabsError(f"{what}: ElevenLabs is rate limiting us, try again shortly", 429, resp.headers.get("retry-after"))
    raise ElevenLabsError(f"{what}: ElevenLabs returned an error (HTTP {code})", 502)


class ElevenLabsClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, timeout: float = 30.0, transport: Optional[httpx.BaseTransport] = None):
        if not api_key:
            raise ValueError("an ElevenLabs API key is required")
        self._headers = {"xi-api-key": api_key}
        self._http = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport)

    def close(self) -> None:
        self._http.close()

    def _send(self, what: str, method: str, url: str, **kw) -> httpx.Response:
        try:
            resp = self._http.request(method, url, headers=self._headers, **kw)
        except httpx.TimeoutException:
            raise ElevenLabsError(f"{what}: ElevenLabs timed out", 504)
        except httpx.HTTPError:
            raise ElevenLabsError(f"{what}: could not reach ElevenLabs", 502)
        _raise_for(resp, what)
        return resp

    @staticmethod
    def _voice(voice_id: str) -> str:
        if not VOICE_ID.match(voice_id or ""):
            raise ElevenLabsError("invalid voice id", 400)
        return voice_id

    def clone(self, name: str, clips: "list[tuple[str, bytes]]", remove_background_noise: bool = False, description: Optional[str] = None) -> str:
        """Create a voice from WAV clips [(filename, bytes)]. Returns the new voice_id."""
        files = [("files", (fn, data, "audio/wav")) for fn, data in clips]
        data = {"name": name, "remove_background_noise": "true" if remove_background_noise else "false"}
        if description:
            data["description"] = description
        resp = self._send("create voice", "POST", "/v1/voices/add", data=data, files=files)
        voice_id = resp.json().get("voice_id")
        if not voice_id:
            raise ElevenLabsError("create voice: ElevenLabs returned no voice id", 502)
        return self._voice(voice_id)

    def synthesize(self, voice_id: str, text: str, model_id: str, voice_settings: dict, output_format: str = "mp3_44100_128") -> "tuple[bytes, str]":
        """Speak `text` in the voice. Returns (audio bytes, content type)."""
        body = {
            "text": text,
            "model_id": model_id,
            "voice_settings": {
                "stability": voice_settings["stability"],
                "similarity_boost": voice_settings["similarityBoost"],
                "style": voice_settings["style"],
                "speed": voice_settings["speed"],
                "use_speaker_boost": voice_settings["useSpeakerBoost"],
            },
        }
        resp = self._send("speak", "POST", f"/v1/text-to-speech/{self._voice(voice_id)}", params={"output_format": output_format}, json=body)
        return resp.content, resp.headers.get("content-type") or _type_for(output_format)

    def subscription(self) -> dict:
        """The account's plan, voice-slot and character usage (GET /v1/user/subscription). Only the fields we use."""
        d = self._send("read the account", "GET", "/v1/user/subscription").json()
        keep = ("tier", "status", "character_count", "character_limit", "voice_limit", "voice_slots_used", "can_use_instant_voice_cloning", "can_use_professional_voice_cloning")
        return {k: d.get(k) for k in keep}

    def delete_voice(self, voice_id: str) -> None:
        self._send("delete voice", "DELETE", f"/v1/voices/{self._voice(voice_id)}")


def _type_for(output_format: str) -> str:
    kind = output_format.split("_")[0]
    return {"mp3": "audio/mpeg", "wav": "audio/wav", "opus": "audio/ogg", "pcm": "audio/L16", "ulaw": "audio/basic", "alaw": "audio/basic"}.get(kind, "application/octet-stream")
