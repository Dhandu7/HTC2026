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


def _load_with_av(data: bytes) -> tuple[np.ndarray, int]:
    """Decode anything ffmpeg can read (M4A, MP4, WebM, AAC, Opus, ...) via PyAV, to mono float32."""
    import av  # optional dependency; soundfile covers WAV, FLAC, OGG and MP3 without it

    with av.open(io.BytesIO(data)) as container:
        stream = next((st for st in container.streams if st.type == "audio"), None)
        if stream is None:
            raise AudioError("no audio track found in this file")
        rate = int(stream.rate or 44100)
        resampler = av.AudioResampler(format="flt", layout="mono", rate=rate)
        parts = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                parts.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            parts.append(out.to_ndarray().reshape(-1))
    if not parts:
        raise AudioError("audio file is empty")
    return np.concatenate(parts).astype(np.float32), rate


def load_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode an uploaded file to mono float32 in [-1, 1].

    soundfile first (WAV, FLAC, OGG, MP3); PyAV/ffmpeg as the fallback for everything else
    (M4A, MP4 video, WebM, AAC, Opus), so "any clip I already have" works.
    """
    try:
        audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        mono, rate = audio.mean(axis=1), int(sr)
    except Exception as first:
        try:
            mono, rate = _load_with_av(data)
        except AudioError:
            raise
        except ImportError:
            raise AudioError(f"could not read this audio format ({first}); install PyAV (pip install av) or send WAV")
        except Exception as second:
            raise AudioError(f"could not read this file as audio: {second}") from second
    if mono.size == 0:
        raise AudioError("audio file is empty")
    if not np.isfinite(mono).all():
        raise AudioError("audio contains invalid samples")
    return mono.astype(np.float32), int(rate)


def split_at_pauses(samples: np.ndarray, sr: int, target_s: float = 15.0, max_s: float = 25.0, min_s: float = 10.0) -> list[np.ndarray]:
    """Cut a long recording into pieces of 10 to 25 s, preferring a real pause near `target_s`, so words are not
    chopped. If a window holds no pause at all, it falls back to its quietest frame. Short recordings come back as
    one piece. Every sample ends up in exactly one piece."""
    n = max(1, int(sr * FRAME_S))
    frames = len(samples) // n
    if frames * FRAME_S <= max_s:
        return [samples]
    rms = np.sqrt(np.mean(samples[: frames * n].reshape(frames, n) ** 2, axis=1))
    smooth = np.convolve(rms, np.ones(5) / 5, mode="same")  # a pause, not a single quiet frame
    pause_level = 0.05 * float(np.percentile(smooth, 90))  # well below the speech level of this recording
    out, pos = [], 0
    lo_f, tgt_f, hi_f = int(min_s / FRAME_S), int(target_s / FRAME_S), int(max_s / FRAME_S)
    while pos < frames:
        if (frames - pos) <= hi_f:
            end = frames
        else:
            window = smooth[pos + lo_f : pos + hi_f]
            quiet = np.flatnonzero(window <= pause_level)
            if len(quiet):
                # the pause closest to the target length; among the frames of that pause, the middle one
                nearest = quiet[np.argmin(np.abs(quiet - (tgt_f - lo_f)))]
                run = quiet[np.abs(quiet - nearest) <= 25]  # frames of the same pause (within half a second)
                end = pos + lo_f + int(run[len(run) // 2])
            else:
                end = pos + lo_f + int(np.argmin(window))
        out.append(samples[pos * n : end * n])
        pos = end
    tail = samples[frames * n :]
    if len(tail) and out:
        out[-1] = np.concatenate([out[-1], tail])
    return out


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
