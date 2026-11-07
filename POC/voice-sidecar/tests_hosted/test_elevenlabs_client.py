import pytest

from fake_elevenlabs import API_KEY, FakeElevenLabs
from voice_sidecar.elevenlabs import ElevenLabsClient, ElevenLabsError, RemoteVoiceMissing, VoiceNeedsVerification

SETTINGS = {"stability": 0.4, "similarityBoost": 0.9, "style": 0.1, "speed": 1.1, "useSpeakerBoost": False}


def make(fake=None, key=API_KEY):
    fake = fake or FakeElevenLabs()
    return fake, ElevenLabsClient(key, transport=fake.transport)


def test_clone_sends_the_documented_multipart_request():
    fake, c = make()
    vid = c.clone("vocaleyes-abc", [("a.wav", b"RIFFxxxx"), ("b.wav", b"RIFFyyyy")]).voice_id
    assert vid in fake.voices and fake.voices[vid]["files"] == ["a.wav", "b.wav"] and fake.voices[vid]["name"] == "vocaleyes-abc"
    method, path, _, headers = fake.requests[0]
    assert (method, path) == ("POST", "/v1/voices/add") and headers["xi-api-key"] == API_KEY


def test_speak_sends_model_text_and_mapped_voice_settings():
    fake, c = make()
    vid = c.clone("n", [("a.wav", b"x")]).voice_id
    audio, ctype = c.synthesize(vid, "Hello there.", "eleven_flash_v2_5", SETTINGS, "mp3_44100_64")
    assert audio == b"ID3fake-mp3-bytes" and ctype == "audio/mpeg"
    call = fake.speak_calls[0]
    assert call["query"] == {"output_format": "mp3_44100_64"}
    assert call["body"] == {
        "text": "Hello there.",
        "model_id": "eleven_flash_v2_5",
        "voice_settings": {"stability": 0.4, "similarity_boost": 0.9, "style": 0.1, "speed": 1.1, "use_speaker_boost": False},
    }


def test_delete_removes_the_voice_and_a_missing_voice_is_reported_as_missing():
    fake, c = make()
    vid = c.clone("n", [("a.wav", b"x")]).voice_id
    c.delete_voice(vid)
    assert vid not in fake.voices
    with pytest.raises(RemoteVoiceMissing):
        c.delete_voice(vid)


def test_the_key_goes_only_in_the_header_and_never_in_urls_or_errors():
    fake, c = make()
    vid = c.clone("n", [("a.wav", b"x")]).voice_id
    c.synthesize(vid, "hi", "m", SETTINGS)
    assert all(API_KEY not in path and API_KEY not in str(q) for _, path, q, _ in fake.requests)
    bad = ElevenLabsClient("sk_wrong_key_value", transport=fake.transport)
    with pytest.raises(ElevenLabsError) as e:
        bad.clone("n", [("a.wav", b"x")])
    assert e.value.status == 502 and "sk_wrong_key_value" not in str(e.value) and "API key" in str(e.value)


@pytest.mark.parametrize("upstream,ours", [(401, 502), (403, 502), (500, 502), (503, 502), (429, 429), (422, 400)])
def test_upstream_errors_map_to_our_statuses(upstream, ours):
    fake, c = make()
    vid = c.clone("n", [("a.wav", b"x")]).voice_id
    fake.fail("speak", upstream)
    with pytest.raises(ElevenLabsError) as e:
        c.synthesize(vid, "hi", "m", SETTINGS)
    assert e.value.status == ours


def test_rate_limits_pass_retry_after_through():
    fake, c = make()
    vid = c.clone("n", [("a.wav", b"x")]).voice_id
    fake.fail("speak", 429)
    with pytest.raises(ElevenLabsError) as e:
        c.synthesize(vid, "hi", "m", SETTINGS)
    assert e.value.retry_after == "7"


def test_validation_errors_never_echo_user_input():
    fake, c = make()
    fake.fail("clone", 422)
    with pytest.raises(ElevenLabsError) as e:
        c.clone("n", [("a.wav", b"x")])
    assert e.value.status == 400 and "bad sample" in str(e.value) and "PRIVATE USER TEXT" not in str(e.value)


def test_voice_ids_are_validated_before_they_reach_a_url():
    _, c = make()
    for bad in ("../voices", "a/b", "", "x" * 100, "voice id"):
        with pytest.raises(ElevenLabsError):
            c.delete_voice(bad)
        with pytest.raises(ElevenLabsError):
            c.synthesize(bad, "hi", "m", SETTINGS)


def test_network_failures_become_gateway_errors_without_details():
    import httpx

    def boom(req):
        raise httpx.ConnectError("secret internal host name")

    c = ElevenLabsClient(API_KEY, transport=httpx.MockTransport(boom))
    with pytest.raises(ElevenLabsError) as e:
        c.clone("n", [("a.wav", b"x")])
    assert e.value.status == 502 and "secret internal" not in str(e.value)

    def slow(req):
        raise httpx.ReadTimeout("t")

    c = ElevenLabsClient(API_KEY, transport=httpx.MockTransport(slow))
    with pytest.raises(ElevenLabsError) as e:
        c.synthesize("voice0000000001", "hi", "m", SETTINGS)
    assert e.value.status == 504


def test_an_empty_key_is_refused():
    with pytest.raises(ValueError):
        ElevenLabsClient("")


def _refuse(status, detail):
    import httpx

    c = ElevenLabsClient(API_KEY, transport=httpx.MockTransport(lambda r: httpx.Response(status, json={"detail": detail})))
    with pytest.raises(ElevenLabsError) as e:
        c.synthesize("voice0000000001", "hi", "m", SETTINGS)
    return e.value


@pytest.mark.parametrize("status", [401, 403])
def test_a_refusal_carries_elevenlabs_own_explanation(status):
    e = _refuse(status, {"status": "missing_permissions", "message": "The API key you used is missing the permission text_to_speech to execute this operation."})
    assert e.status == 502
    assert "missing the permission text_to_speech" in str(e) and "Check the API key, its permissions and the plan." in str(e)


def test_a_refusal_with_only_a_status_code_still_says_something_useful():
    assert "(invalid_api_key)" in str(_refuse(401, {"status": "invalid_api_key"}))
    assert "Check the API key" in str(_refuse(401, "plain string detail"))  # no usable detail: the generic hint alone


def test_anything_key_shaped_in_a_refusal_is_removed():
    e = _refuse(401, {"message": "Invalid key sk_live_ABCdef123456 for this account"})
    assert "sk_live_ABCdef123456" not in str(e) and "[removed]" in str(e)


def test_clone_reports_whether_elevenlabs_wants_the_voice_verified():
    fake, c = make()
    assert c.clone("n", [("a.wav", b"x")]).requires_verification is False
    fake.require_verification = True
    r = c.clone("n", [("a.wav", b"x")])
    assert r.requires_verification is True and r.voice_id in fake.voices


@pytest.mark.parametrize("status", [400, 401, 403, 422])
def test_a_refusal_because_of_verification_is_its_own_error_not_a_key_problem(status):
    e = _refuse(status, {"status": "needs_verification", "message": "This voice requires verification. Please verify your voice to continue."})
    assert isinstance(e, VoiceNeedsVerification) and e.status == 409
    assert "verified before it can speak" in str(e) and "API key" not in str(e)


def test_a_normal_refusal_is_still_a_key_problem():
    e = _refuse(403, {"message": "missing the permission text_to_speech"})
    assert not isinstance(e, VoiceNeedsVerification) and e.status == 502 and "Check the API key" in str(e)
