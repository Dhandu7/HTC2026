"""Accounts: the store contract (memory and DynamoDB via moto), the sign-up/sign-in flows, tokens and the HTTP routes."""

import itertools
import json
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from fake_elevenlabs import API_KEY, FakeElevenLabs
from voice_sidecar import hosted_main
from voice_sidecar.accounts import (
    MAX_FAILURES,
    AccountError,
    AccountLocked,
    AccountService,
    BadCredentials,
    DynamoAccountStore,
    EmailTaken,
    MemoryAccountStore,
    PasswordHasher,
    TokenIssuer,
    VersionConflict,
)
from voice_sidecar.elevenlabs import ElevenLabsClient
from voice_sidecar.hosted import HostedConfig, HostedVoiceService
from voice_sidecar.hosted_app import create_hosted_app
from voice_sidecar.records import DynamoRecordStore, MemoryRecordStore, table_definition

HASHER = PasswordHasher(fast=True)
PW = "correct horse battery"


class Clock:
    def __init__(self):
        self.t = datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.t.isoformat(timespec="milliseconds")


@pytest.fixture(params=["memory", "dynamodb"])
def store(request):
    if request.param == "memory":
        yield MemoryAccountStore()
        return
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(**table_definition("voices"))
        yield DynamoAccountStore("voices", client=client)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def svc(store, clock):
    return AccountService(store, HASHER, now=clock)


# ---- sign up / sign in ----


def test_sign_up_stores_a_hash_never_the_password(svc, store):
    a = svc.sign_up("  Rajvir@Example.COM ", PW, "Rajvir")
    assert a.email == "rajvir@example.com" and a.user_id.startswith("u_") and a.name == "Rajvir"
    got = store.get(a.user_id)
    assert got.password_hash.startswith("$argon2id$") and PW not in got.password_hash
    assert "passwordHash" not in json.dumps(a.public()) and got.password_hash not in json.dumps(a.public())


def test_two_people_get_different_hashes_for_the_same_password(svc, store):
    a, b = svc.sign_up("a@example.com", PW), svc.sign_up("b@example.com", PW)
    assert store.get(a.user_id).password_hash != store.get(b.user_id).password_hash  # salted


def test_an_email_belongs_to_one_account(svc):
    svc.sign_up("a@example.com", PW)
    with pytest.raises(EmailTaken):
        svc.sign_up("A@Example.com", "another password 1")


@pytest.mark.parametrize("email,pw", [("not-an-email", PW), ("a@example.com", "short"), ("a@example.com", "x" * 300)])
def test_sign_up_rejects_bad_input(svc, email, pw):
    with pytest.raises(AccountError):
        svc.sign_up(email, pw)


def test_sign_in_with_the_right_password(svc):
    a = svc.sign_up("a@example.com", PW)
    assert svc.sign_in("A@EXAMPLE.com", PW).user_id == a.user_id


def test_wrong_password_and_unknown_email_get_the_same_answer(svc):
    svc.sign_up("a@example.com", PW)
    with pytest.raises(BadCredentials) as wrong:
        svc.sign_in("a@example.com", "not the password")
    with pytest.raises(BadCredentials) as unknown:
        svc.sign_in("nobody@example.com", PW)
    assert str(wrong.value) == str(unknown.value)


def test_too_many_wrong_passwords_lock_the_account_for_a_while(svc, clock):
    svc.sign_up("a@example.com", PW)
    for _ in range(MAX_FAILURES):
        with pytest.raises(BadCredentials):
            svc.sign_in("a@example.com", "not the password")
    with pytest.raises(AccountLocked) as locked:
        svc.sign_in("a@example.com", PW)  # even the right password, while locked
    assert locked.value.retry_after > 60
    clock.t += timedelta(minutes=16)
    assert svc.sign_in("a@example.com", PW)


def test_a_good_sign_in_resets_the_failure_count(svc, store):
    a = svc.sign_up("a@example.com", PW)
    for _ in range(MAX_FAILURES - 1):
        with pytest.raises(BadCredentials):
            svc.sign_in("a@example.com", "nope nope nope")
    svc.sign_in("a@example.com", PW)
    assert store.get(a.user_id).failed_logins == 0


def test_an_old_hash_is_upgraded_on_sign_in(store, clock):
    weak = AccountService(store, PasswordHasher(fast=True), now=clock)
    a = weak.sign_up("a@example.com", PW)
    old = store.get(a.user_id).password_hash
    AccountService(store, PasswordHasher(), now=clock).sign_in("a@example.com", PW)  # stronger default parameters
    new = store.get(a.user_id).password_hash
    assert new != old and new.startswith("$argon2id$")


