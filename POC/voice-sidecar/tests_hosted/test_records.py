"""The record store contract. The same cases run against the in-memory store and DynamoDB (moto)."""

import itertools

import boto3
import pytest
from moto import mock_aws

from voice_sidecar.records import (
    AlreadyExists,
    DynamoRecordStore,
    MemoryRecordStore,
    RecordNotFound,
    SlotsExhausted,
    WrongState,
    table_definition,
)

CONSENT = {"mode": "self", "acknowledgedAt": "2026-11-07T12:00:00.000+00:00", "consentVersion": "v1", "remoteProcessingAcknowledged": True}
SETTINGS = {"modelId": "eleven_flash_v2_5", "stability": 0.5, "similarityBoost": 0.75, "style": 0.0, "speed": 1.0, "useSpeakerBoost": True}
CLIPS = [{"id": "c1", "seconds": 8.5, "rmsDb": -20.1}]


@pytest.fixture(params=["memory", "dynamodb"])
def store(request):
    ticks = itertools.count()
    clock = lambda: f"2026-11-07T12:{next(ticks) // 60:02d}:{next(ticks) % 60:02d}.000+00:00"  # strictly increasing
    if request.param == "memory":
        yield MemoryRecordStore(now=clock)
        return
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(**table_definition("voices"))
        yield DynamoRecordStore("voices", client=client, now=clock)


def reserve(store, user="u1", limit=10, name="vocaleyes-abc-1"):
    return store.reserve(user, CONSENT, name, SETTINGS, limit)


def test_reserve_creates_a_pending_record_and_takes_a_slot(store):
    r = reserve(store)
    assert (r.status, r.voice_id, r.user_id, r.voice_name) == ("pending", None, "u1", "vocaleyes-abc-1")
    assert store.slots_used() == 1
    got = store.get("u1")
    assert got.settings == SETTINGS and got.consent["mode"] == "self" and got.version == 1
    assert isinstance(got.settings["stability"], float) and got.settings["useSpeakerBoost"] is True  # floats survive DynamoDB's Decimal


def test_one_voice_per_user(store):
    reserve(store)
    with pytest.raises(AlreadyExists):
        reserve(store)
    assert store.slots_used() == 1  # the failed attempt did not take a slot


def test_the_slot_cap_is_enforced_atomically(store):
    reserve(store, "u1", limit=2)
    reserve(store, "u2", limit=2)
    with pytest.raises(SlotsExhausted):
        reserve(store, "u3", limit=2)
    assert store.slots_used() == 2 and store.get("u3") is None  # no half-created record


def test_activate_records_the_voice_id_and_clip_metadata(store):
    reserve(store)
    r = store.activate("u1", "voice123", CLIPS)
    assert (r.status, r.voice_id, r.version) == ("active", "voice123", 2)
    assert store.get("u1").clips == CLIPS
    with pytest.raises(WrongState):
        store.activate("u1", "other", CLIPS)  # only a pending voice can be activated


def test_release_frees_the_slot_of_an_abandoned_reservation(store):
    reserve(store)
    store.release("u1")
    assert store.get("u1") is None and store.slots_used() == 0
    reserve(store)  # and the user can try again
    store.activate("u1", "v", CLIPS)
    with pytest.raises(WrongState):
        store.release("u1")  # an active voice is not released, it is deleted


def test_pause_resume_and_settings(store):
    reserve(store)
    store.activate("u1", "v", CLIPS)
    assert store.update("u1", paused=True).status == "paused"
    new = {**SETTINGS, "stability": 0.8}
    r = store.update("u1", settings=new)
    assert r.status == "paused" and r.settings["stability"] == 0.8  # changing settings does not unpause
    assert store.update("u1", paused=False).status == "active"
    with pytest.raises(RecordNotFound):
        store.update("nobody", paused=True)


def test_a_pending_voice_cannot_be_updated(store):
    reserve(store)
    with pytest.raises(WrongState):
        store.update("u1", paused=True)


def test_delete_is_two_steps_and_frees_the_slot_only_at_the_end(store):
    reserve(store)
    store.activate("u1", "v", CLIPS)
    d = store.begin_delete("u1")
    assert d.status == "deleting" and store.slots_used() == 1  # still held until ElevenLabs confirms
    assert store.begin_delete("u1").status == "deleting"  # idempotent: safe to retry
    with pytest.raises(AlreadyExists):
        reserve(store)  # cannot start a new voice while the old one is being removed
    with pytest.raises(WrongState):
        store.update("u1", paused=False)  # and a deleting voice cannot be changed
    store.finish_delete("u1")
    assert store.get("u1") is None and store.slots_used() == 0
    with pytest.raises(RecordNotFound):
        store.finish_delete("u1")


def test_finish_delete_requires_begin_delete_first(store):
    reserve(store)
    store.activate("u1", "v", CLIPS)
    with pytest.raises(WrongState):
        store.finish_delete("u1")
    assert store.slots_used() == 1


def test_consent_and_deletion_are_audited_without_the_voice_id(store):
    reserve(store)
    store.activate("u1", "secret-voice-id", CLIPS)
    store.begin_delete("u1")
    store.finish_delete("u1")
    audit = store.audit("u1")
    assert [a["action"] for a in sorted(audit, key=lambda a: a["at"])] == ["granted", "deleted"]
    assert all(a["ttl"] > 0 and a["consent"]["mode"] == "self" for a in audit)
    assert "secret-voice-id" not in str(audit)


def test_the_reconciler_can_find_stale_records_by_status_and_age(store):
    reserve(store, "old")
    reserve(store, "new")
    store.activate("new", "v", CLIPS)
    store.begin_delete("new")
    pend = store.list_by_status("pending")
    assert [r.user_id for r in pend] == ["old"]
    assert store.list_by_status("pending", older_than="2026-11-07T00:00:00.000+00:00") == []  # nothing is that old
    assert [r.user_id for r in store.list_by_status("pending", older_than="2999-01-01T00:00:00.000+00:00")] == ["old"]
    assert [r.user_id for r in store.list_by_status("deleting")] == ["new"]
    assert store.list_by_status("active") == []


def test_users_are_isolated(store):
    reserve(store, "alice")
    reserve(store, "bob", name="vocaleyes-bob-1")
    store.activate("alice", "alice-voice", CLIPS)
    assert store.get("bob").voice_id is None
    store.begin_delete("alice")
    assert store.get("bob").status == "pending"


def test_the_public_view_never_includes_the_voice_id_or_user_id(store):
    reserve(store)
    r = store.activate("u1", "secret-voice-id", CLIPS)
    pub = r.public()
    assert "secret-voice-id" not in str(pub) and "u1" not in str(pub)
    assert set(pub) == {"status", "settings", "consent", "clips", "createdAt", "updatedAt"}
    assert "remoteProcessingAcknowledged" not in pub["consent"]


def test_the_post_deployment_check_passes_on_both_stores(store):
    from voice_sidecar.records_check import check_store

    steps = check_store(store)
    assert len(steps) >= 12 and store.slots_used() == 0  # it leaves the store as it found it


def test_the_post_deployment_check_notices_a_broken_slot_cap(store, monkeypatch):
    from voice_sidecar.records_check import check_store

    real = store.reserve
    monkeypatch.setattr(store, "reserve", lambda u, c, n, s, limit: real(u, c, n, s, 10**6))  # a store that ignores the cap
    with pytest.raises(AssertionError, match="slot cap"):
        check_store(store)
