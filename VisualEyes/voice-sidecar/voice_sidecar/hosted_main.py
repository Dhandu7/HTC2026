"""Entry point for the hosted voice service. Configuration comes from environment variables so the same code
runs on a laptop, in a container, or as a function. Secrets are read here and passed in; they are never printed.

  python -m voice_sidecar.hosted_main serve         run the API
  python -m voice_sidecar.hosted_main reconcile     retry stuck deletes, release stale reservations (schedule this)
  python -m voice_sidecar.hosted_main check-config  show what is configured (never secret values)

Variable                  Default                    Meaning
VOICE_STORE               dynamodb                   dynamodb | memory (memory is for local development)
VOICE_TABLE_NAME          (required for dynamodb)    the DynamoDB table (see infra/voices-table.cfn.json)
AWS_REGION                (SDK default)              region of the table and the secret
ELEVENLABS_API_KEY        -                          local development only
ELEVENLABS_SECRET_ID      -                          Secrets Manager secret (name or ARN) holding the key, in production
ELEVENLABS_SECRET_FIELD   api_key                    JSON field of the secret, if it is JSON; a plain-string secret also works
ELEVENLABS_BASE_URL       https://api.elevenlabs.io  regional endpoint if you need data residency
ELEVENLABS_MODEL_ID       eleven_flash_v2_5          default model for new voices
ELEVENLABS_OUTPUT_FORMAT  mp3_44100_128              audio format returned by /speak
VOICE_SLOT_LIMIT          10                         the ElevenLabs plan's custom-voice cap (Starter 10, Creator 30, Pro 160)
SPEAK_PER_MINUTE          60                         per-user rate limit on /speak (0 = off)
AUTH_MODE                 jwt                        jwt | accounts | dev (dev only on a loopback address)
JWT_ISSUER, JWT_AUDIENCE, JWT_JWKS_URL               for jwt (JWKS defaults to <issuer>/.well-known/jwks.json)
ACCOUNTS_ISSUER           vocaleyes-accounts         accounts: the iss claim of the tokens we sign
ACCOUNTS_SIGNING_KEY_SECRET_ID  -                    accounts: Secrets Manager secret holding the RSA private key (PEM), in production
ACCOUNTS_SIGNING_KEY      -                          accounts: the PEM itself, local development only
ACCOUNTS_TOKEN_HOURS      168                        accounts: how long a sign-in lasts
AUTH_PER_MINUTE           20                         accounts: sign-up/sign-in attempts per client address per minute
HOST, PORT                127.0.0.1, 8790            listen address
CORS_ORIGINS              (none)                     comma-separated browser origins allowed to call the API
"""

from __future__ import annotations

import json
import os
import sys
from typing import Optional

from .accounts import AccountService, DynamoAccountStore, MemoryAccountStore, TokenIssuer
from .auth import DevAuth, FirstOf, JwtAuth
from .elevenlabs import DEFAULT_BASE_URL, ElevenLabsClient, key_shape_warning
from .hosted import HostedConfig, HostedVoiceService
from .hosted_app import create_hosted_app
from .records import DynamoRecordStore, MemoryRecordStore

LOOPBACK = ("127.0.0.1", "localhost", "::1")


def load_api_key(env=os.environ, secrets_client=None) -> str:
    key = _read_api_key(env, secrets_client)
    warn = key_shape_warning(key)
    if warn:
        print(f"[hosted-voice] WARNING: {warn}", file=sys.stderr, flush=True)  # the value itself is never printed
    return key


def _read_api_key(env=os.environ, secrets_client=None) -> str:
    if env.get("ELEVENLABS_API_KEY"):
        return env["ELEVENLABS_API_KEY"]
    sid = env.get("ELEVENLABS_SECRET_ID")
    if not sid:
        raise SystemExit("Set ELEVENLABS_SECRET_ID (production) or ELEVENLABS_API_KEY (local development).")
    if secrets_client is None:
        import boto3

        secrets_client = boto3.client("secretsmanager", region_name=env.get("AWS_REGION"))
    raw = secrets_client.get_secret_value(SecretId=sid)["SecretString"]
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj[env.get("ELEVENLABS_SECRET_FIELD", "api_key")]
    except (ValueError, KeyError):
        pass
    return raw.strip()


def build_store(env=os.environ):
    kind = env.get("VOICE_STORE", "dynamodb")
    if kind == "memory":
        return MemoryRecordStore()
    if kind != "dynamodb":
        raise SystemExit("VOICE_STORE must be dynamodb or memory")
    table = env.get("VOICE_TABLE_NAME")
    if not table:
        raise SystemExit("VOICE_TABLE_NAME is required for the dynamodb store.")
    return DynamoRecordStore(table, region=env.get("AWS_REGION"))


def load_signing_key(env=os.environ, host: str = "127.0.0.1", secrets_client=None) -> Optional[str]:
    """The RSA private key (PEM) that signs account tokens. None means: make a throwaway one (laptop only)."""
    if env.get("ACCOUNTS_SIGNING_KEY"):
        return env["ACCOUNTS_SIGNING_KEY"]
    sid = env.get("ACCOUNTS_SIGNING_KEY_SECRET_ID")
    if sid:
        if secrets_client is None:
            import boto3

            secrets_client = boto3.client("secretsmanager", region_name=env.get("AWS_REGION"))
        raw = secrets_client.get_secret_value(SecretId=sid)["SecretString"]
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                return obj["private_key"]
        except (ValueError, KeyError):
            pass
        return raw
    if host not in LOOPBACK:
        raise SystemExit("AUTH_MODE=accounts needs ACCOUNTS_SIGNING_KEY_SECRET_ID (a Secrets Manager secret with the RSA private key) off a laptop.")
    print("[hosted-voice] accounts: no signing key configured, using a throwaway one (sign-ins end when this stops)", file=sys.stderr, flush=True)
    return None


