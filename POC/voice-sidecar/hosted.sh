#!/usr/bin/env bash
# Helper for the hosted (ElevenLabs + DynamoDB) voice service.
#   ./hosted.sh setup     create .venv-hosted (Python 3.12) and install the light requirements
#   ./hosted.sh test      run the tests (no AWS account or ElevenLabs key needed)
#   ./hosted.sh check-table  run the lifecycle check against the REAL DynamoDB table (needs AWS credentials)
#   ./hosted.sh serve     run the API (reads configuration from the environment, see README)
#   ./hosted.sh reconcile retry stuck deletes and release stale reservations (schedule this in AWS)
#   ./hosted.sh config    show the effective configuration, never a secret value
#   ./hosted.sh smoke ... live ElevenLabs check with YOUR key: see scripts/elevenlabs_smoke.py
set -euo pipefail
cd "$(dirname "$0")"
PY=.venv-hosted/bin/python
case "${1:-}" in
  setup)
    if command -v uv >/dev/null 2>&1; then UV=uv; else
      [ -x .tools/bin/uv ] || { python3 -m venv .tools && .tools/bin/pip install --quiet uv; }
      UV=.tools/bin/uv
    fi
    [ -d .venv-hosted ] || $UV venv --python 3.12 .venv-hosted
    $UV pip install --python "$PY" -r requirements-hosted.txt
    echo "Done. Try: ./hosted.sh test" ;;
  test)  shift; exec "$PY" -m pytest -q tests_hosted "$@" ;;
  serve) shift; exec "$PY" -m voice_sidecar.hosted_main serve "$@" ;;
  reconcile) shift; exec "$PY" -m voice_sidecar.hosted_main reconcile "$@" ;;
  config) shift; exec "$PY" -m voice_sidecar.hosted_main check-config "$@" ;;
  check-table) shift; exec "$PY" -c "
import os, sys
from voice_sidecar.records import DynamoRecordStore
from voice_sidecar.records_check import check_store
t = os.environ.get('VOICE_TABLE_NAME') or sys.exit('Set VOICE_TABLE_NAME (and AWS credentials/region).')
for step in check_store(DynamoRecordStore(t, region=os.environ.get('AWS_REGION'))): print('ok  ', step)
print('table', t, 'passed')" ;;
  smoke) shift; exec "$PY" scripts/elevenlabs_smoke.py "$@" ;;
  *) echo "usage: ./hosted.sh setup|test|serve|reconcile|config|check-table|smoke" >&2; exit 2 ;;
esac
