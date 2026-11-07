#!/usr/bin/env bash
# Run any sidecar command with the project's Python, from this directory:
#   ./run.sh serve
#   ./run.sh train --i-am-the-voice-owner ~/my-clips/*.wav
#   ./run.sh say <profileId> "Hello, it's me." -o hello.wav
#   ./run.sh list | ./run.sh delete <profileId>
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Run ./setup.sh first." >&2
  exit 1
fi
exec .venv/bin/python -W ignore -m voice_sidecar "${@:-serve}"
