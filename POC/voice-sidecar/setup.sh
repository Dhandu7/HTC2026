#!/usr/bin/env bash
# One-time setup for the voice sidecar. Creates .venv (Python 3.9: the OpenVoice stack does not
# run on newer Pythons), installs the pinned dependencies, and downloads the models.
#
# Downloads, roughly: ~1 GB of Python packages (torch etc.), ~526 MB UniDic dictionary (MeloTTS
# needs it at import), 131 MB OpenVoice V2 weights. MeloTTS fetches ~620 MB of language models
# the first time it renders. Total on disk: about 3.5 GB.
set -euo pipefail
cd "$(dirname "$0")"

if command -v uv >/dev/null 2>&1; then
  UV=uv
else
  python3 -m venv .tools
  .tools/bin/pip install --quiet uv
  UV=.tools/bin/uv
fi

[ -d .venv ] || $UV venv --python 3.9 .venv
$UV pip install --python .venv/bin/python -r requirements.txt
# OpenVoice and MeloTTS from pinned commits, without their own (conflicting) dependency pins.
$UV pip install --python .venv/bin/python --no-deps -r requirements-git.txt

# MeloTTS imports every language at startup; the Japanese one needs this dictionary.
if [ ! -f .venv/lib/python3.9/site-packages/unidic/dicdir/mecabrc ]; then
  .venv/bin/python -m unidic download
fi
# Current NLTK wants this resource name; MeloTTS's G2P library only fetches the old one.
.venv/bin/python -c "import nltk; nltk.download('averaged_perceptron_tagger_eng'); nltk.download('cmudict')"

.venv/bin/python scripts/fetch_weights.py

echo
echo "Setup done. Start the sidecar with:  ./run.sh"
