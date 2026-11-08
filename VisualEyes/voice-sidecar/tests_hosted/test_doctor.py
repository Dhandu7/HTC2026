import logging

import pytest

from fake_elevenlabs import API_KEY, FakeElevenLabs
from test_hosted_service import CONSENT, UPLOADS
from voice_sidecar.doctor import diagnose
from voice_sidecar.elevenlabs import ElevenLabsClient
from voice_sidecar.hosted import HostedConfig, HostedVoiceService
from voice_sidecar.records import MemoryRecordStore


def run(fake=None, key=API_KEY):
    fake = fake or FakeElevenLabs()
    return diagnose(ElevenLabsClient(key, transport=fake.transport)), fake


def text(lines):
    return "\n".join(lines)


def test_a_healthy_account_is_reported_as_fine_and_the_key_is_never_printed():
    (lines, ok), _ = run()
    assert ok and "Plan: starter" in text(lines) and "Instant voice cloning: allowed" in text(lines)
    assert "Voice slots: 2 of 10 used, 8 free" in text(lines) and "VOICE_SLOT_LIMIT" in text(lines)
    assert API_KEY not in text(lines)


def test_a_plan_without_cloning_says_what_to_do():
    f = FakeElevenLabs()
    f.subscription.update(tier="free", can_use_instant_voice_cloning=False)
    (lines, ok), _ = run(f)
    assert not ok and "NOT allowed" in text(lines) and "Starter" in text(lines)


def test_no_free_slot_and_no_characters_are_both_flagged():
    f = FakeElevenLabs()
    f.subscription.update(voice_slots_used=10, voice_limit=10, character_count=75000, character_limit=75000)
    (lines, ok), _ = run(f)
    assert not ok and "No free slot" in text(lines) and "Out of characters" in text(lines)


def test_a_billing_problem_is_flagged():
    f = FakeElevenLabs()
    f.subscription["status"] = "past_due"
    (lines, ok), _ = run(f)
    assert not ok and "past_due" in text(lines)


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_key_explains_both_causes_including_a_restricted_key(status):
    f = FakeElevenLabs()
    f.subscription_status = status
    (lines, ok), _ = run(f)
    assert not ok and "REFUSED" in text(lines) and "restricted key" in text(lines)


def test_a_wrong_key_is_reported_without_echoing_it():
    (lines, ok), _ = run(key="sk_wrong_key_value")
    assert not ok and "REFUSED" in text(lines) and "sk_wrong_key_value" not in text(lines)


def test_unknown_fields_are_not_passed_through():
    f = FakeElevenLabs()
    client = ElevenLabsClient(API_KEY, transport=f.transport)
    assert "current_overage" not in client.subscription()


# ---- a failed create now says why (safe text only) ----


def service():
    fake = FakeElevenLabs()
    return HostedVoiceService(MemoryRecordStore(), ElevenLabsClient(API_KEY, transport=fake.transport), HostedConfig(slot_limit=2)), fake


def test_a_refused_create_logs_the_reason_and_the_voice_name(caplog):
    svc, fake = service()
    fake.fail("clone", 403)
    with caplog.at_level(logging.WARNING, logger="voice.hosted"):
        with pytest.raises(Exception):
            svc.create("u1", CONSENT, UPLOADS())
    assert "create failed: ElevenLabsError (HTTP 502)" in caplog.text and "refused the request" in caplog.text
    assert "vocaleyes-" in caplog.text  # the voice name, so an orphan can be found


def test_the_log_never_contains_user_text_or_the_key(caplog):
    svc, fake = service()
    fake.fail("clone", 422)  # the fake echoes "PRIVATE USER TEXT" in the validation input
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(Exception):
            svc.create("u1", CONSENT, UPLOADS())
    assert "PRIVATE USER TEXT" not in caplog.text and API_KEY not in caplog.text and "u1" not in caplog.text.replace("vocaleyes", "")


def test_an_unexpected_error_logs_only_its_type(caplog, monkeypatch):
    svc, _ = service()
    monkeypatch.setattr(svc.store, "activate", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("secret detail: sk_live_123")))
    with caplog.at_level(logging.WARNING, logger="voice.hosted"):
        with pytest.raises(RuntimeError):
            svc.create("u1", CONSENT, UPLOADS())
    assert "create failed: RuntimeError" in caplog.text and "sk_live_123" not in caplog.text


# ---- a key ID pasted instead of the key ----


def test_the_key_shape_check_catches_an_id_and_never_includes_the_value():
    from voice_sidecar.elevenlabs import key_shape_warning

    assert key_shape_warning("sk_abc123") is None and key_shape_warning("  sk_abc123\n") is None
    for bad in ("abc123keyid", "", "Bearer sk_x", "ELEVENLABS_API_KEY=sk_x"):
        w = key_shape_warning(bad)
        assert w and "sk_" in w and "ID" in w
        assert bad.strip() == "" or bad not in w
