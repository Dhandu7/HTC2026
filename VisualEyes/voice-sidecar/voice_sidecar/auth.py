"""Who is calling? The user id comes from a verified token, never from the request body or a voice id.

JwtAuth verifies an OIDC-style bearer token (Cognito or any issuer with a JWKS endpoint): signature, expiry,
issuer, and optionally audience / client id. The user id is the token's `sub`. API Gateway may also verify
the token; verifying again here is defence in depth, not a replacement for network controls.

DevAuth trusts an X-User-Id header. It exists for local development only and the server refuses to use it
unless it is bound to a loopback address.
"""

from __future__ import annotations

import re
from typing import Optional

USER_ID = re.compile(r"^[A-Za-z0-9_.@:|-]{1,128}$")


class AuthError(Exception):
    pass


def bearer_token(request) -> str:
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer ") or len(h) < 10:
        raise AuthError("missing bearer token")
    return h[7:].strip()


class DevAuth:
    name = "dev"

    def user_id(self, request) -> str:
        uid = request.headers.get("x-user-id", "")
        if not USER_ID.match(uid):
            raise AuthError("missing or invalid X-User-Id (dev auth)")
        return uid


class JwtAuth:
    name = "jwt"

    def __init__(self, issuer: str, audience: Optional[str] = None, jwks_url: Optional[str] = None, jwk_client=None, leeway: int = 10):
        if not issuer:
            raise ValueError("JWT_ISSUER is required")
        self.issuer, self.audience, self.leeway = issuer, audience, leeway
        if jwk_client is None:
            import jwt

            jwk_client = jwt.PyJWKClient(jwks_url or issuer.rstrip("/") + "/.well-known/jwks.json", cache_keys=True)
        self._jwks = jwk_client

    def user_id(self, request) -> str:
        import jwt

        token = bearer_token(request)
        try:
            key = self._jwks.get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],  # never accept "none" or a symmetric algorithm for a public-key issuer
                issuer=self.issuer,
                leeway=self.leeway,
                options={"require": ["exp", "iss", "sub"], "verify_aud": False},  # audience is checked below: Cognito access tokens have client_id, not aud
            )
        except Exception:
            raise AuthError("invalid or expired token")  # no detail: do not help an attacker tell why
        if self.audience:
            aud = claims.get("aud")
            auds = aud if isinstance(aud, list) else [aud]
            if self.audience not in auds and claims.get("client_id") != self.audience:
                raise AuthError("invalid or expired token")
        sub = str(claims["sub"])
        if not USER_ID.match(sub):
            raise AuthError("invalid or expired token")
        return sub


class FirstOf:
    """Auth0 mode on a laptop: a bearer token if one is sent, else the dev X-User-Id header. Built only when the
    server is bound to a loopback address (hosted_main.build_auth), exactly like DevAuth on its own."""

    def __init__(self, primary, fallback):
        self.primary, self.fallback = primary, fallback
        self.name = f"{primary.name}+{fallback.name}"

    def user_id(self, request) -> str:
        if request.headers.get("authorization"):
            return self.primary.user_id(request)  # a bad token is an error, never a silent fall back to the header
        return self.fallback.user_id(request)