# ---- preferences ----


def test_preferences_round_trip_per_user(svc):
    a, b = svc.sign_up("a@example.com", PW), svc.sign_up("b@example.com", PW)
    assert svc.get_prefs(a.user_id).version == 0 and svc.get_prefs(a.user_id).data == {}
    p = svc.put_prefs(a.user_id, {"settings": {"dwellMs": 1200, "ratio": 0.5}, "profile": {"people": ["Sam"]}})
    assert p.version == 1
    got = svc.get_prefs(a.user_id)
    assert got.data["settings"] == {"dwellMs": 1200, "ratio": 0.5} and got.version == 1
    assert svc.get_prefs(b.user_id).data == {}  # nobody else sees them


def test_preferences_version_check(svc):
    a = svc.sign_up("a@example.com", PW)
    svc.put_prefs(a.user_id, {"x": 1}, expected_version=0)
    svc.put_prefs(a.user_id, {"x": 2}, expected_version=1)
    with pytest.raises(VersionConflict):
        svc.put_prefs(a.user_id, {"x": 3}, expected_version=1)
    svc.put_prefs(a.user_id, {"x": 4})  # no version: last write wins
    assert svc.get_prefs(a.user_id).data == {"x": 4} and svc.get_prefs(a.user_id).version == 3


def test_preferences_must_be_a_small_object(svc):
    a = svc.sign_up("a@example.com", PW)
    with pytest.raises(AccountError):
        svc.put_prefs(a.user_id, ["not", "an", "object"])
    with pytest.raises(AccountError):
        svc.put_prefs(a.user_id, {"big": "x" * 200_000})


def test_accounts_share_the_voice_table_without_clashing():
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(**table_definition("voices"))
        accounts = AccountService(DynamoAccountStore("voices", client=client), HASHER)
        voices = DynamoRecordStore("voices", client=client)
        a = accounts.sign_up("a@example.com", PW)
        accounts.put_prefs(a.user_id, {"x": 1})
        voices.reserve(a.user_id, {"mode": "self"}, "vocaleyes-x-1", {"speed": 1.0}, 10)
        assert voices.get(a.user_id).status == "pending" and accounts.get_prefs(a.user_id).data == {"x": 1}
        assert accounts.sign_in("a@example.com", PW).user_id == a.user_id


# ---- tokens ----


def test_tokens_verify_with_the_published_key_and_carry_the_user_id():
    import jwt

    t = TokenIssuer(None, "vocaleyes-accounts")
    token, _ = t.issue("u_123")
    key = jwt.PyJWK(t.jwks()["keys"][0]).key
    claims = jwt.decode(token, key, algorithms=["RS256"], audience="vocaleyes-app", issuer="vocaleyes-accounts")
    assert claims["sub"] == "u_123"
    assert "d" not in t.jwks()["keys"][0]  # the private part is never published


def test_a_token_from_another_key_is_refused():
    a, b = TokenIssuer(None, "iss"), TokenIssuer(None, "iss")
    token, _ = b.issue("u_1")
    with pytest.raises(Exception):
        a.jwk_client().get_signing_key_from_jwt(token)


# ---- HTTP ----


@pytest.fixture
def api():
    accounts = AccountService(MemoryAccountStore(), HASHER)
    tokens = TokenIssuer(None, "vocaleyes-accounts")
    svc = HostedVoiceService(MemoryRecordStore(), ElevenLabsClient(API_KEY, transport=FakeElevenLabs().transport), HostedConfig(slot_limit=3))
    auth = hosted_main.build_auth({"AUTH_MODE": "accounts"}, "0.0.0.0", tokens)  # as deployed: no dev fallback
    return TestClient(create_hosted_app(svc, auth, accounts=accounts, tokens=tokens, auth_per_minute=50))


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_sign_up_then_use_the_token(api):
    r = api.post("/v1/auth/signup", json={"email": "a@example.com", "password": PW, "name": "A"})
    assert r.status_code == 201
    body = r.json()
    assert set(body) == {"token", "expiresAt", "user"} and "password" not in json.dumps(body).lower()
    me = api.get("/v1/me", headers=bearer(body["token"]))
    assert me.status_code == 200 and me.json()["user"]["email"] == "a@example.com"
    assert api.get("/v1/me/voice", headers=bearer(body["token"])).status_code == 404  # the voice routes accept it too


