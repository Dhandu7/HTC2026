"""Reading uploaded audio and judging whether a clip is good enough to build a voice from.

Bad reference audio (silence, clipping, a noisy room, a clip that is mostly a pause) is the most
common reason a cloned voice sounds wrong, so every clip is checked on upload and the result is
returned to the person recording, with a reason.
"""

from __future__ import annotations

import io
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

FRAME_S = 0.02
SILENCE_DB = -50.0  # frames quieter than this count as silence


class AudioError(ValueError):
    pass


@dataclass
class ClipReport:
    seconds: float
    sample_rate: int
    #: Loudness of the non-silent part, in dB relative to full scale (about -20 is healthy speech).
    rms_db: float
    peak: float
    clipped_pct: float
    silence_pct: float
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ok"] = self.ok
        return d


def load_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode an uploaded file to mono float32 in [-1, 1]. WAV, FLAC and OGG work; MP3 needs libsndfile 1.1+."""
    try:
        audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as e:  # soundfile raises RuntimeError / LibsndfileError for unknown formats
        raise AudioError(f"could not read audio (send WAV): {e}") from e
    if audio.size == 0:
        raise AudioError("audio file is empty")
    mono = audio.mean(axis=1)
    if not np.isfinite(mono).all():
        raise AudioError("audio contains invalid samples")
    return mono.astype(np.float32), int(sr)


def analyze(samples: np.ndarray, sr: int) -> ClipReport:
    seconds = len(samples) / sr
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    clipped_pct = float(np.mean(np.abs(samples) >= 0.999) * 100) if len(samples) else 0.0

    n = max(1, int(sr * FRAME_S))
    frames = len(samples) // n
    if frames == 0:
        rms = np.array([0.0])
    else:
        rms = np.sqrt(np.mean(samples[: frames * n].reshape(frames, n) ** 2, axis=1))
    db = 20 * np.log10(np.maximum(rms, 1e-9))
    voiced = db > SILENCE_DB
    silence_pct = float((1 - voiced.mean()) * 100)
    voiced_seconds = float(voiced.sum() * FRAME_S)
    rms_db = float(20 * np.log10(max(np.sqrt(np.mean(np.square(rms[voiced]))), 1e-9))) if voiced.any() else -120.0

    r = ClipReport(
        seconds=round(seconds, 2),
        sample_rate=sr,
        rms_db=round(rms_db, 1),
        peak=round(peak, 3),
        clipped_pct=round(clipped_pct, 3),
        silence_pct=round(silence_pct, 1),
    )
    if seconds < 1.0:
        r.errors.append("too short (under 1 s): record a full sentence")
    if seconds > 60.0:
        r.errors.append("too long (over 60 s): split it into shorter clips")
    if voiced_seconds < 1.0:
        r.errors.append("almost no speech detected: is the microphone working?")
    if rms_db < -40.0 and voiced_seconds >= 1.0:
        r.errors.append("far too quiet: move closer to the microphone")
    if clipped_pct > 1.0:
        r.errors.append("distorted (clipping): lower the input volume or move back")
    if not r.errors:
        if seconds < 3.0:
            r.warnings.append("short clip: 5 to 15 seconds of natural speech works better")
        if silence_pct > 50.0:
            r.warnings.append("more than half of this clip is silence")
        if rms_db < -30.0:
            r.warnings.append("quiet recording: a closer microphone usually sounds better")
        if clipped_pct > 0.1:
            r.warnings.append("slight clipping detected")
        if sr < 16000:
            r.warnings.append("low sample rate: 16 kHz or higher is better")
    return r


def write_wav(path: Path, samples: np.ndarray, sr: int) -> None:
    sf.write(str(path), samples, sr, subtype="PCM_16")


def wav_bytes(samples: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()
