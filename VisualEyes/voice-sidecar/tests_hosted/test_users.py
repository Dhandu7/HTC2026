"""Auth0 sign-in: token checks, the profile and preferences stores (memory and DynamoDB via moto), and the routes.

A locally generated RSA key stands in for Auth0's signing key, so nothing here needs a network or a tenant."""

import json
from datetime import datetime, timedelta, timezone

import boto3
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from moto import mock_aws

from fake_elevenlabs import API_KEY, FakeElevenLabs
from voice_sidecar import hosted_main
from voice_sidecar.auth import AuthError
from voice_sidecar.elevenlabs import ElevenLabsClient
from voice_sidecar.hosted import HostedConfig, HostedVoiceService
from voice_sidecar.hosted_app import create_hosted_app
from voice_sidecar.records import DynamoRecordStore, MemoryRecordStore, table_definition
from voice_sidecar.users import Auth0UserInfo, DynamoUserStore, MemoryUserStore, Profile, UserError, UserService, VersionConflict

DOMAIN, AUDIENCE = "vocaleyes.us.auth0.com", "https://api.vocaleyes.test"
ENV = {"AUTH_MODE": "auth0", "AUTH0_DOMAIN": DOMAIN, "AUTH0_AUDIENCE": AUDIENCE}
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
SUB = "google-oauth2|104857"


class FakeJwks:
    """Plays Auth0's JWKS endpoint: the key with kid "k1" is the tenant's."""

    def get_signing_key_from_jwt(self, token):
        if jwt.get_unverified_header(token).get("kid") != "k1":
            raise jwt.InvalidTokenError("unknown kid")
        return type("K", (), {"key": KEY.public_key()})()


def token(sub=SUB, key=KEY, iss=f"https://{DOMAIN}/", aud=(AUDIENCE, f"https://{DOMAIN}/userinfo"), exp_min=60, kid="k1", alg="RS256"):
    now = datetime.now(timezone.utc)
    claims = {"sub": sub, "iss": iss, "aud": list(aud), "iat": now, "exp": now + timedelta(minutes=exp_min), "scope": "openid profile email"}
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


class Req:
    def __init__(self, headers):
        self.headers = {k.lower(): v for k, v in headers.items()}


def bearer(t):
    return {"Authorization": f"Bearer {t}"}


# ---- tokens ----


def test_a_real_auth0_token_gives_its_sub():
    auth = hosted_main.build_auth(ENV, "0.0.0.0", FakeJwks())
    assert auth.user_id(Req(bearer(token()))) == SUB


@pytest.mark.parametrize(
    "bad",
    [
        dict(key=OTHER_KEY),  # forged: right kid, wrong key
        dict(iss="https://evil.auth0.com/"),
        dict(iss=f"https://{DOMAIN}"),  # Auth0's issuer has the trailing slash
        dict(aud=("https://some-other-api",)),
        dict(exp_min=-5),
        dict(kid="k2"),
        dict(sub="bad sub with spaces"),
    ],
)
def test_bad_tokens_are_refused(bad):
    auth = hosted_main.build_auth(ENV, "0.0.0.0", FakeJwks())
    with pytest.raises(AuthError):
        auth.user_id(Req(bearer(token(**bad))))


