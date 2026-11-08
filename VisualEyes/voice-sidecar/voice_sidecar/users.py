"""Per-user data for signed-in people: their profile (email, name) and preferences, in the same DynamoDB table as
the voice records. Sign-in itself is Auth0's job: passwords, sign-up, resets and social logins never touch this
service. We only verify Auth0's access token (auth.JwtAuth) and use its `sub` as the user id.

  pk                 sk          what
  USER#<sub>         PROFILE     email, name, emailVerified, updatedAt (copied from Auth0's /userinfo)
  USER#<sub>         PREFS       their preferences (a JSON document), version, updatedAt
  USER#<sub>         VOICE#...   their voice (records.py)

<sub> is Auth0's user id, e.g. "auth0|65f..." or "google-oauth2|1047...". It never changes for a person, so their
voice and preferences follow them to any device they sign in on.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol

from .records import _from_ddb, _to_ddb, utc_now

MAX_PREFS_BYTES = 100 * 1024  # a DynamoDB item may be 400 KB; preferences are settings, not data dumps


class UserError(Exception):
    status = 400


class VersionConflict(UserError):
    status = 409


@dataclass
class Preferences:
    data: dict = field(default_factory=dict)
    version: int = 0
    updated_at: Optional[str] = None

    def public(self) -> dict:
        return {"preferences": self.data, "version": self.version, "updatedAt": self.updated_at}


@dataclass
class Profile:
    user_id: str
    email: Optional[str] = None
    name: Optional[str] = None
    email_verified: bool = False
    updated_at: Optional[str] = None

    def public(self) -> dict:
        return {"userId": self.user_id, "email": self.email, "name": self.name, "emailVerified": self.email_verified}


def check_prefs(prefs) -> str:
    """Preferences are any JSON object, stored as JSON text (no float/Decimal surprises, no nesting limits)."""
    if not isinstance(prefs, dict):
        raise UserError("preferences must be a JSON object")
    raw = json.dumps(prefs, separators=(",", ":"), ensure_ascii=False)
    if len(raw.encode()) > MAX_PREFS_BYTES:
        raise UserError(f"preferences are over {MAX_PREFS_BYTES // 1024} KB")
    return raw


# --------------------------------------------------------------------------------------------------
# stores
# --------------------------------------------------------------------------------------------------


class UserStore(Protocol):
    def get_profile(self, user_id: str) -> Optional[Profile]: ...
    def put_profile(self, profile: Profile) -> None: ...
    def get_prefs(self, user_id: str) -> Preferences: ...
    def put_prefs(self, user_id: str, prefs_json: str, expected_version: Optional[int], now: str) -> Preferences: ...


class MemoryUserStore:
    def __init__(self):
        self._profiles: "dict[str, Profile]" = {}
        self._prefs: "dict[str, Preferences]" = {}
        self._lock = threading.Lock()

    def get_profile(self, user_id):
        p = self._profiles.get(user_id)
        return Profile(**p.__dict__) if p else None

    def put_profile(self, profile):
        self._profiles[profile.user_id] = Profile(**profile.__dict__)

    def get_prefs(self, user_id):
        p = self._prefs.get(user_id)
        return Preferences(json.loads(json.dumps(p.data)), p.version, p.updated_at) if p else Preferences()

    def put_prefs(self, user_id, prefs_json, expected_version, now):
        with self._lock:
            cur = self._prefs.get(user_id) or Preferences()
            if expected_version is not None and expected_version != cur.version:
                raise VersionConflict("preferences changed on another device; reload them first")
            self._prefs[user_id] = Preferences(json.loads(prefs_json), cur.version + 1, now)
            return Preferences(json.loads(prefs_json), cur.version + 1, now)


class DynamoUserStore:
    """Same table as DynamoRecordStore (see records.table_definition). Item-level actions only, no Scan."""

    def __init__(self, table_name: str, client=None, region: Optional[str] = None):
        import boto3
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

        self.table = table_name
        self.client = client or boto3.client("dynamodb", region_name=region)
        self._ser, self._de = TypeSerializer(), TypeDeserializer()

    def _s(self, d: dict) -> dict:
        return {k: self._ser.serialize(_to_ddb(v)) for k, v in d.items()}

    def _d(self, item: dict) -> dict:
        return {k: _from_ddb(self._de.deserialize(v)) for k, v in item.items()}

    @staticmethod
    def _key(user_id: str, sk: str) -> dict:
        return {"pk": f"USER#{user_id}", "sk": sk}

    def get_profile(self, user_id):
        r = self.client.get_item(TableName=self.table, Key=self._s(self._key(user_id, "PROFILE")), ConsistentRead=True)
        if "Item" not in r:
            return None
        d = self._d(r["Item"])
        return Profile(user_id, d.get("email"), d.get("name"), bool(d.get("emailVerified", False)), d.get("updatedAt"))

    def put_profile(self, profile):
        item = {**self._key(profile.user_id, "PROFILE"), "userId": profile.user_id, "emailVerified": profile.email_verified, "updatedAt": profile.updated_at}
        if profile.email:
            item["email"] = profile.email
        if profile.name:
            item["name"] = profile.name
        self.client.put_item(TableName=self.table, Item=self._s(item))

    def get_prefs(self, user_id):
        r = self.client.get_item(TableName=self.table, Key=self._s(self._key(user_id, "PREFS")), ConsistentRead=True)
        if "Item" not in r:
            return Preferences()
        d = self._d(r["Item"])
        return Preferences(json.loads(d["prefsJson"]), int(d["version"]), d.get("updatedAt"))

    def put_prefs(self, user_id, prefs_json, expected_version, now):
        from botocore.exceptions import ClientError

        names = {"#j": "prefsJson", "#v": "version", "#u": "updatedAt", "#id": "userId"}
        values = {":j": prefs_json, ":one": 1, ":u": now, ":id": user_id, ":zero": 0}
        kwargs = dict(
            TableName=self.table,
            Key=self._s(self._key(user_id, "PREFS")),
            UpdateExpression="SET #j = :j, #u = :u, #id = :id, #v = if_not_exists(#v, :zero) + :one",
            ExpressionAttributeNames=names,
            ReturnValues="ALL_NEW",
        )
        if expected_version is not None:
            values[":expected"] = expected_version
            kwargs["ConditionExpression"] = "attribute_not_exists(pk)" if expected_version == 0 else "#v = :expected"
            if expected_version == 0:
                del values[":expected"]
        kwargs["ExpressionAttributeValues"] = self._s(values)
        try:
            r = self.client.update_item(**kwargs)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise VersionConflict("preferences changed on another device; reload them first")
            raise
        d = self._d(r["Attributes"])
        return Preferences(json.loads(d["prefsJson"]), int(d["version"]), d["updatedAt"])


# --------------------------------------------------------------------------------------------------
# Auth0 /userinfo: the verified email and name for the token's user
# --------------------------------------------------------------------------------------------------


class Auth0UserInfo:
    """Calls https://<domain>/userinfo with the user's own access token. Auth0 adds the userinfo audience to an access
    token requested with scope "openid", so no extra secret is needed. Auth0 rate-limits this endpoint per user, so the
    service calls it only from GET /v1/me (once per sign-in) and caches the result in the PROFILE item."""

    def __init__(self, domain: str, transport=None, timeout: float = 5.0):
        self.url = f"https://{domain.strip().rstrip('/').removeprefix('https://')}/userinfo"
        self._transport, self._timeout = transport, timeout

    def fetch(self, access_token: str) -> Optional[dict]:
        import httpx

        try:
            with httpx.Client(transport=self._transport, timeout=self._timeout) as c:
                r = c.get(self.url, headers={"Authorization": f"Bearer {access_token}"})
            return r.json() if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None  # the profile is a nicety; never fail the request over it


class UserService:
    def __init__(self, store: UserStore, userinfo: Optional[Auth0UserInfo] = None, now: Callable[[], str] = utc_now, refresh_after_s: int = 600):
        self.store, self.userinfo, self._now, self.refresh_after_s = store, userinfo, now, refresh_after_s

    def me(self, user_id: str, access_token: Optional[str]) -> Profile:
        """The profile, refreshed from Auth0 if it is missing or older than refresh_after_s."""
        from datetime import datetime

        cur = self.store.get_profile(user_id)
        fresh = cur and cur.updated_at and (datetime.fromisoformat(self._now()) - datetime.fromisoformat(cur.updated_at)).total_seconds() < self.refresh_after_s
        if fresh or not (self.userinfo and access_token):
            return cur or Profile(user_id)
        info = self.userinfo.fetch(access_token)
        if not info or str(info.get("sub")) != user_id:  # only ever store what Auth0 says about THIS user
            return cur or Profile(user_id)
        p = Profile(user_id, info.get("email"), info.get("name") or info.get("nickname"), bool(info.get("email_verified", False)), self._now())
        self.store.put_profile(p)
        return p

    def get_prefs(self, user_id: str) -> Preferences:
        return self.store.get_prefs(user_id)

    def put_prefs(self, user_id: str, prefs, expected_version: Optional[int] = None) -> Preferences:
        return self.store.put_prefs(user_id, check_prefs(prefs), expected_version, self._now())
