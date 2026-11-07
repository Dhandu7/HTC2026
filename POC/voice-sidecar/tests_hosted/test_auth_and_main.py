import json
import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from voice_sidecar.auth import AuthError, DevAuth, JwtAuth
from voice_sidecar import hosted_main
from voice_sidecar.hosted_main import build_auth, check_config, load_api_key

ISS = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST"


def req(**headers):
    return SimpleNamespace(headers={k.lower().replace("_", "-"): v for k, v in headers.items()})


def keypair():
    k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return k, k.public_key()


PRIV, PUB = keypair()
OTHER_PRIV, _ = keypair()


class FakeJwks:
    def __init__(self, pub):
        self.pub = pub

    def get_signing_key_from_jwt(self, token):
        return SimpleNamespace(key=self.pub)


def token(claims=None, key=PRIV, alg="RS256"):
    c = {"iss": ISS, "sub": "user-123", "exp": int(time.time()) + 600, "aud": "app-client"}
    c.update(claims or {})
    c = {k: v for k, v in c.items() if v is not None}
    return jwt.encode(c, key, algorithm=alg)


def auth(audience="app-client"):
    return JwtAuth(ISS, audience, jwk_client=FakeJwks(PUB))


def bearer(t):
    return req(authorization=f"Bearer {t}")


def test_a_valid_token_yields_the_sub_as_the_user_id():
    assert auth().user_id(bearer(token())) == "user-123"


@pytest.mark.parametrize(
    "make",
    [
        lambda: token({"exp": int(time.time()) - 3600}),  # expired
        lambda: token({"iss": "https://evil.example.com"}),  # wrong issuer
        lambda: token(key=OTHER_PRIV),  # signed by someone else
        lambda: token({"aud": "another-app"}),  # wrong audience
        lambda: token({"sub": None}),  # no subject
        lambda: token({"sub": "bad user/../id"}),  # a subject we would not trust as a key
        lambda: token({"exp": None}),  # never expires
        lambda: "not.a.jwt",
        lambda: "",
    ],
)
def test_bad_tokens_are_refused_with_no_detail(make):
    with pytest.raises(AuthError) as e:
        auth().user_id(bearer(make()))
    assert str(e.value) in ("invalid or expired token", "missing bearer token")


def test_alg_none_and_key_confusion_attacks_are_refused():
    forged_none = jwt.encode({"iss": ISS, "sub": "admin", "exp": int(time.time()) + 600, "aud": "app-client"}, key="", algorithm="none")
    pub_pem = PUB.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    # HS256 signed with the PUBLIC key as the secret: the classic confusion attack. PyJWT itself refuses to build this
    # token with a PEM key, so craft it by hand to prove OUR verifier rejects it too.
    import base64, hashlib, hmac

    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(json.dumps({"iss": ISS, "sub": "admin", "exp": int(time.time()) + 600, "aud": "app-client"}).encode())
    sig = b64(hmac.new(pub_pem, head + b"." + body, hashlib.sha256).digest())
    forged_hs = (head + b"." + body + b"." + sig).decode()
    for t in (forged_none, forged_hs):
        with pytest.raises(AuthError):
            auth().user_id(bearer(t))


def test_cognito_access_tokens_are_accepted_by_client_id():
    t = token({"aud": None, "client_id": "app-client", "token_use": "access"})
    assert auth().user_id(bearer(t)) == "user-123"
    with pytest.raises(AuthError):
        auth().user_id(bearer(token({"aud": None, "client_id": "someone-else"})))


def test_without_a_configured_audience_issuer_and_signature_still_apply():
    assert JwtAuth(ISS, None, jwk_client=FakeJwks(PUB)).user_id(bearer(token({"aud": "whatever"}))) == "user-123"
    with pytest.raises(AuthError):
        JwtAuth(ISS, None, jwk_client=FakeJwks(PUB)).user_id(bearer(token(key=OTHER_PRIV)))


def test_missing_or_malformed_authorization_headers():
    for r in (req(), req(authorization="Basic abc"), req(authorization="Bearer")):
        with pytest.raises(AuthError):
            auth().user_id(r)


def test_dev_auth_only_accepts_a_sane_header_and_is_refused_off_loopback():
    assert DevAuth().user_id(req(x_user_id="alice")) == "alice"
    for bad in ("", "a b", "../x", "x" * 200):
        with pytest.raises(AuthError):
            DevAuth().user_id(req(x_user_id=bad))
    assert build_auth({"AUTH_MODE": "dev"}, "127.0.0.1").name == "dev"
    with pytest.raises(SystemExit):
        build_auth({"AUTH_MODE": "dev"}, "0.0.0.0")
    with pytest.raises(SystemExit):
        build_auth({"AUTH_MODE": "bogus"}, "127.0.0.1")


def test_jwt_is_the_default_and_needs_an_issuer():
    with pytest.raises(ValueError):
        build_auth({}, "0.0.0.0")


class FakeSecrets:
    def __init__(self, value):
        self.value, self.asked = value, []

    def get_secret_value(self, SecretId):
        self.asked.append(SecretId)
        return {"SecretString": self.value}


def test_the_api_key_comes_from_the_environment_or_secrets_manager():
    assert load_api_key({"ELEVENLABS_API_KEY": "k1"}) == "k1"
    s = FakeSecrets(json.dumps({"api_key": "k2"}))
    assert load_api_key({"ELEVENLABS_SECRET_ID": "arn:x"}, s) == "k2" and s.asked == ["arn:x"]
    assert load_api_key({"ELEVENLABS_SECRET_ID": "n", "ELEVENLABS_SECRET_FIELD": "key"}, FakeSecrets(json.dumps({"key": "k3"}))) == "k3"
    assert load_api_key({"ELEVENLABS_SECRET_ID": "n"}, FakeSecrets("  k4\n")) == "k4"
    with pytest.raises(SystemExit):
        load_api_key({})


def test_check_config_never_contains_secret_values():
    out = json.dumps(check_config({"ELEVENLABS_API_KEY": "sk_super_secret", "ELEVENLABS_SECRET_ID": "arn:x", "VOICE_TABLE_NAME": "t"}))
    assert "sk_super_secret" not in out and "ELEVENLABS_API_KEY" in out and '"table": "t"' in out


def test_dynamodb_store_needs_a_table_name():
    with pytest.raises(SystemExit):
        hosted_main.build_store({"VOICE_STORE": "dynamodb"})
    assert type(hosted_main.build_store({"VOICE_STORE": "memory"})).__name__ == "MemoryRecordStore"
