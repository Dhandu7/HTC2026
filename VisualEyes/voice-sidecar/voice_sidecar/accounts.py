"""User accounts: sign up, sign in, and per-user preferences, in the same DynamoDB table as the voice records.

Passwords are never stored. We store an argon2id hash (salted, memory-hard, the OWASP first choice), produced and
checked by argon2-cffi. A hash cannot be turned back into the password; signing in hashes the attempt and compares.

Every person's data lives under their own partition key, USER#<userId>, next to their voice record:

  pk                 sk          what
  USER#<userId>      ACCOUNT     email, display name, password hash, failed-sign-in counter, lock time
  USER#<userId>      PREFS       their preferences (a JSON document), version, updatedAt
  USER#<userId>      VOICE#...   their voice (records.py)
  EMAIL#<email>      EMAIL       userId: makes an email belong to at most one account

Sign-up writes ACCOUNT and EMAIL in one transaction with attribute_not_exists, so two sign-ups with the same email
cannot both succeed. The user id is random and never derived from the email, so changing an email later is possible
and the id leaks nothing.

Brute force: after MAX_FAILURES wrong passwords in a row an account is locked for LOCK_MINUTES. Sign-in for an
unknown email still spends one hash, so response time does not tell an attacker whether the email exists.
"""

from __future__ import annotations

import json
import re
import secrets
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional, Protocol

from .records import _from_ddb, _to_ddb, utc_now

MAX_FAILURES = 10
LOCK_MINUTES = 15
MIN_PASSWORD = 10
MAX_PASSWORD = 256  # argon2 copes with more, but a megabyte "password" is an attack, not a password
MAX_NAME = 60
MAX_PREFS_BYTES = 100 * 1024  # a DynamoDB item may be 400 KB; preferences are settings, not data dumps

EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,63}$")


class AccountError(Exception):
    status = 400


class EmailTaken(AccountError):
    status = 409


class BadCredentials(AccountError):
    status = 401


class AccountLocked(AccountError):
    status = 429

    def __init__(self, msg: str, retry_after: int):
        super().__init__(msg)
        self.retry_after = retry_after


class VersionConflict(AccountError):
    status = 409


@dataclass
class Account:
    user_id: str
    email: str
    name: str
    password_hash: str
    created_at: str
    failed_logins: int = 0
    locked_until: Optional[str] = None

    def public(self) -> dict:
        """What the app may see. Never the hash."""
        return {"userId": self.user_id, "email": self.email, "name": self.name, "createdAt": self.created_at}


@dataclass
class Preferences:
    data: dict = field(default_factory=dict)
    version: int = 0
    updated_at: Optional[str] = None

    def public(self) -> dict:
        return {"preferences": self.data, "version": self.version, "updatedAt": self.updated_at}


# --------------------------------------------------------------------------------------------------
# validation and hashing
# --------------------------------------------------------------------------------------------------


def normalize_email(email: str) -> str:
    e = (email or "").strip().lower()
    if len(e) > 254 or not EMAIL.match(e):
        raise AccountError("enter a valid email address")
    return e


def check_password(password: str) -> str:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        raise AccountError(f"use a password of at least {MIN_PASSWORD} characters")
    if len(password) > MAX_PASSWORD:
        raise AccountError(f"use a password of at most {MAX_PASSWORD} characters")
    return password


def check_name(name: Optional[str]) -> str:
    n = (name or "").strip()
    if len(n) > MAX_NAME:
        raise AccountError(f"use a name of at most {MAX_NAME} characters")
    return n


def check_prefs(prefs) -> str:
    """Preferences are any JSON object, stored as JSON text (no float/Decimal surprises, no nesting limits)."""
    if not isinstance(prefs, dict):
        raise AccountError("preferences must be a JSON object")
    raw = json.dumps(prefs, separators=(",", ":"), ensure_ascii=False)
    if len(raw.encode()) > MAX_PREFS_BYTES:
        raise AccountError(f"preferences are over {MAX_PREFS_BYTES // 1024} KB")
    return raw


