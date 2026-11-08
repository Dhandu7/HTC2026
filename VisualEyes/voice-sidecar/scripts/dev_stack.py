"""Run the hosted voice service on your laptop with a FAKE ElevenLabs, so the app screens can be built and tried
with no API key and no AWS:

  ./hosted.sh dev            # service on http://127.0.0.1:8790, fake ElevenLabs on :8794
  FAKE_REQUIRE_VERIFICATION=1 ./hosted.sh dev   # new voices must be "verified" first, like the real thing;
                                                # then   curl -X POST http://127.0.0.1:8794/fake/verify-all   verifies them

The fake keeps voices in memory and "speaks" a tone whose length follows the text. It is NOT speech and it never
talks to the internet. The service runs with in-memory records and dev login (X-User-Id header), which the server
only allows on a loopback address. Everything is lost when you stop it.
"""

import io
import json
import math
import os
import re
import struct
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

FAKE_PORT = int(os.environ.get("FAKE_ELEVENLABS_PORT", "8794"))
VOICES: "dict[str, dict]" = {}
UNVERIFIED: "set[str]" = set()
REQUIRE_VERIFICATION = os.environ.get("FAKE_REQUIRE_VERIFICATION") == "1"


def tone(text: str, sr: int = 22050) -> bytes:
    seconds = min(8.0, max(0.4, len(text) * 0.05))
    n = int(sr * seconds)
    frames = bytearray()
    for i in range(n):
        fade = min(1.0, i / 800, (n - i) / 800)
        v = 0.25 * fade * math.sin(2 * math.pi * 220 * i / sr) * (0.6 + 0.4 * math.sin(2 * math.pi * 3 * i / sr))
        frames += struct.pack("<h", int(v * 32767))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(sr)
        w.writeframes(bytes(frames))
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep the terminal quiet and never print request content
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode())

    def _authed(self):
        if not self.headers.get("xi-api-key"):
            self._json(401, {"detail": {"status": "invalid_api_key"}})
            return False
        return True

    def do_POST(self):
        if self.path == "/fake/verify-all":  # dev only: pretend the owner completed verification in the dashboard
            UNVERIFIED.clear()
            return self._json(200, {"verified": True})
        if not self._authed():
            return
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path == "/v1/voices/add":
            files = re.findall(rb'name="files"; filename="([^"]*)"', body)
            if not files:
                return self._json(422, {"detail": [{"loc": ["body", "files"], "msg": "field required", "type": "missing"}]})
            vid = f"fake{len(VOICES) + 1:016d}"
            VOICES[vid] = {"files": len(files)}
            if REQUIRE_VERIFICATION:
                UNVERIFIED.add(vid)
            return self._json(200, {"voice_id": vid, "requires_verification": vid in UNVERIFIED})
        m = re.fullmatch(r"/v1/text-to-speech/([^/?]+)", self.path.split("?")[0])
        if m:
            if m.group(1) not in VOICES:
                return self._json(404, {"detail": {"status": "voice_not_found"}})
            if m.group(1) in UNVERIFIED:
                return self._json(403, {"detail": {"status": "needs_verification", "message": "This voice requires verification. Please verify your voice to continue."}})
            text = json.loads(body).get("text", "")
            return self._send(200, tone(text), "audio/wav")
        self._json(404, {"detail": "not in the fake"})

    def do_DELETE(self):
        if not self._authed():
            return
        m = re.fullmatch(r"/v1/voices/([^/?]+)", self.path.split("?")[0])
        if m and VOICES.pop(m.group(1), None) is not None:
            return self._json(200, {"status": "ok"})
        self._json(404, {"detail": {"status": "voice_not_found"}})


def main() -> int:
    srv = ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ.update(
        {
            "VOICE_STORE": "memory",
            "AUTH_MODE": "accounts",  # sign-in pages work against this too; the dev login still does (loopback)
            "ELEVENLABS_API_KEY": "fake-dev-key",
            "ELEVENLABS_BASE_URL": f"http://127.0.0.1:{FAKE_PORT}",
            "CORS_ORIGINS": os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,null"),
            "VOICE_SLOT_LIMIT": "5",
            "SPEAK_PER_MINUTE": "120",
            "HOST": "127.0.0.1",
            "PORT": os.environ.get("PORT", "8790"),
        }
    )
    print("=" * 66, flush=True)
    print(" DEV STACK: fake ElevenLabs (tones, not speech), in-memory records, dev login", flush=True)
    print(f" voice service  http://127.0.0.1:{os.environ['PORT']}     fake ElevenLabs  http://127.0.0.1:{FAKE_PORT}", flush=True)
    print(" nothing leaves this machine; everything is lost when you stop it (Ctrl-C)", flush=True)
    print("=" * 66, flush=True)
    from voice_sidecar.hosted_main import main as serve

    return serve(["serve"])


if __name__ == "__main__":
    raise SystemExit(main())
