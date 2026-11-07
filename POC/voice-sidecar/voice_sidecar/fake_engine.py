"""A stand-in engine: no models, no torch. It "builds" an embedding file and "speaks" by making a
tone whose length follows the text. For tests and for working on the UI. It does not make speech."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Sequence

import numpy as np

from .audio import wav_bytes
from .engine import EngineError


class FakeEngine:
    name = "fake"
    device = "none"
    warm = True

    def __init__(self):
        self.builds = 0
        self.renders: list[dict] = []

    def load(self) -> None:
        pass

    def warm_up(self) -> None:
        pass

    def build_embedding(self, wav_paths: Sequence[Path], out_path: Path) -> dict:
        if not wav_paths:
            raise EngineError("no clips to build from")
        self.builds += 1
        Path(out_path).write_text(json.dumps({"clips": [Path(p).name for p in wav_paths]}))
        return {"seconds": 0.0}

    def synthesize(self, text: str, embedding_path: Path, pace: float = 1.0, tau: float = 0.3, raw: bool = False):
        if not raw and not Path(embedding_path).is_file():
            raise EngineError("no embedding")
        self.renders.append({"text": text, "pace": pace, "tau": tau, "raw": raw})
        sr = 24000
        seconds = max(0.3, len(text) * 0.06 / max(pace, 0.1))
        t = np.arange(int(sr * seconds)) / sr
        freq = 330.0 if raw else 220.0
        wave = (0.2 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        return wav_bytes(wave, sr), {"baseMs": 0, "convertMs": 0}
