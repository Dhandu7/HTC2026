#!/usr/bin/env bash
# Run any sidecar command with the project's Python, from this directory:
#   ./run.sh serve
#   ./run.sh train --i-am-the-voice-owner ~/my-clips/*.wav
#   ./run.sh say <profileId> "Hello, it's me." -o hello.wav
#   ./run.sh list | ./run.sh delete <profileId>
set -euo pipefail
cd "$(dirname "$0")"
# VOICE_ENGINE=chatterbox uses its own Python 3.11 environment (setup-chatterbox.sh); everything else uses .venv.
if [ "${VOICE_ENGINE:-openvoice}" = "chatterbox" ]; then
  PY=.venv-cb/bin/python; SETUP=./setup-chatterbox.sh
else
  PY=.venv/bin/python; SETUP=./setup.sh
fi
if [ ! -x "$PY" ]; then
  echo "Run $SETUP first." >&2
  exit 1
fi
exec "$PY" -W ignore -m voice_sidecar "${@:-serve}"
