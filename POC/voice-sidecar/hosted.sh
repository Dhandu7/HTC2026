#!/usr/bin/env bash
# Helper for the hosted (ElevenLabs + DynamoDB) voice service.
#   ./hosted.sh setup     create .venv-hosted (Python 3.12) and install the light requirements
#   POC/.env              paste ELEVENLABS_API_KEY=... into POC/.env, shared with the Node server (git ignores it), or:
#   ./hosted.sh key-set   store your ElevenLabs key in the macOS Keychain (prompts; never shown)
#   ./hosted.sh key-check / key-delete
#   ./hosted.sh doctor    is the key accepted, does the plan allow cloning, how many voice slots are free? (read-only)
#   ./hosted.sh dev       whole stack on your laptop with a FAKE ElevenLabs: no key, no AWS
#   ./hosted.sh test      run the tests (no AWS account or ElevenLabs key needed)
#   ./hosted.sh check-table  run the lifecycle check against the REAL DynamoDB table (needs AWS credentials)
#   ./hosted.sh local     run the API on YOUR machine for the app (sets up Python if needed, in-memory, test login, your key)
#   ./hosted.sh serve     run the API (reads configuration from the environment, see README)
#   ./hosted.sh reconcile retry stuck deletes and release stale reservations (schedule this in AWS)
#   ./hosted.sh config    show the effective configuration, never a secret value
#   ./hosted.sh smoke ... live ElevenLabs check with YOUR key: see scripts/elevenlabs_smoke.py
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"   # absolute, because we cd below and $0 may be relative
cd "$(dirname "$0")"
PY="${VOICE_PY:-.venv-hosted/bin/python}"   # VOICE_PY exists so the tests can stand in for Python

# --- the ElevenLabs key: from your environment, else POC/.env (one folder up), else the macOS Keychain ---
# It is never printed, never put on a command line, and the .env file is ignored by git. Only ELEVENLABS_API_KEY is read.
ENV_FILE="${VOICE_ENV_FILE:-../.env}"   # POC/.env, the same file the Node server reads
KEY_SERVICE="vocaleyes-elevenlabs-api-key"
have_keychain() { command -v security >/dev/null 2>&1; }
# The value of one variable from the .env file. The file is READ, never run as a script.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | head -n 1 \
    | sed -E "s/[[:space:]]+#.*$//; s/[[:space:]]+$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}
