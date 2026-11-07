"""Command line: serve the API, or train and test a voice straight from clip files.

  python -m voice_sidecar serve                          # API + browser page on 127.0.0.1:8790
  python -m voice_sidecar train --i-am-the-voice-owner clips/*.wav
  python -m voice_sidecar say <profileId> "I need help." -o out.wav
  python -m voice_sidecar list
  python -m voice_sidecar delete <profileId>
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from .config import Settings
from .engine import make_engine
from .service import ClipRejected, VoiceService
from .store import Consent, ProfileStore, StoreError


def _service(settings: Settings) -> VoiceService:
    return VoiceService(settings, ProfileStore(settings.data_dir), make_engine(settings))


def cmd_serve(a, settings: Settings) -> int:
    import uvicorn

    from .app import create_app

    url = f"http://{settings.host}:{settings.port}/ui#token={settings.token}"
    # flush: when stdout is a pipe or file (Electron, a log), Python buffers and the URL would never appear
    print(f"[voice-sidecar] engine={settings.engine} device={settings.device} data={settings.data_dir}", flush=True)
    print(f"[voice-sidecar] open this in your browser to record and test a voice:\n\n    {url}\n", flush=True)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="warning")
    return 0


def cmd_train(a, settings: Settings) -> int:
    if not (a.i_am_the_voice_owner or a.authorized_by):
        print("Refusing: a voice can only be built with consent.\n  Use --i-am-the-voice-owner if these clips are your own voice,\n  or --authorized-by \"Name\" if the voice owner gave you permission.", file=sys.stderr)
        return 2
    svc = _service(settings)
    if a.profile:
        pid = a.profile
        svc.status(pid)
    else:
        consent = Consent(mode="authorized" if a.authorized_by else "self", acknowledged=True, authorized_by=a.authorized_by)
        pid = svc.create_profile(consent)
    print(f"profile {pid}")
    added = 0
    for f in a.clips:
        p = Path(f)
        try:
            result = svc.add_clip(pid, p.stem, p.read_bytes())
        except ClipRejected as e:
            print(f"  rejected {p.name}: {e}")
            continue
        except OSError as e:
            print(f"  cannot read {p}: {e}")
            continue
        for clip in result["clips"]:
            added += 1
            r = clip["report"]
            warn = f"  [{'; '.join(r['warnings'])}]" if r["warnings"] else ""
            print(f"  ok       {clip['label']}: {r['seconds']} s, {r['rms_db']} dB{warn}")
        for sk in result["skipped"]:
            print(f"  skipped  {sk['label']}: {'; '.join(sk['errors'])}")
    if not added and not svc.status(pid)["clips"]:
        print("no usable clips, nothing to build", file=sys.stderr)
        return 1
    print("building voice (loads the model; first run takes a little while)...")
    t0 = time.perf_counter()
    info = svc.build(pid)
    print(f"built in {time.perf_counter() - t0:.1f} s from {info['clipsUsed']} clip(s), {info['referenceSeconds']} s of audio")
    for x in info.get("similarity", []):
        if x["clip"] in info.get("flagged", []):
            print(f"  warning: {x['label']} sounds unlike the other clips (similarity {x['similarity']}); is it another speaker? Remove it and rebuild.")
    print(f"\nTest it:  python -m voice_sidecar say {pid} \"Hello, it's me.\" -o hello.wav")
    return 0


def cmd_say(a, settings: Settings) -> int:
    svc = _service(settings)
    t0 = time.perf_counter()
    wav, info = svc.synthesize(a.profile, a.text, a.pace, a.tau, a.raw, a.base)
    out = Path(a.output)
    out.write_bytes(wav)
    print(f"wrote {out} ({len(wav) // 1024} KB) in {(time.perf_counter() - t0) * 1000:.0f} ms (base {info['baseMs']} ms + convert {info['convertMs']} ms)")
    if not a.raw:
        print("This is AI-assisted speech in the voice owner's cloned voice.")
    return 0


def cmd_list(a, settings: Settings) -> int:
    store = ProfileStore(settings.data_dir)
    ids = store.list_ids()
    if not ids:
        print("no profiles")
    for pid in ids:
        try:
            s = store.status(pid)
            print(f"{pid}  clips={len(s['clips'])}  {s['referenceSeconds']} s  built={s['built']}  paused={s['paused']}  consent={s['consent']['mode']}")
        except StoreError as e:
            print(f"{pid}  unusable: {e}")
    return 0


def cmd_delete(a, settings: Settings) -> int:
    if not a.yes:
        if input(f"Permanently delete profile {a.profile}, its clips and its voice? This cannot be undone. Type 'delete' to confirm: ").strip() != "delete":
            print("cancelled")
            return 1
    ProfileStore(settings.data_dir).delete(a.profile)
    print("deleted")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="voice_sidecar", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", help="profile storage directory (default ~/.vocaleyes/voice-sidecar)")
    ap.add_argument("--engine", choices=["openvoice", "chatterbox", "fake"], help="chatterbox needs its own environment (setup-chatterbox.sh, run with VOICE_ENGINE=chatterbox ./run.sh); fake = tones, for testing")
    ap.add_argument("--device", choices=["cpu", "mps", "cuda"], help="cpu is faster and steadier on Apple silicon; cuda (NVIDIA) is untested")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("serve", help="run the API and the browser test page").set_defaults(fn=cmd_serve)

    t = sub.add_parser("train", help="build a voice from your own clip files")
    t.add_argument("clips", nargs="+", help="audio files of the voice owner speaking: WAV, MP3, M4A, MP4, WebM, FLAC, OGG. Long recordings are split at pauses")
    t.add_argument("--i-am-the-voice-owner", action="store_true", help="confirm these clips are your own voice")
    t.add_argument("--authorized-by", metavar="NAME", help="the voice owner who gave permission (carer use)")
    t.add_argument("--profile", help="add to an existing profile instead of creating one")
    t.set_defaults(fn=cmd_train)

    s = sub.add_parser("say", help="render text in a built voice to a WAV file")
    s.add_argument("profile")
    s.add_argument("text")
    s.add_argument("-o", "--output", default="out.wav")
    s.add_argument("--pace", type=float, default=1.0, help="0.8 slower to 1.2 faster")
    s.add_argument("--tau", type=float, default=0.3, help="0.1-0.6: randomness in the converter (does not change how much it resembles you)")
    s.add_argument("--base", default="EN-US", help="stock voice to build on: sets accent and rhythm. EN-US, EN-BR, EN_INDIA, EN-AU, EN-Default")
    s.add_argument("--raw", action="store_true", help="the stock base voice, before conversion (for A/B)")
    s.set_defaults(fn=cmd_say)

    sub.add_parser("list", help="list profiles").set_defaults(fn=cmd_list)

    d = sub.add_parser("delete", help="permanently delete a profile")
    d.add_argument("profile")
    d.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    d.set_defaults(fn=cmd_delete)

    a = ap.parse_args(argv)
    settings = Settings()
    if a.data:
        settings.data_dir = Path(a.data)
    if a.engine:
        settings.engine = a.engine
    if a.device:
        settings.device = a.device
    try:
        return a.fn(a, settings)
    except StoreError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