def build_accounts(env=os.environ, host: str = "127.0.0.1", store=None, secrets_client=None) -> "tuple[AccountService, TokenIssuer]":
    if store is None:
        if env.get("VOICE_STORE", "dynamodb") == "memory":
            store = MemoryAccountStore()
        else:
            table = env.get("VOICE_TABLE_NAME")
            if not table:
                raise SystemExit("VOICE_TABLE_NAME is required for the dynamodb store.")
            store = DynamoAccountStore(table, region=env.get("AWS_REGION"))
    tokens = TokenIssuer(load_signing_key(env, host, secrets_client), env.get("ACCOUNTS_ISSUER", "vocaleyes-accounts"), ttl_hours=int(env.get("ACCOUNTS_TOKEN_HOURS", "168")))
    return AccountService(store), tokens


def build_auth(env=os.environ, host: str = "127.0.0.1", tokens: Optional[TokenIssuer] = None):
    mode = env.get("AUTH_MODE", "jwt")
    if mode == "dev":
        if host not in LOOPBACK:
            raise SystemExit("AUTH_MODE=dev trusts the X-User-Id header and is only allowed on a loopback HOST.")
        return DevAuth()
    if mode == "accounts":
        if tokens is None:
            raise SystemExit("AUTH_MODE=accounts needs the token issuer (build_accounts)")
        own = JwtAuth(tokens.issuer, tokens.audience, jwk_client=tokens.jwk_client())
        own.name = "accounts"
        return FirstOf(own, DevAuth()) if host in LOOPBACK else own
    if mode != "jwt":
        raise SystemExit("AUTH_MODE must be jwt, accounts or dev")
    return JwtAuth(env.get("JWT_ISSUER", ""), env.get("JWT_AUDIENCE") or None, env.get("JWT_JWKS_URL") or None)


def build_service(env=os.environ, store=None, eleven=None) -> HostedVoiceService:
    cfg = HostedConfig(
        slot_limit=int(env.get("VOICE_SLOT_LIMIT", "10")),
        output_format=env.get("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128"),
        default_model=env.get("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
    )
    eleven = eleven or ElevenLabsClient(load_api_key(env), env.get("ELEVENLABS_BASE_URL", DEFAULT_BASE_URL))
    return HostedVoiceService(store or build_store(env), eleven, cfg)


def check_config(env=os.environ) -> dict:
    """What is configured, without any secret value."""
    return {
        "store": env.get("VOICE_STORE", "dynamodb"),
        "table": env.get("VOICE_TABLE_NAME"),
        "region": env.get("AWS_REGION"),
        "elevenlabs_key_source": "ELEVENLABS_API_KEY" if env.get("ELEVENLABS_API_KEY") else ("secrets-manager" if env.get("ELEVENLABS_SECRET_ID") else None),
        "elevenlabs_key_looks_like_a_key": (key_shape_warning(env["ELEVENLABS_API_KEY"]) is None) if env.get("ELEVENLABS_API_KEY") else None,
        "elevenlabs_base_url": env.get("ELEVENLABS_BASE_URL", DEFAULT_BASE_URL),
        "model": env.get("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
        "slot_limit": int(env.get("VOICE_SLOT_LIMIT", "10")),
        "auth": env.get("AUTH_MODE", "jwt"),
        "jwt_issuer": env.get("JWT_ISSUER"),
        "accounts_signing_key_source": "ACCOUNTS_SIGNING_KEY" if env.get("ACCOUNTS_SIGNING_KEY") else ("secrets-manager" if env.get("ACCOUNTS_SIGNING_KEY_SECRET_ID") else None),
        "host": env.get("HOST", "127.0.0.1"),
        "port": int(env.get("PORT", "8790")),
    }


def main(argv: Optional[list] = None) -> int:
    cmd = (argv or sys.argv[1:] or ["serve"])[0]
    env = os.environ
    if cmd == "check-config":
        print(json.dumps(check_config(env), indent=2))
        return 0
    if cmd == "reconcile":
        print(json.dumps(build_service(env).reconcile()))
        return 0
    if cmd == "serve":
        import uvicorn

        host, port = env.get("HOST", "127.0.0.1"), int(env.get("PORT", "8790"))
        service = build_service(env)
        accounts, tokens = build_accounts(env, host) if env.get("AUTH_MODE", "jwt") == "accounts" else (None, None)
        app = create_hosted_app(
            service,
            build_auth(env, host, tokens),
            [o for o in env.get("CORS_ORIGINS", "").split(",") if o],
            int(env.get("SPEAK_PER_MINUTE", "60")),
            accounts=accounts,
            tokens=tokens,
            auth_per_minute=int(env.get("AUTH_PER_MINUTE", "20")),
        )
        print(f"[hosted-voice] store={env.get('VOICE_STORE', 'dynamodb')} auth={env.get('AUTH_MODE', 'jwt')} listening on http://{host}:{port}", flush=True)
        uvicorn.run(app, host=host, port=port, log_level="warning")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
