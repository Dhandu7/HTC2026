import io
import json

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import voice_sidecar.hosted_app as hosted_app
from fake_elevenlabs import API_KEY, FakeElevenLabs
from voice_sidecar.auth import DevAuth
from voice_sidecar.elevenlabs import ElevenLabsClient
from voice_sidecar.hosted import CONSENT_VERSION, HostedConfig, HostedVoiceService
from voice_sidecar.hosted_app import create_hosted_app
from voice_sidecar.records import MemoryRecordStore

CONSENT = {"mode": "self", "acknowledged": True, "remoteProcessingAcknowledged": True, "consentVersion": CONSENT_VERSION}


def speech(seconds=12.0, sr=24000, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    y = (0.3 * (0.55 + 0.45 * np.sin(2 * np.pi * 4 * t)) * rng.standard_normal(len(t)) * 0.5).clip(-0.95, 0.95).astype(np.float32)
    b = io.BytesIO()
    sf.write(b, y, sr, format="WAV", subtype="PCM_16")
    return b.getvalue()


def A(user):
    return {"X-User-Id": user}


@pytest.fixture
def env():
    fake = FakeElevenLabs()
    store = MemoryRecordStore()
    svc = HostedVoiceService(store, ElevenLabsClient(API_KEY, transport=fake.transport), HostedConfig(slot_limit=3))
    app = create_hosted_app(svc, DevAuth(), speak_per_minute=5)
    return TestClient(app), store, fake


def create(client, user="alice", consent=CONSENT, files=None):
    files = files or [("files", ("hello.wav", speech(12.0), "audio/wav"))]
    return client.post("/v1/me/voice", headers=A(user), data={"consent": json.dumps(consent)}, files=files)


def test_open_endpoints_need_no_login_and_reveal_nothing_private(env):
    client, _, _ = env
    assert client.get("/health").json()["ok"] is True
    t = client.get("/v1/consent-text").json()
    assert t["version"] == CONSENT_VERSION and len(t["statements"]) >= 4
    assert any("ElevenLabs" in s for s in t["statements"])  # people are told where their data goes


@pytest.mark.parametrize("call", [
    lambda c: c.get("/v1/me/voice"),
    lambda c: c.post("/v1/me/voice/speak", json={"text": "hi"}),
    lambda c: c.patch("/v1/me/voice", json={"paused": True}),
    lambda c: c.delete("/v1/me/voice"),
    lambda c: c.post("/v1/me/voice", data={"consent": "{}"}, files=[("files", ("a.wav", b"x", "audio/wav"))]),
])
def test_every_user_route_needs_a_login(env, call):
    client, store, fake = env
    r = call(client)
    assert r.status_code == 401 and fake.requests == [] and store.slots_used() == 0


def test_create_returns_the_public_view_and_never_the_elevenlabs_voice_id(env):
    client, store, fake = env
    r = create(client)
    assert r.status_code == 201, r.text
    body = r.json()
    voice_id = store.get("alice").voice_id
    assert body["voice"]["status"] == "active" and body["skippedClips"] == []
    assert voice_id not in r.text and "alice" not in r.text and API_KEY not in r.text
    g = client.get("/v1/me/voice", headers=A("alice"))
    assert g.status_code == 200 and voice_id not in g.text


def test_users_cannot_see_use_change_or_delete_each_others_voices(env):
    client, store, fake = env
    create(client, "alice")
    assert client.get("/v1/me/voice", headers=A("bob")).status_code == 404
    assert client.post("/v1/me/voice/speak", headers=A("bob"), json={"text": "hi"}).status_code == 404
    assert client.patch("/v1/me/voice", headers=A("bob"), json={"paused": True}).status_code in (404, 409)
    assert client.delete("/v1/me/voice", headers=A("bob")).status_code == 404
    assert store.get("alice").status == "active" and fake.speak_calls == []  # alice's voice is untouched and never spoke for bob


def test_a_request_cannot_name_another_users_voice(env):
    client, store, fake = env
    create(client, "alice")
    stolen = store.get("alice").voice_id
    for body in ({"text": "hi", "voiceId": stolen}, {"text": "hi", "settings": {"voiceId": stolen}}):
        r = client.post("/v1/me/voice/speak", headers=A("bob"), json=body)
        assert r.status_code in (404, 400)
    assert fake.speak_calls == []


def test_consent_problems_are_explained_and_nothing_is_created(env):
    client, store, fake = env
    r = create(client, consent={**CONSENT, "remoteProcessingAcknowledged": False})
    assert r.status_code == 422 and "ElevenLabs" in r.json()["error"]
    r = create(client, consent={**CONSENT, "consentVersion": "stale"})
    assert r.status_code == 422 and CONSENT_VERSION in r.json()["error"]
    r = client.post("/v1/me/voice", headers=A("alice"), data={"consent": "not json"}, files=[("files", ("a.wav", speech(), "audio/wav"))])
    assert r.status_code == 400
    assert store.slots_used() == 0 and fake.requests == []


def test_unusable_clips_are_explained(env):
    client, store, fake = env
    r = create(client, files=[("files", ("junk.wav", b"not audio", "audio/wav"))])
    assert r.status_code == 422 and r.json()["skippedClips"][0]["label"] == "junk"
    assert store.slots_used() == 0 and fake.requests == []


def test_a_large_file_and_an_unusual_name_are_accepted_up_to_the_limits(env, monkeypatch):
    """Inputs are not limited to a list of types or to small files: the service decides by decoding."""
    client, _, _ = env
    r = create(client, files=[("files", ("my recording (final) v2.XYZ", speech(12.0), "application/octet-stream"))])
    assert r.status_code == 201, r.text  # an odd extension and a generic content type do not matter
    assert hosted_app.MAX_FILE_BYTES >= 100 * 1024 * 1024 and hosted_app.MAX_UPLOAD_BYTES >= 200 * 1024 * 1024


def test_upload_limits(env, monkeypatch):
    client, store, fake = env
    monkeypatch.setattr(hosted_app, "MAX_FILE_BYTES", 1000)
    assert create(client).status_code == 400
    monkeypatch.setattr(hosted_app, "MAX_FILE_BYTES", 10**9)
    monkeypatch.setattr(hosted_app, "MAX_FILES", 1)
    two = [("files", ("a.wav", speech(), "audio/wav")), ("files", ("b.wav", speech(), "audio/wav"))]
    assert create(client, files=two).status_code == 400
    assert store.slots_used() == 0


def test_one_voice_per_user_and_slot_cap_surface_as_409(env):
    client, _, _ = env
    assert create(client, "a").status_code == 201
    assert create(client, "a").status_code == 409
    create(client, "b"), create(client, "c")
    r = create(client, "d")  # slot_limit is 3
    assert r.status_code == 409 and "slot" in r.json()["error"]


def test_speak_returns_labelled_audio(env):
    client, _, fake = env
    create(client)
    r = client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "Hello, it's me."})
    assert r.status_code == 200 and r.content == b"ID3fake-mp3-bytes" and r.headers["content-type"] == "audio/mpeg"
    assert r.headers["x-ai-assisted"] == "true" and r.headers["x-model-id"] == "eleven_flash_v2_5" and r.headers["cache-control"] == "no-store"
    assert int(r.headers["x-render-ms"]) >= 0