class PasswordHasher:
    """argon2id. `fast=True` is for tests only (tiny memory cost); the default is RFC 9106's low-memory profile."""

    def __init__(self, fast: bool = False):
        from argon2 import PasswordHasher as _PH

        self._ph = _PH(time_cost=1, memory_cost=8, parallelism=1) if fast else _PH()
        self._dummy = self._ph.hash(secrets.token_urlsafe(16))

    def hash(self, password: str) -> str:
        return self._ph.hash(password)

    def verify(self, stored: str, password: str) -> bool:
        from argon2.exceptions import InvalidHashError, VerificationError

        try:
            return self._ph.verify(stored, password)
        except (VerificationError, InvalidHashError):
            return False

    def burn(self, password: str) -> None:
        """Spend the same time as a real check, for an email that has no account."""
        self.verify(self._dummy, password)

    def needs_rehash(self, stored: str) -> bool:
        return self._ph.check_needs_rehash(stored)


# --------------------------------------------------------------------------------------------------
# stores
# --------------------------------------------------------------------------------------------------


class AccountStore(Protocol):
    def create(self, account: Account) -> None: ...  # raises EmailTaken
    def get(self, user_id: str) -> Optional[Account]: ...
    def get_by_email(self, email: str) -> Optional[Account]: ...
    def record_failure(self, user_id: str, lock_until: Optional[str]) -> int: ...  # returns the new failure count
    def clear_failures(self, user_id: str, new_hash: Optional[str] = None) -> None: ...
    def get_prefs(self, user_id: str) -> Preferences: ...
    def put_prefs(self, user_id: str, prefs_json: str, expected_version: Optional[int], now: str) -> Preferences: ...


class MemoryAccountStore:
    def __init__(self):
        self._accounts: "dict[str, Account]" = {}
        self._emails: "dict[str, str]" = {}
        self._prefs: "dict[str, Preferences]" = {}
        self._lock = threading.Lock()

    def create(self, account):
        with self._lock:
            if account.email in self._emails:
                raise EmailTaken("an account with this email already exists")
            self._emails[account.email] = account.user_id
            self._accounts[account.user_id] = Account(**account.__dict__)

    def get(self, user_id):
        a = self._accounts.get(user_id)
        return Account(**a.__dict__) if a else None

    def get_by_email(self, email):
        uid = self._emails.get(email)
        return self.get(uid) if uid else None

    def record_failure(self, user_id, lock_until):
        with self._lock:
            a = self._accounts[user_id]
            a.failed_logins += 1
            if lock_until:
                a.locked_until, a.failed_logins = lock_until, 0
            return a.failed_logins

    def clear_failures(self, user_id, new_hash=None):
        with self._lock:
            a = self._accounts[user_id]
            a.failed_logins, a.locked_until = 0, None
            if new_hash:
                a.password_hash = new_hash

    def get_prefs(self, user_id):
        p = self._prefs.get(user_id)
        return Preferences(json.loads(json.dumps(p.data)), p.version, p.updated_at) if p else Preferences()

    def put_prefs(self, user_id, prefs_json, expected_version, now):
        with self._lock:
            cur = self._prefs.get(user_id) or Preferences()
            if expected_version is not None and expected_version != cur.version:
                raise VersionConflict("preferences changed on another device; reload them first")
            p = Preferences(json.loads(prefs_json), cur.version + 1, now)
            self._prefs[user_id] = p
            return Preferences(json.loads(prefs_json), p.version, now)


