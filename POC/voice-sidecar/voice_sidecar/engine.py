"""Speech engines. `Engine` is the contract; OpenVoiceEngine is the real one, FakeEngine is for
tests and UI work without models (voice_sidecar/fake_engine.py).

OpenVoice V2 is two stages: a MeloTTS base speaker produces speech in a stock voice, then a
tone-colour converter re-voices it to match a reference embedding built from the user's clips.
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional, Protocol, Sequence


class EngineError(RuntimeError):
    pass


class Engine(Protocol):
    name: str
    device: str
    warm: bool

    def load(self) -> None: ...

    def warm_up(self) -> None: ...

    def build_embedding(self, wav_paths: Sequence[Path], out_path: Path) -> dict:
        """Write the voice embedding for these clips to out_path. Returns {"seconds": <build time>}."""

    def synthesize(self, text: str, embedding_path: Path, pace: float = 1.0, tau: float = 0.3, raw: bool = False) -> "tuple[bytes, dict]":
        """Return (WAV bytes, timings). raw=True returns the stock base voice, before conversion, for A/B."""


class OpenVoiceEngine:
    name = "openvoice-v2"

    def __init__(self, ckpt_dir: Path, device: str = "cpu", watermark: bool = False, speaker: str = "EN-US", tmp_dir: Optional[Path] = None):
        self.ckpt_dir = Path(ckpt_dir)
        self.device = device
        self.watermark = watermark
        self.speaker = speaker
        self.tmp_dir = Path(tmp_dir) if tmp_dir else None
        if self.tmp_dir:
            # Renders go through temporary files here; the directory must exist before tempfile uses it.
            self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self.warm = False
        self._loaded = False
        # The models are not thread-safe: one render at a time.
        self._lock = threading.Lock()

    def _require(self, rel: str) -> Path:
        p = self.ckpt_dir / rel
        if not p.is_file():
            raise EngineError(f"missing model file {p}. Run scripts/fetch_weights.py (or set VOICE_CKPT).")
        return p

    def load(self) -> None:
        if self._loaded:
            return
        cfg = self._require("converter/config.json")
        ckpt = self._require("converter/checkpoint.pth")
        ses = self._require("base_speakers/ses/en-us.pth")
        # Imported here so the API (and the tests) work without torch installed.
        import torch
        from melo.api import TTS
        from openvoice.api import OpenVoiceBaseClass, ToneColorConverter

        self._torch = torch
        self.tts = TTS(language="EN", device=self.device)
        self.speaker_id = dict(self.tts.hps.data.spk2id)[self.speaker]

        watermark, device = self.watermark, self.device

        class Converter(ToneColorConverter):
            # Upstream ToneColorConverter(..., enable_watermark=...) raises TypeError: it reads the
            # kwarg and then forwards it to the base class. Do what __init__ does, minus that bug.
            def __init__(self):
                OpenVoiceBaseClass.__init__(self, str(cfg), device=device)
                if watermark:
                    import wavmark

                    self.watermark_model = wavmark.load_model().to(self.device)
                else:
                    self.watermark_model = None
                self.version = getattr(self.hps, "_version_", "v1")

        self.conv = Converter()
        self.conv.load_ckpt(str(ckpt))
        self.source_se = torch.load(str(ses), map_location=self.device, weights_only=True)
        self._loaded = True

    def warm_up(self) -> None:
        """One throwaway render so the first real request does not pay for lazy initialisation."""
        self.load()
        with self._lock, tempfile.TemporaryDirectory(dir=self.tmp_dir) as d:
            src, dst = os.path.join(d, "s.wav"), os.path.join(d, "d.wav")
            self.tts.tts_to_file("Ready.", self.speaker_id, src, speed=1.0, quiet=True)
            # source -> source is a valid (identity) conversion, which warms the converter too.
            self.conv.convert(audio_src_path=src, src_se=self.source_se, tgt_se=self.source_se, output_path=dst, message="@VocalEyes")
        self.warm = True

    def build_embedding(self, wav_paths: Sequence[Path], out_path: Path) -> dict:
        self.load()
        if not wav_paths:
            raise EngineError("no clips to build from")
        t0 = time.perf_counter()
        with self._lock:
            se = self.conv.extract_se([str(p) for p in wav_paths])
            tmp = Path(str(out_path) + ".tmp")
            self._torch.save(se.cpu(), str(tmp))
            os.replace(tmp, out_path)
        return {"seconds": round(time.perf_counter() - t0, 2)}

    def synthesize(self, text: str, embedding_path: Path, pace: float = 1.0, tau: float = 0.3, raw: bool = False):
        self.load()
        with self._lock, tempfile.TemporaryDirectory(dir=self.tmp_dir) as d:
            src, dst = os.path.join(d, "base.wav"), os.path.join(d, "voice.wav")
            t0 = time.perf_counter()
            self.tts.tts_to_file(text, self.speaker_id, src, speed=pace, quiet=True)
            t1 = time.perf_counter()
            if raw:
                data = Path(src).read_bytes()
                return data, {"baseMs": round((t1 - t0) * 1000), "convertMs": 0}
            target = self._torch.load(str(embedding_path), map_location=self.device, weights_only=True)
            self.conv.convert(audio_src_path=src, src_se=self.source_se, tgt_se=target, output_path=dst, tau=tau, message="@VocalEyes")
            t2 = time.perf_counter()
            return Path(dst).read_bytes(), {"baseMs": round((t1 - t0) * 1000), "convertMs": round((t2 - t1) * 1000)}


def make_engine(settings) -> Engine:
    if settings.engine == "fake":
        from .fake_engine import FakeEngine

        return FakeEngine()
    if settings.engine != "openvoice":
        raise EngineError(f"unknown engine {settings.engine!r}")
    return OpenVoiceEngine(settings.ckpt_dir, settings.device, settings.watermark, tmp_dir=settings.data_dir / "tmp")
