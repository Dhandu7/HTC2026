"""Settings, read from the environment so Electron (or a shell) can configure the sidecar."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def _bool(v: str | None, default: bool = False) -> bool:
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    #: Where profiles (clips, embeddings, consent records) live. Electron passes its userData path.
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("VOICE_SIDECAR_DATA", Path.home() / ".vocaleyes" / "voice-sidecar")))
    #: OpenVoice V2 weights: converter/{config.json,checkpoint.pth} and base_speakers/ses/en-us.pth
    ckpt_dir: Path = field(default_factory=lambda: Path(os.environ.get("VOICE_CKPT", HERE / "models" / "v2")))
    host: str = field(default_factory=lambda: os.environ.get("VOICE_SIDECAR_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("VOICE_SIDECAR_PORT", "8790")))
    #: Shared secret for every endpoint except /health and the /ui page. Generated if unset.
    token: str = field(default_factory=lambda: os.environ.get("VOICE_SIDECAR_TOKEN") or secrets.token_urlsafe(24))
    #: cpu is the right choice on Apple silicon (see docs/VOICE_ENGINE_FLOW.md spike results).
    device: str = field(default_factory=lambda: os.environ.get("VOICE_DEVICE", "cpu"))
    #: OpenVoice's wavmark watermark. Off by default: untested for latency in the spike.
    watermark: bool = field(default_factory=lambda: _bool(os.environ.get("VOICE_WATERMARK")))
    #: "openvoice" or "fake" (a tiny stand-in for UI work and tests; makes tones, not speech).
    engine: str = field(default_factory=lambda: os.environ.get("VOICE_ENGINE", "openvoice"))
    #: Browser origins allowed to call the API (the Vite dev server by default; "null" is Electron file://).
    cors_origins: list[str] = field(
        default_factory=lambda: [o for o in os.environ.get("VOICE_CORS", "http://localhost:5173,http://127.0.0.1:5173,null").split(",") if o]
    )
    max_text_chars: int = 500
    max_upload_bytes: int = 100 * 1024 * 1024
    #: Cap on reference audio used to build one embedding.
    max_reference_seconds: float = 300.0
