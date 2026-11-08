"""Live check of the ElevenLabs integration with YOUR key. Run it yourself; the key never needs to be shared.

  export ELEVENLABS_API_KEY=...        (or put it in a local .env that you source; never commit it)
  ./hosted.sh smoke --clip ~/my-voice.wav --i-am-the-voice-owner

What it does, in order: checks the clip, creates a temporary voice from it, speaks one sentence in it, writes
the audio to a file, then ALWAYS deletes the temporary voice again. It uses one voice slot for a few seconds and
a few dozen characters of your quota. It never touches DynamoDB or any other voice in the account.

Use a recording of your own voice, or of someone who has agreed. ElevenLabs' policy requires the speaker's consent.
"""

import argparse
import os
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from voice_sidecar.elevenlabs import DEFAULT_BASE_URL, ElevenLabsClient, ElevenLabsError, RemoteVoiceMissing, VoiceNeedsVerification  # noqa: E402
from voice_sidecar.hosted import DEFAULT_SETTINGS, prepare_clips  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clip", required=True, nargs="+", help="audio of the voice owner (WAV, MP3, M4A, ...), at least ~10 s in total")
    ap.add_argument("--i-am-the-voice-owner", action="store_true", help="confirm these clips are your own voice, or you have the owner's permission")
    ap.add_argument("--text", default="Hello, it's me. I'm okay, and I'm glad you're here.")
    ap.add_argument("--model", default=DEFAULT_SETTINGS["modelId"])
    ap.add_argument("--out", default="smoke-output.mp3")
    a = ap.parse_args()

    if not a.i_am_the_voice_owner:
        print("Refusing: a voice can only be created with consent. Add --i-am-the-voice-owner if these clips are your own voice (or the owner agreed).", file=sys.stderr)
        return 2
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        print("Set ELEVENLABS_API_KEY in your environment first.", file=sys.stderr)
        return 2

    uploads = [(Path(p).stem, Path(p).read_bytes()) for p in a.clip]
    files, meta, skipped = prepare_clips(uploads)
    for s in skipped:
        print(f"  skipped {s['label']}: {'; '.join(s['errors'])}")
    seconds = sum(m["seconds"] for m in meta)
    print(f"{len(files)} usable clip(s), {seconds:.0f} s of speech")
    if not files:
        return 1

    client = ElevenLabsClient(key, os.environ.get("ELEVENLABS_BASE_URL", DEFAULT_BASE_URL))
    voice_id = None
    try:
        t = time.perf_counter()
        cloned = client.clone(f"vocaleyes-smoke-{secrets.token_hex(3)}", files)
        voice_id = cloned.voice_id
        print(f"created a temporary voice in {time.perf_counter() - t:.1f} s")
        if cloned.requires_verification:
            print("note: ElevenLabs says this voice needs verification before it can speak, so the next step will probably be refused.")
        t = time.perf_counter()
        audio, ctype = client.synthesize(voice_id, a.text, a.model, DEFAULT_SETTINGS)
        print(f"spoke {len(a.text)} characters in {(time.perf_counter() - t) * 1000:.0f} ms ({a.model}); {len(audio) // 1024} KB of {ctype}")
        Path(a.out).write_bytes(audio)
        print(f"wrote {a.out}: play it and judge whether it sounds like the owner")
        return 0
    except VoiceNeedsVerification:
        print("ElevenLabs will not let this voice speak until it is verified: in the ElevenLabs dashboard (Voices), open the voice and complete its verification (you read a short phrase aloud). The service's own flow works the same way: the voice is created, then verified there.", file=sys.stderr)
        return 3
    except ElevenLabsError as e:
        print(f"ElevenLabs error ({e.status}): {e}", file=sys.stderr)
        return 1
    finally:
        if voice_id:
            try:
                client.delete_voice(voice_id)
                print("deleted the temporary voice")
            except RemoteVoiceMissing:
                print("temporary voice was already gone")
            except ElevenLabsError as e:
                print(f"WARNING: could not delete the temporary voice {voice_id}: {e}. Delete it in the ElevenLabs dashboard (Voices) so it does not use a slot.", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
