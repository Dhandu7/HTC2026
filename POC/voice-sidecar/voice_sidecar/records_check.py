"""End-to-end check of a record store, for use against the REAL DynamoDB table after deployment:

  VOICE_TABLE_NAME=vocaleyes-voices AWS_REGION=us-east-1 ./hosted.sh check-table

It uses a throwaway user id, exercises every operation the service uses (including the slot-cap transaction), and
leaves the table as it found it. It never calls ElevenLabs. It needs AWS credentials with the policy in
infra/iam-policy.example.json (or broader).
"""

from __future__ import annotations

import secrets

from .records import AlreadyExists, RecordNotFound, SlotsExhausted, VoiceRecordStore, WrongState

CONSENT = {"mode": "self", "acknowledgedAt": "2026-01-01T00:00:00.000+00:00", "consentVersion": "check", "remoteProcessingAcknowledged": True}
SETTINGS = {"modelId": "eleven_flash_v2_5", "stability": 0.5, "similarityBoost": 0.75, "style": 0.0, "speed": 1.0, "useSpeakerBoost": True}


def check_store(store: VoiceRecordStore) -> "list[str]":
    """Raises AssertionError with the failing step. Returns a list of the steps that passed."""
    steps = []
    uid = f"integration-check-{secrets.token_hex(4)}"
    before = store.slots_used()

    def ok(s):
        steps.append(s)

    assert store.get(uid) is None
    ok("no record for a new user")
    r = store.reserve(uid, CONSENT, "vocaleyes-check", SETTINGS, before + 1)
    assert r.status == "pending" and store.slots_used() == before + 1
    ok("reserve takes a slot")
    try:
        store.reserve(uid, CONSENT, "vocaleyes-check", SETTINGS, before + 5)
        raise AssertionError("a second voice for the same user was allowed")
    except AlreadyExists:
        ok("a second voice for the same user is refused")
    try:
        store.reserve(uid + "-other", CONSENT, "vocaleyes-check2", SETTINGS, before + 1)
        raise AssertionError("the slot cap was not enforced")
    except SlotsExhausted:
        ok("the slot cap is enforced atomically")
    assert store.get(uid + "-other") is None
    a = store.activate(uid, "check0000000001", [{"id": "clip-01", "seconds": 12.0}])
    assert a.status == "active" and a.settings["stability"] == 0.5 and isinstance(a.settings["stability"], float)
    ok("activate records the voice id; floats round-trip")
    assert store.update(uid, paused=True).status == "paused" and store.update(uid, paused=False).status == "active"
    ok("pause and resume")
    assert store.begin_delete(uid).status == "deleting" and store.slots_used() == before + 1
    ok("begin_delete keeps the slot until the end")
    try:
        store.update(uid, paused=False)
        raise AssertionError("a deleting voice could be changed")
    except WrongState:
        ok("a deleting voice cannot be changed")
    assert uid in [x.user_id for x in store.list_by_status("deleting")]
    ok("the reconciler's query finds it (GSI)")
    store.finish_delete(uid)
    assert store.get(uid) is None and store.slots_used() == before
    ok("finish_delete frees the slot and removes the record")
    assert [x["action"] for x in sorted(store.audit(uid), key=lambda x: x["at"])] == ["granted", "deleted"]
    ok("consent and deletion were audited")
    try:
        store.finish_delete(uid)
        raise AssertionError("deleting twice succeeded")
    except RecordNotFound:
        ok("deleting twice is a clean error")
    return steps
