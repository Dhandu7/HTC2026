"""Chatterbox (Resemble AI, MIT, 500M English) as a sidecar engine.

Unlike OpenVoice, which only changes the timbre of a stock voice, Chatterbox is a zero-shot TTS that
conditions its speech on a reference clip, so accent, pacing and intonation follow the speaker too.
In the owner's own listening test it sounded closer to them than OpenVoice did.

There is no training step. "Building" a voice prepares the reference once and saves the result to
embedding-chatterbox.pt, so later renders skip that (it took 31 s on an M-series Mac).

Chatterbox pins torch 2.6 and transformers 5.x, which conflict with the OpenVoice stack, so it runs
from its own environment (.venv-cb, see setup-chatterbox.sh). Note the upstream project is retired:
as of August 2026 it receives no updates or support.

Speed warning: on an Apple GPU a short sentence took about 25 s. It needs an NVIDIA GPU for
conversation speed, which was not measured.
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional, Sequence

from .audio import analyze, load_audio, wav_bytes
from .engine import EngineError

#: Chatterbox builds its voice tokens from the first ~6 s and the decoder prompt from the first ~10 s of the
#: reference, but takes the speaker embedding from all of it.
FIRST_TARGET_S = 10.0
REFERENCE_CAP_S = 40.0
GAP_S = 0.25


def choose_reference(clips: "list[dict]", first_target: float = FIRST_TARGET_S, cap: float = REFERENCE_CAP_S) -> "list[str]":
    """Order clips for the reference: the cleanest clip nearest 10 s first (it drives the voice tokens),
    then the rest by the same score until `cap` seconds. Each clip: {path, seconds, warnings, clipped_pct, rms_db}."""

    def score(c: dict) -> float:
        loud = abs(c.get("rms_db", -20.0) + 20.0) / 10.0  # about -20 dB is healthy speech
        return -abs(c["seconds"] - first_target) / first_target - 0.5 * len(c.get("warnings", [])) - 5 * c.get("clipped_pct", 0.0) - 0.3 * loud

    ranked = sorted(clips, key=score, reverse=True)
    out, total = [], 0.0
    for c in ranked:
        if total >= cap and out:
            break
        out.append(c["path"])
        total += c["seconds"]
    return out


class ChatterboxEngine:
    name = "chatterbox"
    capabilities = {"pace": False, "base": False, "tau": False, "exaggeration": True, "cfg": True}
    bases = ["default"]

    def __init__(self, device: str = "mps", tmp_dir: Optional[Path] = None):
        self.device = device
        self.tmp_dir = Path(tmp_dir) if tmp_dir else None
        if self.tmp_dir:
            self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self.warm = False
        self._loaded = False
        self._lock = threading.Lock()  # one render at a time
        self._cache: "dict[tuple, object]" = {}

    # ---- model ----

    def load(self) -> None:
        if self._loaded:
            return
        try:
            from chatterbox.tts import ChatterboxTTS, Conditionals
        except ImportError as e:
            raise EngineError(f"Chatterbox is not installed in this environment ({e}). Run ./setup-chatterbox.sh and start with VOICE_ENGINE=chatterbox ./run.sh serve.")
        import torch

        self._torch, self._Conditionals = torch, Conditionals
        self.model = ChatterboxTTS.from_pretrained(device=self.device)  # downloads ~3 GB on first use
        self._stock = self.model.conds  # the model's built-in voice, used for the "stock voice" A/B
        self._loaded = True

    def warm_up(self) -> None:
        self.load()
        with self._lock:
            self.model.conds = self._stock
            with self._torch.inference_mode():
                self.model.generate("Ready.")
        self.warm = True

    # ---- building a voice ----

    def build_embedding(self, wav_paths: Sequence[Path], out_path: Path) -> dict:
        self.load()
        if not wav_paths:
            raise EngineError("no clips to build from")
        import librosa
        import numpy as np
        import soundfile as sf

        t0 = time.perf_counter()
        infos = []
        for p in wav_paths:
            samples, sr = load_audio(Path(p).read_bytes())
            r = analyze(samples, sr)
            infos.append({"path": str(p), "seconds": r.seconds, "warnings": r.warnings, "clipped_pct": r.clipped_pct, "rms_db": r.rms_db})
        order = choose_reference(infos)
        by_path = {i["path"]: i for i in infos}
        parts, gap = [], np.zeros(int(GAP_S * 24000), dtype=np.float32)
        for p in order:
            y, _ = librosa.load(p, sr=24000, mono=True)
            parts += [y, gap]
        ref = np.concatenate(parts)
        with self._lock, tempfile.TemporaryDirectory(dir=self.tmp_dir) as d:
            ref_path = os.path.join(d, "reference.wav")
            sf.write(ref_path, ref, 24000, subtype="PCM_16")
            self.model.prepare_conditionals(ref_path)
            tmp_out = Path(str(out_path) + ".tmp")
            self.model.conds.save(tmp_out)
            os.replace(tmp_out, out_path)
        self._cache.clear()
        return {
            "seconds": round(time.perf_counter() - t0, 2),
            "referenceClips": len(order),
            "referenceSecondsUsed": round(sum(by_path[p]["seconds"] for p in order), 1),
            "leadClip": Path(order[0]).name,
        }

    def clip_similarity(self, wav_paths: Sequence[Path]) -> "list[float]":
        self.load()
        torch = self._torch
        import librosa
        import numpy as np

        embs = []
        with self._lock:
            for p in wav_paths:
                y, _ = librosa.load(str(p), sr=16000, mono=True)
                e = torch.as_tensor(np.asarray(self.model.ve.embeds_from_wavs([y], sample_rate=16000, as_spk=True))).flatten().float()
                embs.append(e / e.norm())
        mean = torch.stack(embs).mean(0)
        mean = mean / mean.norm()
        return [round(float(torch.dot(e, mean)), 3) for e in embs]

    # ---- speaking ----

    def _conds(self, path: Path):
        st = Path(path).stat()
        key = (str(path), st.st_mtime_ns)
        if key not in self._cache:
            self._cache = {key: self._Conditionals.load(path, map_location=self.device)}  # keep only the newest
        return self._cache[key]

    def synthesize(self, text: str, embedding_path: Path, pace: float = 1.0, tau: float = 0.3, raw: bool = False, base: str = "default", exaggeration: float = 0.5, cfg_weight: float = 0.5, **opts):
        self.load()
        if not raw and not Path(embedding_path).is_file():
            raise EngineError("this voice has not been built with Chatterbox yet")
        t0 = time.perf_counter()
        with self._lock:
            self.model.conds = self._stock if raw else self._conds(embedding_path)
            with self._torch.inference_mode():
                wav = self.model.generate(text, exaggeration=exaggeration, cfg_weight=cfg_weight)
            samples = wav.squeeze(0).detach().cpu().numpy()
        ms = round((time.perf_counter() - t0) * 1000)
        return wav_bytes(samples, self.model.sr), {"baseMs": ms, "convertMs": 0}
