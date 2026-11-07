#!/usr/bin/env bash
# Helper for the hosted (ElevenLabs + DynamoDB) voice service.
#   ./hosted.sh setup     create .venv-hosted (Python 3.12) and install the light requirements
#   .env                  paste ELEVENLABS_API_KEY=... into the .env file here (git ignores it), or:
#   ./hosted.sh key-set   store your ElevenLabs key in the macOS Keychain (prompts; never shown)
#   ./hosted.sh key-check / key-delete
#   ./hosted.sh doctor    is the key accepted, does the plan allow cloning, how many voice slots are free? (read-only)
#   ./hosted.sh dev       whole stack on your laptop with a FAKE ElevenLabs: no key, no AWS
#   ./hosted.sh test      run the tests (no AWS account or ElevenLabs key needed)
#   ./hosted.sh check-table  run the lifecycle check against the REAL DynamoDB table (needs AWS credentials)
#   ./hosted.sh serve     run the API (reads configuration from the environment, see README)
#   ./hosted.sh reconcile retry stuck deletes and release stale reservations (schedule this in AWS)
#   ./hosted.sh config    show the effective configuration, never a secret value
#   ./hosted.sh smoke ... live ElevenLabs check with YOUR key: see scripts/elevenlabs_smoke.py
set -euo pipefail
cd "$(dirname "$0")"
PY="${VOICE_PY:-.venv-hosted/bin/python}"   # VOICE_PY exists so the tests can stand in for Python

# --- the ElevenLabs key: from your environment, else the .env file in this folder, else the macOS Keychain ---
# It is never printed, never put on a command line, and the .env file is ignored by git.
ENV_FILE="${VOICE_ENV_FILE:-.env}"
KEY_SERVICE="vocaleyes-elevenlabs-api-key"
have_keychain() { command -v security >/dev/null 2>&1; }
# The value of one variable from the .env file. The file is READ, never run as a script.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | head -n 1 \
    | sed -E "s/[[:space:]]+#.*$//; s/[[:space:]]+$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}
# Commands that talk to ElevenLabs call this: it sets ELEVENLABS_API_KEY unless it is already set or you use Secrets Manager.
load_key() {
  if [ -z "${ELEVENLABS_API_KEY:-}" ] && [ -z "${ELEVENLABS_SECRET_ID:-}" ]; then
    local k
    k="$(env_value ELEVENLABS_API_KEY)"
    if [ -z "$k" ] && have_keychain; then
      k="$(security find-generic-password -a "${USER:-user}" -s "$KEY_SERVICE" -w 2>/dev/null || true)"
    fi
    if [ -n "$k" ]; then export ELEVENLABS_API_KEY="$k"; fi
  fi
}
case "${1:-}" in
  setup)
    if command -v uv >/dev/null 2>&1; then UV=uv; else
      [ -x .tools/bin/uv ] || { python3 -m venv .tools && .tools/bin/pip install --quiet uv; }
      UV=.tools/bin/uv
    fi
    [ -d .venv-hosted ] || $UV venv --python 3.12 .venv-hosted
    $UV pip install --python "$PY" -r requirements.txt
    echo "Done. Try: ./hosted.sh test" ;;
  key-set)
    have_keychain || { echo "key-set uses the macOS Keychain. On Linux or in AWS, put the key in a secrets manager (see docs/AWS_VOICE_HANDOFF.md)." >&2; exit 2; }
    echo "Paste your ElevenLabs API key when asked. Nothing is shown and nothing is saved to a file or your shell history."
    # -w as the LAST option makes `security` prompt for the value, so the key never appears in the process list.
    security add-generic-password -a "${USER:-user}" -s "$KEY_SERVICE" -U -w
    echo "Stored in your login Keychain as '$KEY_SERVICE'. Check with: ./hosted.sh key-check" ;;
  key-check)
    where=""
    [ -n "$(env_value ELEVENLABS_API_KEY)" ] && where="$where ${ENV_FILE}"
    if have_keychain && security find-generic-password -a "${USER:-user}" -s "$KEY_SERVICE" >/dev/null 2>&1; then where="$where Keychain"; fi
    if [ -n "$where" ]; then echo "key: found in:$where (not shown)"; else echo "key: not found. Paste it into $(pwd)/${ENV_FILE} (ELEVENLABS_API_KEY=...) or run ./hosted.sh key-set"; exit 1; fi ;;
  key-delete)
    have_keychain || { echo "no Keychain here"; exit 2; }
    security delete-generic-password -a "${USER:-user}" -s "$KEY_SERVICE" >/dev/null && echo "key removed from the Keychain" || echo "no stored key to remove" ;;
  dev)
    # The whole stack on your laptop with NO key and no AWS: the service in memory plus a fake ElevenLabs that
    # makes tones, not speech. For building and trying the app screens.
    shift; exec "$PY" scripts/dev_stack.py "$@" ;;
  test)  shift; exec "$PY" -m pytest -q tests_hosted "$@" ;;
  serve) shift; load_key; exec "$PY" -m voice_sidecar.hosted_main serve "$@" ;;
  reconcile) shift; load_key; exec "$PY" -m voice_sidecar.hosted_main reconcile "$@" ;;
  config) shift; load_key; exec "$PY" -m voice_sidecar.hosted_main check-config "$@" ;;
  check-table) shift; exec "$PY" -c "
import os, sys
from voice_sidecar.records import DynamoRecordStore
from voice_sidecar.records_check import check_store
t = os.environ.get('VOICE_TABLE_NAME') or sys.exit('Set VOICE_TABLE_NAME (and AWS credentials/region).')
for step in check_store(DynamoRecordStore(t, region=os.environ.get('AWS_REGION'))): print('ok  ', step)
print('table', t, 'passed')" ;;
  doctor) shift; load_key; exec "$PY" -m voice_sidecar.doctor "$@" ;;
  smoke) shift; load_key; exec "$PY" scripts/elevenlabs_smoke.py "$@" ;;
  *) echo "usage: ./hosted.sh setup|test|dev|key-set|key-check|key-delete|doctor|serve|reconcile|config|check-table|smoke" >&2; exit 2 ;;
esac
