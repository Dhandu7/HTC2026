"""Download the OpenVoice V2 weights the sidecar needs into models/v2/ (about 131 MB).

Source: https://huggingface.co/myshell-ai/OpenVoiceV2 (MIT, per its model card).
MeloTTS fetches its own English model on the first render; that is separate.

  python scripts/fetch_weights.py [target_dir]
"""

import sys
import urllib.request
from pathlib import Path

BASE = "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/"
# path -> expected size in bytes (checked after download; a mismatch means a truncated file)
FILES = {
    "converter/config.json": 838,
    "converter/checkpoint.pth": 131320490,
    "base_speakers/ses/en-us.pth": 1701,
}


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "models" / "v2"
    for rel, size in FILES.items():
        dest = target / rel
        if dest.is_file() and dest.stat().st_size == size:
            print(f"have  {rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        print(f"fetch {rel} ({size / 1e6:.1f} MB)")
        urllib.request.urlretrieve(BASE + rel, tmp)
        if tmp.stat().st_size != size:
            tmp.unlink()
            print(f"  size mismatch for {rel}: expected {size}", file=sys.stderr)
            return 1
        tmp.replace(dest)
    print(f"weights ready in {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