class DynamoAccountStore:
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
    def _acct_key(user_id: str) -> dict:
        return {"pk": f"USER#{user_id}", "sk": "ACCOUNT"}

    @staticmethod
    def _email_key(email: str) -> dict:
        return {"pk": f"EMAIL#{email}", "sk": "EMAIL"}

    @staticmethod
    def _prefs_key(user_id: str) -> dict:
        return {"pk": f"USER#{user_id}", "sk": "PREFS"}

    def create(self, account):
        from botocore.exceptions import ClientError

        item = {
            **self._acct_key(account.user_id),
            "userId": account.user_id,
            "email": account.email,
            "name": account.name,
            "passwordHash": account.password_hash,
            "createdAt": account.created_at,
            "failedLogins": 0,
        }
        try:
            self.client.transact_write_items(
                TransactItems=[
                    {"Put": {"TableName": self.table, "Item": self._s({**self._email_key(account.email), "userId": account.user_id, "createdAt": account.created_at}), "ConditionExpression": "attribute_not_exists(pk)"}},
                    {"Put": {"TableName": self.table, "Item": self._s(item), "ConditionExpression": "attribute_not_exists(pk)"}},
                ]
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "TransactionCanceledException":
                raise EmailTaken("an account with this email already exists")
            raise

    def get(self, user_id):
        r = self.client.get_item(TableName=self.table, Key=self._s(self._acct_key(user_id)), ConsistentRead=True)
        if "Item" not in r:
            return None
        d = self._d(r["Item"])
        return Account(d["userId"], d["email"], d.get("name", ""), d["passwordHash"], d["createdAt"], int(d.get("failedLogins", 0)), d.get("lockedUntil"))

    def get_by_email(self, email):
        r = self.client.get_item(TableName=self.table, Key=self._s(self._email_key(email)), ConsistentRead=True)
        return self.get(self._d(r["Item"])["userId"]) if "Item" in r else None

    def record_failure(self, user_id, lock_until):
        if lock_until:
            self.client.update_item(
                TableName=self.table,
                Key=self._s(self._acct_key(user_id)),
                UpdateExpression="SET #f = :zero, #l = :l",
                ConditionExpression="attribute_exists(pk)",
                ExpressionAttributeNames={"#f": "failedLogins", "#l": "lockedUntil"},
                ExpressionAttributeValues=self._s({":zero": 0, ":l": lock_until}),
            )
            return 0
        r = self.client.update_item(
            TableName=self.table,
            Key=self._s(self._acct_key(user_id)),
            UpdateExpression="ADD #f :one",
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeNames={"#f": "failedLogins"},
            ExpressionAttributeValues=self._s({":one": 1}),
            ReturnValues="UPDATED_NEW",
        )
        return int(self._d(r["Attributes"])["failedLogins"])

    def clear_failures(self, user_id, new_hash=None):
        names, values, sets = {"#f": "failedLogins", "#l": "lockedUntil"}, {":zero": 0}, ["#f = :zero"]
        if new_hash:
            names["#h"], values[":h"] = "passwordHash", new_hash
            sets.append("#h = :h")
        self.client.update_item(
            TableName=self.table,
            Key=self._s(self._acct_key(user_id)),
            UpdateExpression=f"SET {', '.join(sets)} REMOVE #l",
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=self._s(values),
        )

    def get_prefs(self, user_id):
        r = self.client.get_item(TableName=self.table, Key=self._s(self._prefs_key(user_id)), ConsistentRead=True)
        if "Item" not in r:
            return Preferences()
        d = self._d(r["Item"])
        return Preferences(json.loads(d["prefsJson"]), int(d["version"]), d.get("updatedAt"))

    def put_prefs(self, user_id, prefs_json, expected_version, now):
        from botocore.exceptions import ClientError

        names = {"#j": "prefsJson", "#v": "version", "#u": "updatedAt", "#id": "userId"}
        values = {":j": prefs_json, ":one": 1, ":u": now, ":id": user_id, ":zero": 0}
        cond = None
        if expected_version is not None:
            values[":expected"] = expected_version
            cond = "attribute_not_exists(pk) AND :expected = :zero" if expected_version == 0 else "#v = :expected"
        kwargs = dict(
            TableName=self.table,
            Key=self._s(self._prefs_key(user_id)),
            UpdateExpression="SET #j = :j, #u = :u, #id = :id, #v = if_not_exists(#v, :zero) + :one",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=self._s(values),
            ReturnValues="ALL_NEW",
        )
        if cond:
            kwargs["ConditionExpression"] = cond
        try:
            r = self.client.update_item(**kwargs)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise VersionConflict("preferences changed on another device; reload them first")
            raise
        d = self._d(r["Attributes"])
        return Preferences(json.loads(d["prefsJson"]), int(d["version"]), d["updatedAt"])


# --------------------------------------------------------------------------------------------------
# the flows
# --------------------------------------------------------------------------------------------------


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


class AccountService:
    def __init__(self, store: AccountStore, hasher: Optional[PasswordHasher] = None, now: Callable[[], str] = utc_now):
        self.store, self.hasher, self._now = store, hasher or PasswordHasher(), now

    def sign_up(self, email: str, password: str, name: Optional[str] = None) -> Account:
        email, password, name = normalize_email(email), check_password(password), check_name(name)
        account = Account("u_" + secrets.token_hex(16), email, name, self.hasher.hash(password), self._now())
        self.store.create(account)
        return account

    def sign_in(self, email: str, password: str) -> Account:
        wrong = BadCredentials("email or password is wrong")  # the same answer whether or not the email exists
        try:
            email = normalize_email(email)
        except AccountError:
            raise wrong
        if not isinstance(password, str) or len(password) > MAX_PASSWORD:
            raise wrong
        account = self.store.get_by_email(email)
        if account is None:
            self.hasher.burn(password)
            raise wrong
        now = _parse(self._now())
        if account.locked_until and _parse(account.locked_until) > now:
            wait = int((_parse(account.locked_until) - now).total_seconds()) + 1
            raise AccountLocked(f"too many wrong passwords; try again in {max(1, wait // 60)} minute(s)", wait)
        if not self.hasher.verify(account.password_hash, password):
            lock = None
            if account.failed_logins + 1 >= MAX_FAILURES:
                lock = (now + timedelta(minutes=LOCK_MINUTES)).isoformat(timespec="milliseconds")
            self.store.record_failure(account.user_id, lock)
            raise wrong
        rehash = self.hasher.hash(password) if self.hasher.needs_rehash(account.password_hash) else None
        if account.failed_logins or account.locked_until or rehash:
            self.store.clear_failures(account.user_id, rehash)
        return account

    def get(self, user_id: str) -> Account:
        a = self.store.get(user_id)
        if a is None:
            raise AccountError("no account")  # a token for a user that no longer exists
        return a

    def get_prefs(self, user_id: str) -> Preferences:
        return self.store.get_prefs(user_id)

    def put_prefs(self, user_id: str, prefs, expected_version: Optional[int] = None) -> Preferences:
        return self.store.put_prefs(user_id, check_prefs(prefs), expected_version, self._now())


# --------------------------------------------------------------------------------------------------
# tokens: we are the issuer; the voice routes verify them with JwtAuth and the local public key
# --------------------------------------------------------------------------------------------------


class TokenIssuer:
    """Signs RS256 access tokens. The private key comes from Secrets Manager in production (never from the repo)."""

    def __init__(self, private_key_pem: Optional[str], issuer: str, audience: str = "vocaleyes-app", ttl_hours: int = 24 * 7):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        if private_key_pem:
            self._key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
        else:
            self._key = rsa.generate_private_key(public_exponent=65537, key_size=2048)  # ephemeral: local development only
        self.issuer, self.audience, self.ttl = issuer, audience, timedelta(hours=ttl_hours)
        import hashlib

        pub_der = self._key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        self.kid = hashlib.sha256(pub_der).hexdigest()[:16]

    def issue(self, user_id: str) -> "tuple[str, str]":
        import jwt

        now = datetime.now(timezone.utc)
        exp = now + self.ttl
        token = jwt.encode(
            {"sub": user_id, "iss": self.issuer, "aud": self.audience, "iat": now, "exp": exp, "jti": secrets.token_hex(8)},
            self._key,
            algorithm="RS256",
            headers={"kid": self.kid},
        )
        return token, exp.isoformat(timespec="seconds")

    def jwks(self) -> dict:
        import jwt

        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self._key.public_key()))
        return {"keys": [{**jwk, "kid": self.kid, "use": "sig", "alg": "RS256"}]}

    def jwk_client(self):
        """Stands in for jwt.PyJWKClient so JwtAuth verifies our tokens without a network call to ourselves."""
        issuer = self

        class _Local:
            def get_signing_key_from_jwt(self, token):
                import jwt

                if jwt.get_unverified_header(token).get("kid") != issuer.kid:
                    raise jwt.InvalidTokenError("unknown key")
                return type("K", (), {"key": issuer._key.public_key()})()

        return _Local()