def test_settings_patch_pause_and_validation(env):
    client, store, fake = env
    create(client)
    r = client.patch("/v1/me/voice", headers=A("alice"), json={"settings": {"stability": 0.9, "speed": 5}})
    assert r.status_code == 200 and r.json()["voice"]["settings"]["stability"] == 0.9 and r.json()["voice"]["settings"]["speed"] == 1.2
    assert client.patch("/v1/me/voice", headers=A("alice"), json={"settings": {"modelId": "nope"}}).status_code == 400
    assert client.patch("/v1/me/voice", headers=A("alice"), json={}).status_code == 400
    assert client.patch("/v1/me/voice", headers=A("alice"), json={"paused": True}).json()["voice"]["status"] == "paused"
    assert client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"}).status_code == 423
    client.patch("/v1/me/voice", headers=A("alice"), json={"paused": False})
    assert client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"}).status_code == 200


def test_speak_is_rate_limited_per_user(env):
    client, _, fake = env
    create(client, "alice"), create(client, "bob")
    codes = [client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"}).status_code for _ in range(7)]
    assert codes == [200] * 5 + [429, 429]
    r = client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"})
    assert int(r.headers["retry-after"]) >= 1
    assert client.post("/v1/me/voice/speak", headers=A("bob"), json={"text": "hi"}).status_code == 200  # another user is unaffected
    assert len(fake.speak_calls) == 6  # throttled requests never reached ElevenLabs


def test_upstream_failures_are_translated_without_leaking_details(env):
    client, _, fake = env
    create(client)
    fake.fail("speak", 429)
    r = client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"})
    assert r.status_code == 429 and r.headers["retry-after"] == "7"
    fake.fail("speak", 500)
    r = client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"})
    assert r.status_code == 502 and API_KEY not in r.text and "xi-api-key" not in r.text


def test_delete_then_a_failed_delete_is_retried(env):
    client, store, fake = env
    create(client)
    fake.fail("delete", 500)
    r = client.delete("/v1/me/voice", headers=A("alice"))
    assert r.status_code == 502 and "retried" in r.json()["error"]
    assert client.get("/v1/me/voice", headers=A("alice")).json()["voice"]["status"] == "deleting"
    assert client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"}).status_code == 409
    assert client.delete("/v1/me/voice", headers=A("alice")).status_code == 200  # the user can simply retry
    assert fake.voices == {} and client.get("/v1/me/voice", headers=A("alice")).status_code == 404 and store.slots_used() == 0


def test_the_browser_preflight_check_passes_for_the_app_origin_and_not_for_others():
    """A browser sends this check before any call that carries a custom header. If it fails, the app cannot reach the service at all."""
    fake = FakeElevenLabs()
    svc = HostedVoiceService(MemoryRecordStore(), ElevenLabsClient(API_KEY, transport=fake.transport), HostedConfig())
    client = TestClient(create_hosted_app(svc, DevAuth(), cors_origins=("http://localhost:5173",)))
    ask = lambda origin, headers: client.options("/v1/me/voice", headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": headers})
    for headers in ("x-user-id", "authorization", "content-type", "authorization,content-type"):
        ok = ask("http://localhost:5173", headers)
        assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "http://localhost:5173", headers
    other = ask("https://evil.example.com", "x-user-id")
    assert "access-control-allow-origin" not in other.headers  # a page from another site is not let in
    assert ask("http://localhost:5173", "x-something-else").status_code == 400  # and unknown headers are not blessed


def test_the_verification_story_over_the_api(env):
    client, store, fake = env
    fake.require_verification = True
    r = create(client)
    assert r.status_code == 201 and r.json()["voice"]["needsVerification"] is True
    name = store.get("alice").voice_name
    s = client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"})
    assert s.status_code == 409 and name in s.json()["error"] and "API key" not in s.json()["error"]
    fake.verify(store.get("alice").voice_id)
    assert client.post("/v1/me/voice/speak", headers=A("alice"), json={"text": "hi"}).status_code == 200
    assert "needsVerification" not in client.get("/v1/me/voice", headers=A("alice")).json()["voice"]
