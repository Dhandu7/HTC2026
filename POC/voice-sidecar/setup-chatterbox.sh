#!/usr/bin/env bash
# One-time setup for the Chatterbox engine: .venv-cb (Python 3.11). Downloads about 1 GB of packages, and
# Chatterbox fetches ~3 GB of model weights from Hugging Face the first time it runs.
set -euo pipefail
cd "$(dirname "$0")"
if command -v uv >/dev/null 2>&1; then UV=uv; else
  [ -x .tools/bin/uv ] || { python3 -m venv .tools && .tools/bin/pip install --quiet uv; }
  UV=.tools/bin/uv
fi
[ -d .venv-cb ] || $UV venv --python 3.11 .venv-cb
$UV pip install --python .venv-cb/bin/python -r requirements-chatterbox.txt
echo
echo "Done. Start with:  VOICE_ENGINE=chatterbox VOICE_DEVICE=mps ./run.sh serve"
echo "(device: mps = Apple GPU, cuda = NVIDIA, cpu. Expect tens of seconds per sentence on a laptop.)"