def test_sign_in_over_http(api):
    api.post("/v1/auth/signup", json={"email": "a@example.com", "password": PW})
    assert api.post("/v1/auth/signin", json={"email": "a@example.com", "password": PW}).status_code == 200
    bad = api.post("/v1/auth/signin", json={"email": "a@example.com", "password": "wrong password!"})
    assert bad.status_code == 401 and bad.json() == {"error": "email or password is wrong"}
    assert api.post("/v1/auth/signup", json={"email": "a@example.com", "password": PW}).status_code == 409


def test_preferences_over_http(api):
    token = api.post("/v1/auth/signup", json={"email": "a@example.com", "password": PW}).json()["token"]
    assert api.get("/v1/me/preferences", headers=bearer(token)).json() == {"preferences": {}, "version": 0, "updatedAt": None}
    r = api.put("/v1/me/preferences", headers=bearer(token), json={"preferences": {"settings": {"dwellMs": 900}}})
    assert r.status_code == 200 and r.json()["version"] == 1
    assert api.get("/v1/me/preferences", headers=bearer(token)).json()["preferences"] == {"settings": {"dwellMs": 900}}
    stale = api.put("/v1/me/preferences", headers=bearer(token), json={"preferences": {}, "version": 0})
    assert stale.status_code == 409


def test_without_a_valid_token_nothing_is_reachable(api):
    assert api.get("/v1/me/preferences").status_code == 401
    assert api.get("/v1/me/preferences", headers=bearer("garbage.token.here")).status_code == 401
    assert api.get("/v1/me/preferences", headers={"X-User-Id": "u_someone"}).status_code == 401  # no dev header off loopback
    other = TokenIssuer(None, "vocaleyes-accounts").issue("u_victim")[0]  # right claims, wrong key
    assert api.get("/v1/me/preferences", headers=bearer(other)).status_code == 401


def test_jwks_is_public(api):
    assert api.get("/.well-known/jwks.json").json()["keys"][0]["alg"] == "RS256"


def test_sign_in_is_throttled_per_address():
    accounts = AccountService(MemoryAccountStore(), HASHER)
    tokens = TokenIssuer(None, "iss")
    svc = HostedVoiceService(MemoryRecordStore(), ElevenLabsClient(API_KEY, transport=FakeElevenLabs().transport), HostedConfig())
    client = TestClient(create_hosted_app(svc, hosted_main.build_auth({"AUTH_MODE": "accounts"}, "0.0.0.0", tokens), accounts=accounts, tokens=tokens, auth_per_minute=3))
    codes = [client.post("/v1/auth/signin", json={"email": "a@example.com", "password": "whatever123"}).status_code for _ in range(5)]
    assert codes == [401, 401, 401, 429, 429]


# ---- configuration ----


def test_accounts_mode_needs_a_real_signing_key_off_a_laptop():
    with pytest.raises(SystemExit):
        hosted_main.load_signing_key({}, "0.0.0.0")
    assert hosted_main.load_signing_key({}, "127.0.0.1") is None  # throwaway key, laptop only


def test_signing_key_from_secrets_manager():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()

    class FakeSecrets:
        def get_secret_value(self, SecretId):
            assert SecretId == "vocaleyes/accounts-signing-key"
            return {"SecretString": json.dumps({"private_key": pem})}

    got = hosted_main.load_signing_key({"ACCOUNTS_SIGNING_KEY_SECRET_ID": "vocaleyes/accounts-signing-key"}, "0.0.0.0", FakeSecrets())
    assert got == pem and TokenIssuer(got, "iss").kid


def test_on_a_laptop_accounts_mode_also_accepts_the_dev_login():
    tokens = TokenIssuer(None, "iss")
    auth = hosted_main.build_auth({"AUTH_MODE": "accounts"}, "127.0.0.1", tokens)

    class Req:
        def __init__(self, h):
            self.headers = h

    assert auth.user_id(Req({"x-user-id": "dev-abc"})) == "dev-abc"
    assert auth.user_id(Req({"authorization": "Bearer " + tokens.issue("u_1")[0]})) == "u_1"
    from voice_sidecar.auth import AuthError

    with pytest.raises(AuthError):  # a bad token never falls back to the header
        auth.user_id(Req({"authorization": "Bearer nope.nope.nope", "x-user-id": "dev-abc"}))
