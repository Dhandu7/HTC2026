"""Timing spike for OpenVoice V2 (MeloTTS base speaker + tone-colour converter).

Answers, on the machine it runs on: how long do model load, voice-profile extraction and
per-phrase renders take, cold and warm, on CPU and on Apple's GPU (MPS)? It does not judge
voice quality: a person has to listen to the WAVs it writes.

Usage (from a directory that is NOT the OpenVoice or MeloTTS checkout):
  python spike_openvoice.py --ref ref.wav --ckpt ckpt/v2 --out out --device cpu
  python spike_openvoice.py --ref ref.wav --ckpt ckpt/v2 --out out --device mps --watermark

--ckpt must hold converter/{config.json,checkpoint.pth} and base_speakers/ses/en-us.pth.
"""

import argparse
import inspect
import json
import os
import resource
import statistics
import sys
import time

PHRASES = [
    "Hello, it's me.",
    "I'm okay.",
    "I need help.",
    "Yes.",
    "No.",
    "Please wait a moment.",
    "Thank you so much.",
    "Could you turn the light off, please?",
    "I love you, and I'm glad you're here.",
    "Can you call the nurse? I'm in some pain and I need to change position.",
]


def pctl(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]


def summary(xs):
    return {
        "n": len(xs),
        "p50": round(statistics.median(xs), 3),
        "p95": round(pctl(xs, 0.95), 3),
        "min": round(min(xs), 3),
        "max": round(max(xs), 3),
    }


def make_converter(cls, config_path, device, watermark):
    """Build a ToneColorConverter with the watermark on or off.

    Upstream (OpenVoice main, Apr 2025) reads `enable_watermark` in ToneColorConverter.__init__
    and then forwards it to the base class, which rejects it with a TypeError. So passing
    enable_watermark=... at all fails; only the default (watermark on) works. This does what
    __init__ does, minus the forwarding bug.
    """
    from openvoice.api import OpenVoiceBaseClass

    class Converter(cls):
        def __init__(self):
            OpenVoiceBaseClass.__init__(self, config_path, device=device)
            if watermark:
                import wavmark

                self.watermark_model = wavmark.load_model().to(self.device)
            else:
                self.watermark_model = None
            self.version = getattr(self.hps, "_version_", "v1")

    return Converter()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="reference voice WAV (the voice to clone)")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="cpu", choices=["cpu", "mps", "cuda"])
    ap.add_argument("--watermark", action="store_true", help="enable OpenVoice's wavmark watermark")
    ap.add_argument("--rounds", type=int, default=3, help="warm passes over the phrase list")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    t = time.perf_counter()
    import soundfile
    import torch
    from melo.api import TTS
    from openvoice.api import ToneColorConverter

    r = {"device": a.device, "watermark": a.watermark, "torch": torch.__version__, "python": sys.version.split()[0]}
    r["import_s"] = round(time.perf_counter() - t, 2)

    t = time.perf_counter()
    tts = TTS(language="EN", device=a.device)
    r["load_base_tts_s"] = round(time.perf_counter() - t, 2)
    speakers = dict(tts.hps.data.spk2id)
    r["base_speakers"] = sorted(speakers)
    speaker_id = speakers["EN-US"]

    t = time.perf_counter()
    conv = make_converter(ToneColorConverter, os.path.join(a.ckpt, "converter/config.json"), a.device, a.watermark)
    conv.load_ckpt(os.path.join(a.ckpt, "converter/checkpoint.pth"))
    r["load_converter_s"] = round(time.perf_counter() - t, 2)
    source_se = torch.load(os.path.join(a.ckpt, "base_speakers/ses/en-us.pth"), map_location=a.device)

    ref_info = soundfile.info(a.ref)
    t = time.perf_counter()
    target_se = conv.extract_se([a.ref])
    r["extract_profile_s"] = round(time.perf_counter() - t, 2)
    r["reference_seconds"] = round(ref_info.duration, 1)

    # What knobs does V2 expose? (Recorded so the doc can say, from the code, not from the README.)
    r["tts_to_file_params"] = list(inspect.signature(tts.tts_to_file).parameters)
    r["convert_params"] = list(inspect.signature(conv.convert).parameters)

    def render(text, tag, speed=1.0):
        src = os.path.join(a.out, f"{a.device}-{tag}-base.wav")
        dst = os.path.join(a.out, f"{a.device}-{tag}.wav")
        t0 = time.perf_counter()
        tts.tts_to_file(text, speaker_id, src, speed=speed, quiet=True)
        t1 = time.perf_counter()
        conv.convert(audio_src_path=src, src_se=source_se, tgt_se=target_se, output_path=dst, message="@VocalEyes")
        t2 = time.perf_counter()
        dur = soundfile.info(dst).duration
        return {"base_s": t1 - t0, "convert_s": t2 - t1, "total_s": t2 - t0, "audio_s": dur}

    # Cold: the very first render pays for lazy init and kernel compilation.
    cold = render(PHRASES[0], "cold")
    r["cold_first_render"] = {k: round(v, 3) for k, v in cold.items()}

    rows = []
    for rd in range(a.rounds):
        for i, text in enumerate(PHRASES):
            m = render(text, f"p{i}" if rd == 0 else "tmp")
            m.update({"i": i, "chars": len(text), "round": rd})
            rows.append(m)
    r["warm_total_s"] = summary([x["total_s"] for x in rows])
    r["warm_base_s"] = summary([x["base_s"] for x in rows])
    r["warm_convert_s"] = summary([x["convert_s"] for x in rows])
    r["warm_rtf"] = summary([x["total_s"] / x["audio_s"] for x in rows])
    short = [x for x in rows if x["chars"] <= 20]
    longer = [x for x in rows if x["chars"] > 20]
    r["warm_total_s_short_phrases(<=20 chars)"] = summary([x["total_s"] for x in short])
    r["warm_total_s_longer_phrases"] = summary([x["total_s"] for x in longer])
    r["per_phrase_p50_total_s"] = {
        PHRASES[i]: round(statistics.median([x["total_s"] for x in rows if x["i"] == i]), 3) for i in range(len(PHRASES))
    }

    # Does `speed` change the output length, i.e. is pace controllable?
    sp = {}
    for s in (0.8, 1.0, 1.2):
        sp[str(s)] = round(render(PHRASES[6], f"speed{s}", s)["audio_s"], 2)
    r["audio_seconds_by_speed"] = sp

    r["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 0)  # bytes on macOS
    with open(os.path.join(a.out, f"results-{a.device}{'-wm' if a.watermark else ''}.json"), "w") as f:
        json.dump(r, f, indent=2)
    print(json.dumps(r, indent=2))


if __name__ == "__main__":
    main()
