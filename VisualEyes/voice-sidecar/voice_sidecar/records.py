"""Per-user voice records for the hosted (ElevenLabs) service.

ElevenLabs keeps the cloned voice. These records keep what ElevenLabs does not know: which of OUR users
owns which voice_id, the consent they gave, their settings, and where a voice is in its lifecycle
(pending -> active <-> paused -> deleting -> gone). They also enforce the account's voice-slot cap.

Two implementations with one behaviour, tested against the same cases:
  MemoryRecordStore   dev and tests
  DynamoRecordStore   production (table definition: TABLE_DEFINITION, mirrored in infra/voices-table.cfn.json)

DynamoDB layout (single table, on-demand):
  pk                 sk                          what
  USER#<userId>      VOICE#elevenlabs            the user's current voice (one per user per provider)
  USER#<userId>      CONSENT#<ts>#<action>       append-only audit of consent given / voice deleted (TTL)
  META#elevenlabs    SLOTS                       {used}: voices in use, bumped in the same transaction as the voice
  GSI1: gsi1pk = STATUS#elevenlabs#<status>, gsi1sk = updatedAt   (find stale pending / deleting for the reconciler)
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Callable, Optional, Protocol

PROVIDER = "elevenlabs"
STATUSES = ("pending", "active", "paused", "deleting")
AUDIT_TTL_DAYS = 400  # how long consent/deletion audit items live; a policy decision, see docs/AWS_VOICE_HANDOFF.md


class RecordError(Exception):
    """Base class. `status` is the HTTP status the API answers with."""

    status = 400


class RecordNotFound(RecordError):
    status = 404


class AlreadyExists(RecordError):
    status = 409


class SlotsExhausted(RecordError):
    status = 409


class WrongState(RecordError):
    status = 409


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass
class VoiceRecord:
    user_id: str
    status: str
    voice_name: str
    voice_id: Optional[str]
    settings: dict
    consent: dict
    clips: list
    created_at: str
    updated_at: str
    version: int = 1
    provider: str = PROVIDER
    #: ElevenLabs will not let the voice speak until its owner verifies it there. Set from the create response or
    #: from a refusal, and cleared by the first successful speak after verification.
    needs_verification: bool = False

    def public(self) -> dict:
        """What the signed-in user may see. The ElevenLabs voice_id is internal and never leaves the server."""
        c = self.consent
        view = {
            "status": self.status,
            "settings": self.settings,
            "consent": {k: c.get(k) for k in ("mode", "authorizedBy", "acknowledgedAt", "consentVersion") if c.get(k) is not None},
            "clips": self.clips,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
        if self.needs_verification:
            view["needsVerification"] = True
            view["voiceName"] = self.voice_name  # so the owner can find this voice in the ElevenLabs dashboard
        return view


class VoiceRecordStore(Protocol):
    def get(self, user_id: str) -> Optional[VoiceRecord]: ...

    def reserve(self, user_id: str, consent: dict, voice_name: str, settings: dict, slot_limit: int) -> VoiceRecord:
        """Atomically take a voice slot and create the user's record in `pending`.
        AlreadyExists if the user already has a voice; SlotsExhausted if the account is at its cap."""

    def activate(self, user_id: str, voice_id: str, clips: list, needs_verification: bool = False) -> VoiceRecord:
        """pending -> active, recording the ElevenLabs voice_id."""

    def release(self, user_id: str) -> None:
        """Abandon a pending reservation and free its slot."""

    def update(self, user_id: str, settings: Optional[dict] = None, paused: Optional[bool] = None, needs_verification: Optional[bool] = None) -> VoiceRecord:
        """Change settings, pause or resume, and/or set the needs-verification flag of an active or paused voice."""

    def begin_delete(self, user_id: str) -> VoiceRecord:
        """Mark the voice `deleting` (idempotent). From here the voice can no longer speak."""

    def finish_delete(self, user_id: str) -> None:
        """After ElevenLabs confirmed the delete: remove the record, free the slot, write an audit entry."""

    def list_by_status(self, status: str, older_than: Optional[str] = None, limit: int = 100) -> "list[VoiceRecord]": ...

    def slots_used(self) -> int: ...

    def audit(self, user_id: str) -> "list[dict]": ...


def _audit_item(user_id: str, action: str, consent: dict, now: str) -> dict:
    ttl = int((datetime.fromisoformat(now) + timedelta(days=AUDIT_TTL_DAYS)).timestamp())
    keep = {k: consent[k] for k in ("mode", "authorizedBy", "acknowledgedAt", "consentVersion") if k in consent}
    return {"userId": user_id, "action": action, "at": now, "consent": keep, "ttl": ttl}


# --------------------------------------------------------------------------------------------------
# Memory
# --------------------------------------------------------------------------------------------------


class MemoryRecordStore:
    def __init__(self, now: Callable[[], str] = utc_now):
        self._now = now
        self._lock = threading.Lock()
        self._voices: "dict[str, VoiceRecord]" = {}
        self._used = 0
        self._audit: "dict[str, list[dict]]" = {}

    def get(self, user_id):
        with self._lock:
            r = self._voices.get(user_id)
            return _copy(r) if r else None

    def reserve(self, user_id, consent, voice_name, settings, slot_limit):
        with self._lock:
            if user_id in self._voices:
                raise AlreadyExists("this user already has a voice; delete it first" if self._voices[user_id].status != "deleting" else "the previous voice is still being deleted")
            if self._used >= slot_limit:
                raise SlotsExhausted("no free voice slots on the ElevenLabs account")
            now = self._now()
            r = VoiceRecord(user_id, "pending", voice_name, None, dict(settings), dict(consent), [], now, now)
            self._voices[user_id] = r
            self._used += 1
            self._audit.setdefault(user_id, []).append(_audit_item(user_id, "granted", consent, now))
            return _copy(r)

    def _need(self, user_id, *states):
        r = self._voices.get(user_id)
        if r is None:
            raise RecordNotFound("no voice for this user")
        if states and r.status not in states:
            raise WrongState(f"voice is {r.status}, expected {' or '.join(states)}")
        return r

    def activate(self, user_id, voice_id, clips, needs_verification=False):
        with self._lock:
            r = self._need(user_id, "pending")
            r.status, r.voice_id, r.clips, r.needs_verification = "active", voice_id, list(clips), bool(needs_verification)
            r.updated_at, r.version = self._now(), r.version + 1
            return _copy(r)

    def release(self, user_id):
        with self._lock:
            self._need(user_id, "pending")
            del self._voices[user_id]
            self._used -= 1

    def update(self, user_id, settings=None, paused=None, needs_verification=None):
        with self._lock:
            r = self._need(user_id, "active", "paused")
            if settings is not None:
                r.settings = dict(settings)
            if needs_verification is not None:
                r.needs_verification = bool(needs_verification)
            if paused is not None:
                r.status = "paused" if paused else "active"
            r.updated_at, r.version = self._now(), r.version + 1
            return _copy(r)

    def begin_delete(self, user_id):
        with self._lock:
            r = self._need(user_id)
            if r.status != "deleting":
                r.status, r.updated_at, r.version = "deleting", self._now(), r.version + 1
            return _copy(r)

    def finish_delete(self, user_id):
        with self._lock:
            r = self._need(user_id, "deleting")
            now = self._now()
            self._audit.setdefault(user_id, []).append(_audit_item(user_id, "deleted", r.consent, now))
            del self._voices[user_id]
            self._used -= 1

    def list_by_status(self, status, older_than=None, limit=100):
        with self._lock:
            out = [r for r in self._voices.values() if r.status == status and (older_than is None or r.updated_at < older_than)]
            return [_copy(r) for r in sorted(out, key=lambda r: r.updated_at)[:limit]]

    def slots_used(self):
        with self._lock:
            return self._used

    def audit(self, user_id):
        with self._lock:
            return list(self._audit.get(user_id, []))


def _copy(r: VoiceRecord) -> VoiceRecord:
    return VoiceRecord(r.user_id, r.status, r.voice_name, r.voice_id, dict(r.settings), dict(r.consent), [dict(c) for c in r.clips], r.created_at, r.updated_at, r.version, r.provider, r.needs_verification)


# --------------------------------------------------------------------------------------------------
# DynamoDB
# --------------------------------------------------------------------------------------------------


def table_definition(table_name: str) -> dict:
    """create_table() arguments. infra/voices-table.cfn.json must describe the same keys and index
    (tests/test_infra_definition.py checks it), so what the code expects is what gets deployed."""
    return {
        "TableName": table_name,
        "BillingMode": "PAY_PER_REQUEST",
        "AttributeDefinitions": [{"AttributeName": n, "AttributeType": "S"} for n in ("pk", "sk", "gsi1pk", "gsi1sk")],
        "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "gsi1",
                "KeySchema": [{"AttributeName": "gsi1pk", "KeyType": "HASH"}, {"AttributeName": "gsi1sk", "KeyType": "RANGE"}],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
    }


def _to_ddb(v):
    """DynamoDB wants Decimal, not float."""
    if isinstance(v, float):
        return Decimal(str(v))
    if isinstance(v, dict):
        return {k: _to_ddb(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_to_ddb(x) for x in v]
    return v


def _from_ddb(v):
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() and "." not in str(v) else float(v)
    if isinstance(v, dict):
        return {k: _from_ddb(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_from_ddb(x) for x in v]
    return v


class DynamoRecordStore:
    def __init__(self, table_name: str, client=None, region: Optional[str] = None, now: Callable[[], str] = utc_now):
        import boto3

        self.table = table_name
        self.client = client or boto3.client("dynamodb", region_name=region)
        self._now = now
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

        self._ser, self._de = TypeSerializer(), TypeDeserializer()

    # ---- helpers ----

    @staticmethod
    def _key(user_id: str) -> dict:
        return {"pk": f"USER#{user_id}", "sk": f"VOICE#{PROVIDER}"}

    _META = {"pk": f"META#{PROVIDER}", "sk": "SLOTS"}

    def _s(self, d: dict) -> dict:
        return {k: self._ser.serialize(_to_ddb(v)) for k, v in d.items()}

    def _d(self, item: dict) -> dict:
        return {k: _from_ddb(self._de.deserialize(v)) for k, v in item.items()}

    @staticmethod
    def _gsi(status: str, now: str) -> dict:
        return {"gsi1pk": f"STATUS#{PROVIDER}#{status}", "gsi1sk": now}

    def _record(self, item: dict) -> VoiceRecord:
        d = self._d(item)
        return VoiceRecord(d["userId"], d["status"], d["voiceName"], d.get("voiceId"), d["settings"], d["consent"], d.get("clips", []), d["createdAt"], d["updatedAt"], d.get("version", 1), d.get("provider", PROVIDER), bool(d.get("needsVerification", False)))

    def _reasons(self, err) -> "list[str]":
        return [r.get("Code", "") for r in err.response.get("CancellationReasons", [])]

    def _cancelled(self, e) -> bool:
        return e.response.get("Error", {}).get("Code") == "TransactionCanceledException"

    def _cond_failed(self, e) -> bool:
        return e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"

    # ---- API ----

    def get(self, user_id):
        r = self.client.get_item(TableName=self.table, Key=self._s(self._key(user_id)), ConsistentRead=True)
        return self._record(r["Item"]) if "Item" in r else None

    def reserve(self, user_id, consent, voice_name, settings, slot_limit):
        from botocore.exceptions import ClientError

        now = self._now()
        item = {
            **self._key(user_id),
            **self._gsi("pending", now),
            "userId": user_id,
            "provider": PROVIDER,
            "status": "pending",
            "voiceName": voice_name,
            "settings": settings,
            "consent": consent,
            "clips": [],
            "needsVerification": False,
            "createdAt": now,
            "updatedAt": now,
            "version": 1,
        }
        audit = _audit_item(user_id, "granted", consent, now)
        audit_item = {"pk": f"USER#{user_id}", "sk": f"CONSENT#{now}#granted", **audit}
        try:
            self.client.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self.table,
                            "Key": self._s(self._META),
                            "UpdateExpression": "ADD #u :one",
                            "ConditionExpression": "attribute_not_exists(#u) OR #u < :limit",
                            "ExpressionAttributeNames": {"#u": "used"},
                            "ExpressionAttributeValues": self._s({":one": 1, ":limit": int(slot_limit)}),
                        }
                    },
                    {"Put": {"TableName": self.table, "Item": self._s(item), "ConditionExpression": "attribute_not_exists(pk)"}},
                    {"Put": {"TableName": self.table, "Item": self._s(audit_item)}},
                ]
            )
        except ClientError as e:
            if self._cancelled(e):
                reasons = self._reasons(e)
                if len(reasons) > 0 and reasons[0] == "ConditionalCheckFailed":
                    raise SlotsExhausted("no free voice slots on the ElevenLabs account")
                if len(reasons) > 1 and reasons[1] == "ConditionalCheckFailed":
                    cur = self.get(user_id)
                    raise AlreadyExists("the previous voice is still being deleted" if cur and cur.status == "deleting" else "this user already has a voice; delete it first")
            raise
        return self._record(self._s(item))

    def _set_status(self, user_id, to_status, allowed_from, extra_set=None, extra_values=None, extra_names=None):
        from botocore.exceptions import ClientError

        now = self._now()
        # Every attribute is a #placeholder: DynamoDB rejects reserved words (STATUS, VERSION, ...) used bare, and
        # the in-memory test double does not, so a bare name would pass the tests and fail in AWS.
        sets = ["#st = :to", "#ua = :now", "#g1 = :gpk", "#g2 = :now", "#v = #v + :one"]
        names = {"#st": "status", "#v": "version", "#ua": "updatedAt", "#g1": "gsi1pk", "#g2": "gsi1sk"}
        vals = {":to": to_status, ":now": now, ":gpk": f"STATUS#{PROVIDER}#{to_status}", ":one": 1}
        for i, s in enumerate(allowed_from):
            vals[f":f{i}"] = s
        for expr in extra_set or []:
            sets.append(expr)
        names.update(extra_names or {})
        vals.update(extra_values or {})
        cond = "attribute_exists(pk) AND #st IN (" + ", ".join(f":f{i}" for i in range(len(allowed_from))) + ")"
        try:
            r = self.client.update_item(
                TableName=self.table,
                Key=self._s(self._key(user_id)),
                UpdateExpression="SET " + ", ".join(sets),
                ConditionExpression=cond,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=self._s(vals),
                ReturnValues="ALL_NEW",
            )
        except ClientError as e:
            if self._cond_failed(e):
                cur = self.get(user_id)
                if cur is None:
                    raise RecordNotFound("no voice for this user")
                raise WrongState(f"voice is {cur.status}, expected {' or '.join(allowed_from)}")
            raise
        return self._record(r["Attributes"])

    def activate(self, user_id, voice_id, clips, needs_verification=False):
        return self._set_status(
            user_id, "active", ["pending"], ["#vid = :vid", "#clips = :clips", "#nv = :nv"], {":vid": voice_id, ":clips": list(clips), ":nv": bool(needs_verification)}, {"#vid": "voiceId", "#clips": "clips", "#nv": "needsVerification"}
        )

    def release(self, user_id):
        from botocore.exceptions import ClientError

        try:
            self.client.transact_write_items(
                TransactItems=[
                    {
                        "Delete": {
                            "TableName": self.table,
                            "Key": self._s(self._key(user_id)),
                            "ConditionExpression": "#st = :p",
                            "ExpressionAttributeNames": {"#st": "status"},
                            "ExpressionAttributeValues": self._s({":p": "pending"}),
                        }
                    },
                    {
                        "Update": {
                            "TableName": self.table,
                            "Key": self._s(self._META),
                            "UpdateExpression": "ADD #u :minus",
                            "ConditionExpression": "#u > :zero",
                            "ExpressionAttributeNames": {"#u": "used"},
                            "ExpressionAttributeValues": self._s({":minus": -1, ":zero": 0}),
                        }
                    },
                ]
            )
        except ClientError as e:
            if self._cancelled(e):
                cur = self.get(user_id)
                if cur is None:
                    raise RecordNotFound("no voice for this user")
                raise WrongState(f"voice is {cur.status}, expected pending")
            raise

    def update(self, user_id, settings=None, paused=None, needs_verification=None):
        cur = self.get(user_id)
        if cur is None:
            raise RecordNotFound("no voice for this user")
        to = cur.status if paused is None else ("paused" if paused else "active")
        extra, vals, names = [], {}, {}
        if settings is not None:
            extra.append("#settings = :settings")
            vals[":settings"] = dict(settings)
            names["#settings"] = "settings"
        if needs_verification is not None:
            extra.append("#nv = :nv")
            vals[":nv"] = bool(needs_verification)
            names["#nv"] = "needsVerification"
        return self._set_status(user_id, to, ["active", "paused"], extra, vals, names)

    def begin_delete(self, user_id):
        cur = self.get(user_id)
        if cur is None:
            raise RecordNotFound("no voice for this user")
        if cur.status == "deleting":
            return cur
        return self._set_status(user_id, "deleting", ["pending", "active", "paused", "deleting"])

    def finish_delete(self, user_id):
        from botocore.exceptions import ClientError

        cur = self.get(user_id)
        if cur is None:
            raise RecordNotFound("no voice for this user")
        now = self._now()
        audit = _audit_item(user_id, "deleted", cur.consent, now)
        audit_item = {"pk": f"USER#{user_id}", "sk": f"CONSENT#{now}#deleted", **audit}
        try:
            self.client.transact_write_items(
                TransactItems=[
                    {
                        "Delete": {
                            "TableName": self.table,
                            "Key": self._s(self._key(user_id)),
                            "ConditionExpression": "#st = :d",
                            "ExpressionAttributeNames": {"#st": "status"},
                            "ExpressionAttributeValues": self._s({":d": "deleting"}),
                        }
                    },
                    {
                        "Update": {
                            "TableName": self.table,
                            "Key": self._s(self._META),
                            "UpdateExpression": "ADD #u :minus",
                            "ConditionExpression": "#u > :zero",
                            "ExpressionAttributeNames": {"#u": "used"},
                            "ExpressionAttributeValues": self._s({":minus": -1, ":zero": 0}),
                        }
                    },
                    {"Put": {"TableName": self.table, "Item": self._s(audit_item)}},
                ]
            )
        except ClientError as e:
            if self._cancelled(e):
                raise WrongState("voice is not in the deleting state")
            raise

    def list_by_status(self, status, older_than=None, limit=100):
        names = {"#p": "gsi1pk"}
        vals = {":p": f"STATUS#{PROVIDER}#{status}"}
        cond = "#p = :p"
        if older_than:
            names["#s"] = "gsi1sk"
            vals[":o"] = older_than
            cond += " AND #s < :o"
        r = self.client.query(TableName=self.table, IndexName="gsi1", KeyConditionExpression=cond, ExpressionAttributeNames=names, ExpressionAttributeValues=self._s(vals), Limit=limit)
        return [self._record(i) for i in r.get("Items", [])]

    def slots_used(self):
        r = self.client.get_item(TableName=self.table, Key=self._s(self._META), ConsistentRead=True)
        return int(self._d(r["Item"]).get("used", 0)) if "Item" in r else 0

    def audit(self, user_id):
        r = self.client.query(
            TableName=self.table,
            KeyConditionExpression="pk = :p AND begins_with(sk, :c)",
            ExpressionAttributeValues=self._s({":p": f"USER#{user_id}", ":c": "CONSENT#"}),
            ConsistentRead=True,
        )
        out = []
        for i in r.get("Items", []):
            d = self._d(i)
            out.append({k: d[k] for k in ("userId", "action", "at", "consent", "ttl") if k in d})
        return out
