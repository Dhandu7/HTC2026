"""Spike: Chatterbox (Resemble AI, MIT, 500M English) zero-shot cloning vs OpenVoice V2.

Run it in its own Python 3.11 environment (Chatterbox pins torch 2.6 and transformers 5.x, which
conflict with the OpenVoice stack):

  python chatterbox_spike.py --ref ref.wav --clips clip1.wav clip2.wav ... --out out --device mps \
      [--compare other_engine_output.wav ...]

--ref     the reference voice Chatterbox clones (it conditions on about the first 10 s)
--clips   the speaker's separate real clips, used only to score similarity
--compare other engines' outputs of the same sentences, scored the same way
Timing is warm unless labelled cold. Similarity uses Chatterbox's own voice encoder, which
flatters Chatterbox a little; use it for direction, and listen to the files for the real verdict.
"""

import argparse
import json
import os
import resource
import statistics
import sys
import time

import numpy as np
import soundfile as sf
import torch

SENTENCES = [
    "Hello, it's me. I'm okay, and I'm glad you're here.",
    "I need some help, and I'd like you to stay with me for a moment.",
    "Yes.",
    "Please wait a moment.",
    "Could you turn the light off? It's a little too bright for me.",
]


def read16k(path):
    import librosa

    y, _ = librosa.load(path, sr=16000, mono=True)
    return y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--clips", nargs="*", default=[])
    ap.add_argument("--compare", nargs="*", default=[])
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="mps", choices=["cpu", "mps", "cuda"])
    ap.add_argument("--exaggeration", type=float, default=0.5)
    ap.add_argument("--cfg", type=float, default=0.5)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    from chatterbox.tts import ChatterboxTTS

    r = {"device": a.device, "torch": torch.__version__, "python": sys.version.split()[0], "exaggeration": a.exaggeration, "cfg_weight": a.cfg}

    t = time.perf_counter()
    model = ChatterboxTTS.from_pretrained(device=a.device)
    r["load_model_s"] = round(time.perf_counter() - t, 2)
    r["sample_rate"] = model.sr

    t = time.perf_counter()
    model.prepare_conditionals(a.ref, exaggeration=a.exaggeration)
    r["prepare_voice_s"] = round(time.perf_counter() - t, 2)

    def gen(text):
        t0 = time.perf_counter()
        with torch.inference_mode():
            wav = model.generate(text, exaggeration=a.exaggeration, cfg_weight=a.cfg)
        dt = time.perf_counter() - t0
        samples = wav.squeeze(0).detach().cpu().numpy()
        return samples, dt

    s0, cold = gen(SENTENCES[0])
    r["cold_first_render_s"] = round(cold, 2)
    sf.write(os.path.join(a.out, f"cb-{a.device}-cold.wav"), s0, model.sr)

    rows = []
    outputs = []
    for i, text in enumerate(SENTENCES):
        samples, dt = gen(text)
        path = os.path.join(a.out, f"cb-{a.device}-{i}.wav")
        sf.write(path, samples, model.sr)
        outputs.append(path)
        audio_s = len(samples) / model.sr
        rows.append({"i": i, "chars": len(text), "render_s": round(dt, 2), "audio_s": round(audio_s, 2), "rtf": round(dt / audio_s, 2)})
    r["renders"] = rows
    r["warm_render_s_median"] = round(statistics.median(x["render_s"] for x in rows), 2)
    r["warm_rtf_median"] = round(statistics.median(x["rtf"] for x in rows), 2)
    r["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6)  # bytes on macOS

    # ---- similarity, with Chatterbox's voice encoder (256-d speaker embedding) ----
    def spk(path):
        e = model.ve.embeds_from_wavs([read16k(path)], sample_rate=16000, as_spk=True)
        e = torch.as_tensor(np.asarray(e)).flatten().float()
        return e / e.norm()

    cos = lambda x, y: round(float(torch.dot(x, y)), 3)
    if a.clips:
        clip_e = [spk(p) for p in a.clips]
        mean = torch.stack(clip_e).mean(0)
        mean = mean / mean.norm()
        r["similarity_to_speaker"] = {
            "speaker_clip_vs_mean_of_clips (ceiling)": [cos(e, mean) for e in clip_e],
            "chatterbox_outputs": [cos(spk(p), mean) for p in outputs],
        }
        if a.compare:
            r["similarity_to_speaker"]["compare_outputs"] = {os.path.basename(p): cos(spk(p), mean) for p in a.compare}

    with open(os.path.join(a.out, f"chatterbox-{a.device}.json"), "w") as f:
        json.dump(r, f, indent=2)
    print(json.dumps(r, indent=2))


if __name__ == "__main__":
    main()
