import io
import logging

import numpy as np
import pytest
import soundfile as sf

from fake_elevenlabs import FakeElevenLabs
from voice_sidecar import hosted
from voice_sidecar.elevenlabs import ElevenLabsClient
from voice_sidecar.hosted import (
    CONSENT_VERSION,
    ClipsRejected,
    ConsentRequired,
    DeleteIncomplete,
    HostedConfig,
    HostedError,
    HostedVoiceService,
    NeedsVerification,
    VoiceNotFound,
    VoiceNotReady,
    VoicePaused,
    normalize_settings,
)
from voice_sidecar.records import AlreadyExists, MemoryRecordStore, SlotsExhausted


def speech(seconds=12.0, sr=24000, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    y = (0.3 * (0.55 + 0.45 * np.sin(2 * np.pi * 4 * t)) * rng.standard_normal(len(t)) * 0.5).clip(-0.95, 0.95).astype(np.float32)
    b = io.BytesIO()
    sf.write(b, y, sr, format="WAV", subtype="PCM_16")
    return b.getvalue()


CONSENT = {"mode": "self", "acknowledged": True, "remoteProcessingAcknowledged": True, "consentVersion": CONSENT_VERSION}
UPLOADS = lambda: [("hello", speech(12.0, seed=1))]


@pytest.fixture
def env():
    fake = FakeElevenLabs()
    from fake_elevenlabs import API_KEY

    store = MemoryRecordStore()
    svc = HostedVoiceService(store, ElevenLabsClient(API_KEY, transport=fake.transport), HostedConfig(slot_limit=2))
    return svc, store, fake


# ---------------- consent ----------------


@pytest.mark.parametrize(
    "patch",
    [
        {"acknowledged": False},
        {"acknowledged": "yes"},
        {"remoteProcessingAcknowledged": False},
        {"remoteProcessingAcknowledged": None},
        {"mode": "someone-else"},
        {"consentVersion": "old"},
        {"mode": "authorized"},
        {"mode": "authorized", "authorizedBy": "  "},
    ],
)
def test_no_voice_without_complete_consent(env, patch):
    svc, store, fake = env
    with pytest.raises(ConsentRequired):
        svc.create("u1", {**CONSENT, **patch}, UPLOADS())
    assert store.get("u1") is None and store.slots_used() == 0 and fake.voices == {} and fake.requests == []  # nothing reserved, nothing uploaded


def test_missing_consent_entirely_is_refused(env):
    svc, store, fake = env
    for bad in (None, {}, "yes", []):
        with pytest.raises(ConsentRequired):
            svc.create("u1", bad, UPLOADS())
    assert fake.requests == []


def test_authorized_consent_records_who_gave_permission_and_the_text_version(env):
    svc, store, _ = env
    r, _ = svc.create("u1", {**CONSENT, "mode": "authorized", "authorizedBy": " Sam Rivera "}, UPLOADS())
    c = r.consent
    assert (c["mode"], c["authorizedBy"], c["consentVersion"], c["remoteProcessingAcknowledged"]) == ("authorized", "Sam Rivera", CONSENT_VERSION, True)
    assert c["acknowledgedAt"]


# ---------------- create ----------------


def test_create_clones_at_elevenlabs_and_stores_only_metadata(env):
    svc, store, fake = env
    r, skipped = svc.create("u1", CONSENT, UPLOADS())
    assert r.status == "active" and r.voice_id in fake.voices and skipped == []
    assert r.voice_name.startswith("vocaleyes-") and "u1" not in r.voice_name  # the user id is hashed, never sent as a name
    assert r.clips[0]["seconds"] == pytest.approx(12.0, abs=0.1) and set(r.clips[0]) == {"id", "seconds", "rmsDb", "warnings"}
    assert r.settings["modelId"] == "eleven_flash_v2_5"


def test_too_little_speech_is_rejected_before_anything_is_reserved(env):
    svc, store, fake = env
    with pytest.raises(ClipsRejected) as e:
        svc.create("u1", CONSENT, [("short", speech(3.0))])
    assert "at least 10" in str(e.value)
    assert store.slots_used() == 0 and fake.requests == []


def test_bad_clips_are_skipped_and_reported_good_ones_still_used(env):
    svc, store, fake = env
    silent = io.BytesIO()
    sf.write(silent, np.zeros(24000 * 5, np.float32), 24000, format="WAV")
    r, skipped = svc.create("u1", CONSENT, [("good", speech(12.0)), ("silent", silent.getvalue()), ("junk", b"not audio")])
    assert r.status == "active" and len(r.clips) == 1
    assert {s["label"] for s in skipped} == {"silent", "junk"}


def test_a_long_recording_is_split_before_upload(env):
    svc, _, fake = env
    sr = 24000
    long = np.concatenate(sum([[np.frombuffer(speech(12.0, seed=i), dtype=np.int16)[22:].astype(np.float32) / 32768, np.zeros(int(0.6 * sr), np.float32)] for i in range(8)], []))
    b = io.BytesIO()
    sf.write(b, long, sr, format="WAV")
    r, _ = svc.create("u1", CONSENT, [("podcast", b.getvalue())])
    assert len(r.clips) >= 4 and len(fake.voices[r.voice_id]["files"]) == len(r.clips)


def test_a_failed_clone_frees_the_slot_and_leaves_no_record(env):
    svc, store, fake = env
    fake.fail("clone", 500)
    with pytest.raises(Exception):
        svc.create("u1", CONSENT, UPLOADS())
    assert store.get("u1") is None and store.slots_used() == 0
    r, _ = svc.create("u1", CONSENT, UPLOADS())  # and the user can simply try again
    assert r.status == "active"


def test_if_activation_fails_the_remote_voice_is_deleted_again(env, monkeypatch):
    svc, store, fake = env
    monkeypatch.setattr(store, "activate", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db down")))
    with pytest.raises(RuntimeError):
        svc.create("u1", CONSENT, UPLOADS())
    assert fake.voices == {} and store.slots_used() == 0  # no orphan voice, no leaked slot


def test_if_activation_and_cleanup_both_fail_the_reservation_is_kept_for_a_human(env, monkeypatch, caplog):
    svc, store, fake = env
    monkeypatch.setattr(store, "activate", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db down")))
    fake.fail("delete", 500)
    with caplog.at_level(logging.ERROR, logger="voice.hosted"):
        with pytest.raises(RuntimeError):
            svc.create("u1", CONSENT, UPLOADS())
    assert len(fake.voices) == 1 and store.slots_used() == 1 and store.get("u1").status == "pending"
    assert "orphaned ElevenLabs voice" in caplog.text and store.get("u1").voice_name in caplog.text


def test_one_voice_per_user_and_the_account_slot_cap(env):
    svc, store, fake = env  # slot_limit is 2
    svc.create("a", CONSENT, UPLOADS())
    with pytest.raises(AlreadyExists):
        svc.create("a", CONSENT, UPLOADS())
    svc.create("b", CONSENT, UPLOADS())
    with pytest.raises(SlotsExhausted):
        svc.create("c", CONSENT, UPLOADS())
    assert len(fake.voices) == 2  # the refused attempts never reached ElevenLabs


# ---------------- speak ----------------


def test_speak_uses_the_users_own_voice_and_labels_nothing_else(env):
    svc, store, fake = env
    ra, _ = svc.create("alice", CONSENT, UPLOADS())
    rb, _ = svc.create("bob", CONSENT, UPLOADS())
    svc.speak("alice", "Hello.")
    svc.speak("bob", "Hi.")
    assert [c["voice_id"] for c in fake.speak_calls] == [ra.voice_id, rb.voice_id]


def test_speak_applies_stored_settings_with_per_call_overrides(env):
    svc, _, fake = env
    svc.create("u1", CONSENT, UPLOADS())
    svc.update_settings("u1", {"stability": 0.9, "speed": 1.1})
    svc.speak("u1", "Hello.")
    vs = fake.speak_calls[-1]["body"]["voice_settings"]
    assert (vs["stability"], vs["speed"], vs["similarity_boost"]) == (0.9, 1.1, 0.75)
    svc.speak("u1", "Hello.", {"stability": 0.1})
    assert fake.speak_calls[-1]["body"]["voice_settings"]["stability"] == 0.1
    svc.speak("u1", "Hello.")  # the override was for one call only
    assert fake.speak_calls[-1]["body"]["voice_settings"]["stability"] == 0.9


def test_speak_requires_an_active_voice(env):
    svc, store, _ = env
    with pytest.raises(VoiceNotFound):
        svc.speak("nobody", "hi")
    store.reserve("u1", {"mode": "self"}, "n", {}, 5)
    with pytest.raises(VoiceNotReady):
        svc.speak("u1", "hi")  # still pending


def test_a_paused_voice_cannot_speak_until_resumed(env):
    svc, _, fake = env
    svc.create("u1", CONSENT, UPLOADS())
    svc.set_paused("u1", True)
    with pytest.raises(VoicePaused):
        svc.speak("u1", "hi")
    assert fake.speak_calls == []  # nothing was sent to ElevenLabs
    svc.set_paused("u1", False)
    svc.speak("u1", "hi")
    assert len(fake.speak_calls) == 1


@pytest.mark.parametrize("text", ["", "   ", "x" * 1001])
def test_bad_text_is_rejected_before_calling_elevenlabs(env, text):
    svc, _, fake = env
    svc.create("u1", CONSENT, UPLOADS())
    with pytest.raises(HostedError):
        svc.speak("u1", text)
    assert fake.speak_calls == []


def test_request_text_is_never_logged(env, caplog):
    svc, _, fake = env
    svc.create("u1", CONSENT, UPLOADS())
    fake.fail("speak", 500)
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(Exception):
            svc.speak("u1", "my private sentence about my health")
        svc.speak("u1", "another private sentence")
    assert "private sentence" not in caplog.text


# ---------------- settings ----------------


def test_settings_are_clamped_and_unknown_things_rejected():
    s = normalize_settings({"stability": 5, "similarityBoost": -1, "speed": 3.0, "style": 0.3})
    assert (s["stability"], s["similarityBoost"], s["speed"], s["style"]) == (1.0, 0.0, 1.2, 0.3)
    assert normalize_settings({"speed": 0.1})["speed"] == 0.7
    for bad in ({"modelId": "gpt-4"}, {"voiceId": "x"}, {"stability": "high"}, {"stability": True}, {"useSpeakerBoost": "yes"}):
        with pytest.raises(HostedError):
            normalize_settings(bad)


# ---------------- delete ----------------


def test_delete_removes_the_voice_at_elevenlabs_then_the_record_and_frees_the_slot(env):
    svc, store, fake = env
    r, _ = svc.create("u1", CONSENT, UPLOADS())
    svc.delete("u1")
    assert fake.voices == {} and store.get("u1") is None and store.slots_used() == 0
    assert [a["action"] for a in store.audit("u1")] == ["granted", "deleted"]


def test_if_elevenlabs_cannot_delete_the_voice_the_record_is_kept_and_cannot_speak(env):
    svc, store, fake = env
    r, _ = svc.create("u1", CONSENT, UPLOADS())
    fake.fail("delete", 500)
    with pytest.raises(DeleteIncomplete):
        svc.delete("u1")
    assert store.get("u1").status == "deleting" and r.voice_id in fake.voices and store.slots_used() == 1
    with pytest.raises(VoiceNotReady):
        svc.speak("u1", "hi")  # a voice being deleted is silenced immediately
    with pytest.raises(AlreadyExists):
        svc.create("u1", CONSENT, UPLOADS())


def test_a_voice_already_gone_at_elevenlabs_still_completes_the_delete(env):
    svc, store, fake = env
    r, _ = svc.create("u1", CONSENT, UPLOADS())
    del fake.voices[r.voice_id]  # removed by hand in the ElevenLabs dashboard
    svc.delete("u1")
    assert store.get("u1") is None and store.slots_used() == 0


def test_the_reconciler_retries_stuck_deletes_and_releases_stale_reservations(env):
    svc, store, fake = env
    r, _ = svc.create("u1", CONSENT, UPLOADS())
    fake.fail("delete", 500)
    with pytest.raises(DeleteIncomplete):
        svc.delete("u1")
    store.reserve("u2", {"mode": "self"}, "vocaleyes-stale", {}, 5)  # a create that crashed after reserving
    svc._now = lambda: "2999-01-01T00:00:00.000+00:00"  # far in the future: everything is overdue
    out = svc.reconcile()
    assert out == {"deleted": 1, "deleteFailed": 0, "releasedPending": 1}
    assert fake.voices == {} and store.get("u1") is None and store.get("u2") is None and store.slots_used() == 0
    assert svc.reconcile() == {"deleted": 0, "deleteFailed": 0, "releasedPending": 0}  # idempotent


def test_the_reconciler_leaves_fresh_records_alone(env):
    svc, store, fake = env
    svc.create("u1", CONSENT, UPLOADS())
    store.reserve("u2", {"mode": "self"}, "n", {}, 5)
    assert svc.reconcile() == {"deleted": 0, "deleteFailed": 0, "releasedPending": 0}
    assert store.get("u2").status == "pending"


# ---------------- ElevenLabs wants the voice verified ----------------


def test_a_voice_that_needs_verifying_is_created_and_flagged(env):
    svc, store, fake = env
    fake.require_verification = True
    r, _ = svc.create("u1", CONSENT, UPLOADS())
    assert r.status == "active" and r.needs_verification is True and r.public()["needsVerification"] is True


def test_speaking_before_verification_explains_what_to_do_and_names_the_voice(env):
    svc, store, fake = env
    fake.require_verification = True
    r, _ = svc.create("u1", CONSENT, UPLOADS())
    with pytest.raises(NeedsVerification) as e:
        svc.speak("u1", "Hello.")
    msg = str(e.value)
    assert e.value.status == 409 and r.voice_name in msg and "elevenlabs.io" in msg and "read a short phrase aloud" in msg
    assert "API key" not in msg  # not a key problem


def test_after_the_owner_verifies_at_elevenlabs_the_next_speak_works_and_clears_the_flag(env):
    svc, store, fake = env
    fake.require_verification = True
    r, _ = svc.create("u1", CONSENT, UPLOADS())
    with pytest.raises(NeedsVerification):
        svc.speak("u1", "Hello.")
    assert store.get("u1").needs_verification is True
    fake.verify(r.voice_id)
    audio, ctype, _ = svc.speak("u1", "Hello.")
    assert audio and store.get("u1").needs_verification is False


def test_a_refusal_with_no_flag_yet_sets_it(env):
    svc, store, fake = env
    r, _ = svc.create("u1", CONSENT, UPLOADS())  # ElevenLabs did not flag it at creation...
    assert r.needs_verification is False
    fake.unverified.add(r.voice_id)  # ...but asks for verification later
    with pytest.raises(NeedsVerification):
        svc.speak("u1", "Hello.")
    assert store.get("u1").needs_verification is True
