"""A stand-in for ElevenLabs' API, built on httpx.MockTransport, that checks what we send the way the real one would."""

import json
import re

import httpx

API_KEY = "sk_test_fake_key_do_not_use"


class FakeElevenLabs:
    def __init__(self, voice_limit=None):
        self.voices = {}  # voice_id -> {"name", "files": [(filename, size)]}
        self.requests = []  # (method, path, query, headers) of every call, for assertions
        self.speak_calls = []
        self.fail_next = []  # queue of ("clone"|"speak"|"delete", status) to fail once
        self.voice_limit = voice_limit
        self.subscription = {"tier": "starter", "status": "active", "character_count": 1200, "character_limit": 75000, "voice_limit": 10, "voice_slots_used": 2, "can_use_instant_voice_cloning": True, "can_use_professional_voice_cloning": False, "current_overage": {"x": 1}}
        self.subscription_status = 200
        self._n = 0
        self.transport = httpx.MockTransport(self.handle)

    def fail(self, op, status):
        self.fail_next.append((op, status))

    def _failing(self, op):
        for i, (o, s) in enumerate(self.fail_next):
            if o == op:
                del self.fail_next[i]
                return s
        return None

    def handle(self, req: httpx.Request) -> httpx.Response:
        self.requests.append((req.method, req.url.path, dict(req.url.params), dict(req.headers)))
        if req.headers.get("xi-api-key") != API_KEY:
            return httpx.Response(401, json={"detail": {"status": "invalid_api_key"}})
        path = req.url.path
        if req.method == "GET" and path == "/v1/user/subscription":
            if self.subscription_status != 200:
                return httpx.Response(self.subscription_status, json={"detail": {"status": "missing_permissions"}})
            return httpx.Response(200, json=self.subscription)
        if req.method == "POST" and path == "/v1/voices/add":
            if (s := self._failing("clone")):
                return httpx.Response(s, json={"detail": [{"loc": ["body"], "msg": "bad sample", "type": "x", "input": "PRIVATE USER TEXT"}]})
            if self.voice_limit is not None and len(self.voices) >= self.voice_limit:
                return httpx.Response(400, json={"detail": {"status": "voice_limit_reached", "message": "limit"}})
            body = req.read()
            ctype = req.headers["content-type"]
            assert ctype.startswith("multipart/form-data"), ctype
            name = re.search(rb'name="name"\r\n\r\n([^\r]*)', body)
            files = re.findall(rb'name="files"; filename="([^"]*)"', body)
            assert name and files, "multipart must carry name and at least one file"
            self._n += 1
            vid = f"voice{self._n:016d}"
            self.voices[vid] = {"name": name.group(1).decode(), "files": [f.decode() for f in files]}
            return httpx.Response(200, json={"voice_id": vid, "requires_verification": False})
        m = re.fullmatch(r"/v1/text-to-speech/([^/]+)", path)
        if req.method == "POST" and m:
            if (s := self._failing("speak")):
                return httpx.Response(s, headers={"retry-after": "7"} if s == 429 else {}, json={"detail": {"message": "x"}})
            if m.group(1) not in self.voices:
                return httpx.Response(404, json={"detail": {"status": "voice_not_found"}})
            body = json.loads(req.read())
            self.speak_calls.append({"voice_id": m.group(1), "query": dict(req.url.params), "body": body})
            return httpx.Response(200, content=b"ID3fake-mp3-bytes", headers={"content-type": "audio/mpeg"})
        m = re.fullmatch(r"/v1/voices/([^/]+)", path)
        if req.method == "DELETE" and m:
            if (s := self._failing("delete")):
                return httpx.Response(s, json={"detail": "boom"})
            if m.group(1) not in self.voices:
                return httpx.Response(404, json={"detail": {"status": "voice_not_found"}})
            del self.voices[m.group(1)]
            return httpx.Response(200, json={"status": "ok"})
        return httpx.Response(404, json={"detail": "no such route in the fake"})