# Say so if a stored value does not look like an API key (they start with sk_). Never shows the value.
shape_hint() {
  case "$1" in
    ""|sk_*) ;;
    *) echo "  warning: the value found in $2 does not start with sk_. ElevenLabs API keys do, so this is probably the key's ID, not the key. Create or rotate a key and copy the one that starts with sk_." ;;
  esac
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
    case "$(uname -s 2>/dev/null)" in
      MINGW*|MSYS*|CYGWIN*) echo "This script needs a Unix-style shell with a POSIX layout (macOS, Linux, or WSL). Git Bash on Windows is not enough: run it inside WSL." >&2; exit 2 ;;
    esac
    if command -v uv >/dev/null 2>&1; then UV=uv; else
      if [ ! -x .tools/bin/uv ]; then
        python3 -m venv .tools 2>/dev/null || { rm -rf .tools; echo "Could not create a Python virtual environment with python3 ($(python3 --version 2>&1)). On Debian/Ubuntu run: sudo apt install python3-venv python3-pip. Or install uv (https://docs.astral.sh/uv/) and run this again." >&2; exit 1; }
        .tools/bin/pip install --quiet uv || { echo "Could not install uv with pip (no internet, or a proxy?). Install uv yourself (https://docs.astral.sh/uv/) and run this again." >&2; exit 1; }
      fi
      UV=.tools/bin/uv
    fi
    # The service is tested on Python 3.12, so uv fetches that exact version whatever python3 you have.
    [ -d .venv-hosted ] || $UV venv --python 3.12 .venv-hosted || { echo "Could not create the Python 3.12 environment. uv downloads Python 3.12 the first time, so it needs internet access. If you have Python 3.12 installed, run: $UV venv --python /path/to/python3.12 .venv-hosted" >&2; exit 1; }
    $UV pip install --python "$PY" -r requirements.txt || { echo "Installing the requirements failed (see above). Delete the .venv-hosted folder and run this again." >&2; exit 1; }
    echo "Done. Try: ./hosted.sh test" ;;
  key-set)
    have_keychain || { echo "key-set uses the macOS Keychain. On Linux or in AWS, put the key in a secrets manager (see docs/AWS_VOICE_HANDOFF.md)." >&2; exit 2; }
    echo "Paste your ElevenLabs API key when asked. Nothing is shown and nothing is saved to a file or your shell history."
    # -w as the LAST option makes `security` prompt for the value, so the key never appears in the process list.
    security add-generic-password -a "${USER:-user}" -s "$KEY_SERVICE" -U -w
    echo "Stored in your login Keychain as '$KEY_SERVICE'. Check with: ./hosted.sh key-check" ;;
  key-check)
    where=""; hints=""
    fv="$(env_value ELEVENLABS_API_KEY)"
    if [ -n "$fv" ]; then where="$where ${ENV_FILE}"; hints="$hints$(shape_hint "$fv" "${ENV_FILE}")"; fi
    if have_keychain && security find-generic-password -a "${USER:-user}" -s "$KEY_SERVICE" >/dev/null 2>&1; then
      where="$where Keychain"
      kv="$(security find-generic-password -a "${USER:-user}" -s "$KEY_SERVICE" -w 2>/dev/null || true)"
      hints="$hints$(shape_hint "$kv" "the Keychain")"
    fi
    if [ -n "$where" ]; then echo "key: found in:$where (not shown)"; [ -z "$hints" ] || echo "$hints"; else echo "key: not found. Paste it into $(pwd)/${ENV_FILE} (ELEVENLABS_API_KEY=...) or run ./hosted.sh key-set"; exit 1; fi ;;
  key-delete)
    have_keychain || { echo "no Keychain here"; exit 2; }
    security delete-generic-password -a "${USER:-user}" -s "$KEY_SERVICE" >/dev/null && echo "key removed from the Keychain" || echo "no stored key to remove" ;;
  dev)
    # The whole stack on your laptop with NO key and no AWS: the service in memory plus a fake ElevenLabs that
    # makes tones, not speech. For building and trying the app screens.
    shift; exec "$PY" scripts/dev_stack.py "$@" ;;
  test)  shift; exec "$PY" -m pytest -q tests_hosted "$@" ;;
  local)
    # The one command a teammate needs: first run installs Python 3.12 deps, then serves the API for the app on
    # this machine only (127.0.0.1, in memory, the dev test login). Anything you set yourself still wins.
    shift
    [ -x "$PY" ] || bash "$SELF" setup
    export VOICE_STORE="${VOICE_STORE:-memory}" AUTH_MODE="${AUTH_MODE:-dev}"
    export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173,http://127.0.0.1:5173}"
    load_key
    if [ -z "${ELEVENLABS_API_KEY:-}" ] && [ -z "${ELEVENLABS_SECRET_ID:-}" ]; then
      echo "No ElevenLabs key found. Copy POC/.env.example to POC/.env and put your key after ELEVENLABS_API_KEY= (it starts with sk_), or run ./hosted.sh key-set. Then run this again." >&2
      exit 1
    fi
    echo "Voice service for this machine only: voices are kept in memory, so they are forgotten when this stops."
    exec "$PY" -m voice_sidecar.hosted_main serve "$@" ;;
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
  *) echo "usage: ./hosted.sh setup|local|test|dev|key-set|key-check|key-delete|doctor|serve|reconcile|config|check-table|smoke" >&2; exit 2 ;;
esac