def test_a_symmetric_token_is_refused():
    t = jwt.encode({"sub": SUB, "iss": f"https://{DOMAIN}/", "aud": AUDIENCE, "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, "x" * 32, algorithm="HS256", headers={"kid": "k1"})
    with pytest.raises(AuthError):
        hosted_main.build_auth(ENV, "0.0.0.0", FakeJwks()).user_id(Req(bearer(t)))


def test_off_a_laptop_the_dev_header_is_refused_and_on_one_it_works():
    with pytest.raises(AuthError):
        hosted_main.build_auth(ENV, "0.0.0.0", FakeJwks()).user_id(Req({"X-User-Id": "dev-abc"}))
    local = hosted_main.build_auth(ENV, "127.0.0.1", FakeJwks())
    assert local.user_id(Req({"X-User-Id": "dev-abc"})) == "dev-abc"
    assert local.user_id(Req(bearer(token()))) == SUB
    with pytest.raises(AuthError):  # a bad token never falls back to the header
        local.user_id(Req({**bearer("nope.nope.nope"), "X-User-Id": "dev-abc"}))


def test_auth0_mode_needs_domain_and_audience():
    with pytest.raises(SystemExit):
        hosted_main.build_auth({"AUTH_MODE": "auth0", "AUTH0_DOMAIN": DOMAIN}, "0.0.0.0", FakeJwks())
    a = hosted_main.build_auth({**ENV, "AUTH0_DOMAIN": f"https://{DOMAIN}/"}, "0.0.0.0", FakeJwks())  # pasted as a URL: still fine
    assert a.user_id(Req(bearer(token()))) == SUB


def test_the_jwks_url_is_auth0s():
    a = hosted_main.build_auth(ENV, "0.0.0.0")
    assert a._jwks.uri == f"https://{DOMAIN}/.well-known/jwks.json"


# ---- stores ----


@pytest.fixture(params=["memory", "dynamodb"])
def store(request):
    if request.param == "memory":
        yield MemoryUserStore()
        return
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(**table_definition("voices"))
        yield DynamoUserStore("voices", client=client)


def test_preferences_round_trip_per_user(store):
    svc = UserService(store)
    assert svc.get_prefs(SUB).version == 0 and svc.get_prefs(SUB).data == {}
    assert svc.put_prefs(SUB, {"settings": {"dwellMs": 1200, "ratio": 0.5}}).version == 1
    assert svc.get_prefs(SUB).data == {"settings": {"dwellMs": 1200, "ratio": 0.5}}
    assert svc.get_prefs("auth0|someone-else").data == {}


def test_preferences_version_check(store):
    svc = UserService(store)
    svc.put_prefs(SUB, {"x": 1}, expected_version=0)
    with pytest.raises(VersionConflict):
        svc.put_prefs(SUB, {"x": 2}, expected_version=0)
    svc.put_prefs(SUB, {"x": 2}, expected_version=1)
    with pytest.raises(VersionConflict):
        svc.put_prefs(SUB, {"x": 3}, expected_version=1)
    svc.put_prefs(SUB, {"x": 4})
    assert svc.get_prefs(SUB).data == {"x": 4} and svc.get_prefs(SUB).version == 3


def test_preferences_must_be_a_small_object(store):
    svc = UserService(store)
    with pytest.raises(UserError):
        svc.put_prefs(SUB, ["no"])
    with pytest.raises(UserError):
        svc.put_prefs(SUB, {"big": "x" * 200_000})


def test_profile_round_trip(store):
    store.put_profile(Profile(SUB, "r@example.com", "R", True, "2026-11-07T12:00:00.000+00:00"))
    p = store.get_profile(SUB)
    assert (p.email, p.name, p.email_verified) == ("r@example.com", "R", True)
    assert store.get_profile("auth0|nobody") is None


def test_users_share_the_voice_table_without_clashing():
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(**table_definition("voices"))
        users, voices = UserService(DynamoUserStore("voices", client=client)), DynamoRecordStore("voices", client=client)
        users.put_prefs(SUB, {"x": 1})
        voices.reserve(SUB, {"mode": "self"}, "vocaleyes-x-1", {"speed": 1.0}, 10)
        assert voices.get(SUB).status == "pending" and users.get_prefs(SUB).data == {"x": 1}


# ---- the profile from Auth0's /userinfo ----


def userinfo_transport(body, status=200, calls=None):
    def handler(req: httpx.Request):
        if calls is not None:
            calls.append(req)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler)


class Clock:
    def __init__(self):
        self.t = datetime(2026, 11, 7, 12, tzinfo=timezone.utc)

    def __call__(self):
        return self.t.isoformat(timespec="milliseconds")


def test_me_copies_the_verified_profile_from_auth0_and_caches_it():
    calls, clock = [], Clock()
    info = Auth0UserInfo(DOMAIN, transport=userinfo_transport({"sub": SUB, "email": "r@example.com", "email_verified": True, "name": "Rajvir"}, calls=calls))
    svc = UserService(MemoryUserStore(), info, now=clock)
    p = svc.me(SUB, "the-access-token")
    assert (p.email, p.name, p.email_verified) == ("r@example.com", "Rajvir", True)
    assert str(calls[0].url) == f"https://{DOMAIN}/userinfo" and calls[0].headers["authorization"] == "Bearer the-access-token"
    svc.me(SUB, "the-access-token")
    assert len(calls) == 1  # cached: Auth0 rate-limits /userinfo
    clock.t += timedelta(minutes=11)
    svc.me(SUB, "the-access-token")
    assert len(calls) == 2


def test_me_never_stores_another_users_profile():
    info = Auth0UserInfo(DOMAIN, transport=userinfo_transport({"sub": "auth0|victim", "email": "victim@example.com"}))
    store = MemoryUserStore()
    assert UserService(store, info).me(SUB, "t").email is None and store.get_profile(SUB) is None


def test_me_survives_auth0_being_down():
    info = Auth0UserInfo(DOMAIN, transport=userinfo_transport({"error": "x"}, status=503))
    assert UserService(MemoryUserStore(), info).me(SUB, "t").user_id == SUB


# ---- HTTP ----


@pytest.fixture
def api():
    users = UserService(MemoryUserStore(), Auth0UserInfo(DOMAIN, transport=userinfo_transport({"sub": SUB, "email": "r@example.com", "name": "R"})))
    svc = HostedVoiceService(MemoryRecordStore(), ElevenLabsClient(API_KEY, transport=FakeElevenLabs().transport), HostedConfig(slot_limit=3))
    return TestClient(create_hosted_app(svc, hosted_main.build_auth(ENV, "0.0.0.0", FakeJwks()), users=users))


def test_signed_in_routes(api):
    t = token()
    assert api.get("/v1/me", headers=bearer(t)).json()["user"] == {"userId": SUB, "email": "r@example.com", "name": "R", "emailVerified": False}
    assert api.get("/v1/me/preferences", headers=bearer(t)).json() == {"preferences": {}, "version": 0, "updatedAt": None}
    r = api.put("/v1/me/preferences", headers=bearer(t), json={"preferences": {"settings": {"dwellMs": 900}}})
    assert r.status_code == 200 and r.json()["version"] == 1
    assert api.get("/v1/me/preferences", headers=bearer(t)).json()["preferences"] == {"settings": {"dwellMs": 900}}
    assert api.put("/v1/me/preferences", headers=bearer(t), json={"preferences": {}, "version": 0}).status_code == 409
    assert api.get("/v1/me/voice", headers=bearer(t)).status_code == 404  # the voice routes take the same token


def test_without_a_valid_token_nothing_is_reachable(api):
    assert api.get("/v1/me/preferences").status_code == 401
    assert api.get("/v1/me/preferences", headers=bearer(token(key=OTHER_KEY))).status_code == 401
    assert api.get("/v1/me", headers={"X-User-Id": SUB}).status_code == 401


def test_the_password_routes_are_gone(api):
    assert api.post("/v1/auth/signup", json={}).status_code == 404
    assert api.post("/v1/auth/signin", json={}).status_code == 404
