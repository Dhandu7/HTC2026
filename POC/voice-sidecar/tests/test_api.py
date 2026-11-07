"""API and rules tests. They run with the fake engine, so no models or torch are needed."""

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from voice_sidecar.app import create_app
from voice_sidecar.audio import analyze, wav_bytes
from voice_sidecar.cli import main as cli_main
from voice_sidecar.config import Settings
from voice_sidecar.fake_engine import FakeEngine

TOKEN = "test-token"
H = {"X-Sidecar-Token": TOKEN}
CONSENT = {"consent": {"mode": "self", "acknowledged": True}}


def speechish(seconds=4.0, sr=24000, amp=0.3, seed=0):
    """Noise with a 4 Hz syllable-like envelope: loud enough, mostly 'voiced'."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    env = 0.55 + 0.45 * np.sin(2 * np.pi * 4 * t)
    return (amp * env * rng.standard_normal(len(t)) * 0.5).clip(-0.95, 0.95).astype(np.float32), sr


def wav(samples, sr):
    return wav_bytes(samples, sr)


@pytest.fixture
def env(tmp_path):
    settings = Settings(data_dir=tmp_path, token=TOKEN, engine="fake")
    engine = FakeEngine()
    app = create_app(settings, engine, warm_in_background=False)
    return TestClient(app), settings, engine, tmp_path


@pytest.fixture
def client(env):
    return env[0]


def make_profile(client):
    r = client.post("/v1/profiles", json=CONSENT, headers=H)
    assert r.status_code == 200, r.text
    return r.json()["profileId"]


def add_clip(client, pid, label="hello", data=None):
    data = data or wav(*speechish())
    return client.post(f"/v1/profiles/{pid}/clips", files={"file": ("a.wav", data, "audio/wav")}, data={"label": label}, headers=H)


# ---------------- auth ----------------


def test_health_and_ui_are_open_and_hold_no_data(client):
    h = client.get("/health").json()
    assert h["ok"] and h["engine"] == "fake"
    ui = client.get("/ui")
    assert ui.status_code == 200 and "voice lab" in ui.text
    assert TOKEN not in ui.text


@pytest.mark.parametrize("headers", [{}, {"X-Sidecar-Token": "nope"}, {"Authorization": "Bearer nope"}])
def test_everything_else_needs_the_token(client, headers):
    assert client.post("/v1/profiles", json=CONSENT, headers=headers).status_code == 401
    assert client.post("/v1/synthesize", json={"profileId": "a" * 32, "text": "hi"}, headers=headers).status_code == 401


def test_bearer_token_works(client):
    assert client.post("/v1/profiles", json=CONSENT, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200


# ---------------- consent ----------------


def test_a_profile_cannot_be_created_without_acknowledgement(client):
    for body in (
        {"consent": {"mode": "self", "acknowledged": False}},
        {"consent": {"mode": "self"}},
        {"consent": {"mode": "someone-else", "acknowledged": True}},
        {"consent": {"mode": "authorized", "acknowledged": True}},
        {"consent": {"mode": "authorized", "acknowledged": True, "authorizedBy": "  "}},
    ):
        r = client.post("/v1/profiles", json=body, headers=H)
        assert r.status_code == 422, body
    assert client.post("/v1/profiles", json={}, headers=H).status_code == 422


def test_authorized_consent_records_who_gave_permission(client):
    r = client.post("/v1/profiles", json={"consent": {"mode": "authorized", "acknowledged": True, "authorizedBy": " Sam "}}, headers=H)
    pid = r.json()["profileId"]
    c = client.get(f"/v1/profiles/{pid}", headers=H).json()["consent"]
    assert c["mode"] == "authorized" and c["authorizedBy"] == "Sam" and c["ts"] > 0


def test_no_consent_record_means_no_audio(env):
    client, _, _, data = env
    pid = make_profile(client)
    assert add_clip(client, pid).status_code == 200
    assert client.post(f"/v1/profiles/{pid}/build", headers=H).status_code == 200
    (data / "profiles" / pid / "consent.json").unlink()
    r = client.post("/v1/synthesize", json={"profileId": pid, "text": "hello"}, headers=H)
    assert r.status_code == 422 and "consent" in r.json()["error"]
    assert add_clip(client, pid).status_code == 422
    assert client.post(f"/v1/profiles/{pid}/build", headers=H).status_code == 422


def test_profile_ids_cannot_escape_the_profiles_directory(client):
    for bad in ("..", "..%2F..%2Fetc", "a" * 31, "A" * 32, "../" + "a" * 29):
        assert client.get(f"/v1/profiles/{bad}", headers=H).status_code in (404, 405), bad
    pid = make_profile(client)
    assert client.get(f"/v1/profiles/{pid}/clips/..%2Fconsent.json", headers=H).status_code == 404
    assert client.get(f"/v1/profiles/{pid}/clips/clip-1.wav", headers=H).status_code == 404


# ---------------- clips ----------------


def test_a_good_clip_is_stored_with_its_quality_report(client):
    pid = make_profile(client)
    r = add_clip(client, pid, label="Greeting")
    assert r.status_code == 200
    body = r.json()
    assert body["split"] is False and body["skipped"] == [] and len(body["clips"]) == 1
    clip = body["clips"][0]
    assert clip["name"] == "clip-001.wav" and clip["label"] == "Greeting"
    assert clip["report"]["ok"] and clip["report"]["seconds"] == pytest.approx(4.0, abs=0.05)
    s = client.get(f"/v1/profiles/{pid}", headers=H).json()
    assert [c["name"] for c in s["clips"]] == ["clip-001.wav"] and s["referenceSeconds"] == pytest.approx(4.0, abs=0.1)
    assert client.get(f"/v1/profiles/{pid}/clips/clip-001.wav", headers=H).content[:4] == b"RIFF"


@pytest.mark.parametrize(
    "make,expect",
    [
        (lambda: wav(*speechish(seconds=0.5)), "too short"),
        (lambda: wav(np.zeros(24000 * 3, np.float32), 24000), "almost no speech"),
        (lambda: wav(*speechish(amp=0.02)), "quiet"),
        (lambda: wav(np.clip(speechish(amp=6.0)[0] * 40, -1, 1).astype(np.float32), 24000), "clipping"),
        (lambda: b"this is not audio at all", "could not read"),
    ],
)
def test_bad_clips_are_rejected_with_a_reason(client, make, expect):
    pid = make_profile(client)
    r = add_clip(client, pid, data=make())
    assert r.status_code == 422
    body = r.json()
    assert expect in body["error"], body
    assert client.get(f"/v1/profiles/{pid}", headers=H).json()["clips"] == []  # nothing was stored


def test_oversized_uploads_are_refused(env):
    client, settings, _, _ = env
    settings.max_upload_bytes = 1000
    pid = make_profile(client)
    assert add_clip(client, pid).status_code == 413


def test_removing_a_clip_deletes_the_file_and_invalidates_the_build(env):
    client, _, _, data = env
    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    r = client.delete(f"/v1/profiles/{pid}/clips/clip-001.wav", headers=H)
    assert r.status_code == 200 and r.json()["clips"] == [] and r.json()["built"] is False
    assert not (data / "profiles" / pid / "clips" / "clip-001.wav").exists()


# ---------------- build and speak ----------------


def test_build_needs_clips_then_bumps_the_version(client, env):
    pid = make_profile(client)
    assert client.post(f"/v1/profiles/{pid}/build", headers=H).status_code == 409
    add_clip(client, pid)
    b = client.post(f"/v1/profiles/{pid}/build", headers=H).json()
    assert b["embeddingVersion"] == 1 and b["clipsUsed"] == 1
    assert client.get(f"/v1/profiles/{pid}", headers=H).json()["built"] is True
    add_clip(client, pid)  # new audio makes the old embedding stale
    assert client.get(f"/v1/profiles/{pid}", headers=H).json()["built"] is False
    assert client.post(f"/v1/profiles/{pid}/build", headers=H).json()["embeddingVersion"] == 2


def test_build_uses_newest_clips_up_to_the_reference_cap(env):
    client, settings, engine, _ = env
    settings.max_reference_seconds = 9.0
    pid = make_profile(client)
    for _ in range(4):
        add_clip(client, pid)  # 4 s each
    assert client.post(f"/v1/profiles/{pid}/build", headers=H).json()["clipsUsed"] == 3  # 4+4=8 < 9, so a third is taken


def test_speaking_needs_a_built_voice_but_the_stock_voice_does_not(client):
    pid = make_profile(client)
    body = {"profileId": pid, "text": "Hello, it's me."}
    r = client.post("/v1/synthesize", json=body, headers=H)
    assert r.status_code == 409 and "built" in r.json()["error"]
    raw = client.post("/v1/synthesize", json={**body, "raw": True}, headers=H)
    assert raw.status_code == 200 and raw.headers["x-ai-assisted"] == "false"


def test_cloned_speech_is_returned_as_wav_and_labelled_ai_assisted(client):
    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    r = client.post("/v1/synthesize", json={"profileId": pid, "text": "Hello, it's me."}, headers=H)
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert r.headers["x-ai-assisted"] == "true" and r.headers["x-embedding-version"] == "1"
    assert int(r.headers["x-render-ms"]) >= 0 and r.headers["cache-control"] == "no-store"
    audio, sr = sf.read(io.BytesIO(r.content))
    assert sr == 24000 and len(audio) > 1000


@pytest.mark.parametrize("text", ["", "   ", "x" * 501])
def test_bad_text_is_rejected(client, text):
    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    assert client.post("/v1/synthesize", json={"profileId": pid, "text": text}, headers=H).status_code == 400


def test_pace_and_strength_are_clamped_to_safe_ranges(env):
    client, _, engine, _ = env
    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    client.post("/v1/synthesize", json={"profileId": pid, "text": "hi", "pace": 9, "tau": -3}, headers=H)
    client.post("/v1/synthesize", json={"profileId": pid, "text": "hi", "pace": 0.01, "tau": 9}, headers=H)
    assert [(r["pace"], r["tau"]) for r in engine.renders] == [(1.2, 0.1), (0.8, 0.6)]


def test_a_paused_voice_cannot_speak_until_resumed(client):
    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    assert client.patch(f"/v1/profiles/{pid}", json={"paused": True}, headers=H).json()["paused"] is True
    for raw in (False, True):
        assert client.post("/v1/synthesize", json={"profileId": pid, "text": "hi", "raw": raw}, headers=H).status_code == 423
    client.patch(f"/v1/profiles/{pid}", json={"paused": False}, headers=H)
    assert client.post("/v1/synthesize", json={"profileId": pid, "text": "hi"}, headers=H).status_code == 200


# ---------------- export and delete ----------------


def test_export_contains_clips_embedding_and_consent(client):
    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/v1/profiles/{pid}/export", headers=H).content))
    names = set(z.namelist())
    assert {"consent.json", "meta.json", "embedding-fake.pt", "clips/clip-001.wav"} <= names
    assert json.loads(z.read("consent.json"))["mode"] == "self"


def test_delete_removes_everything_for_that_voice(env):
    client, _, _, data = env
    pid = make_profile(client)
    other = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    assert client.delete(f"/v1/profiles/{pid}", headers=H).json() == {"deleted": True}
    assert not (data / "profiles" / pid).exists()
    assert client.get(f"/v1/profiles/{pid}", headers=H).status_code == 404
    assert client.post("/v1/synthesize", json={"profileId": pid, "text": "hi", "raw": True}, headers=H).status_code == 404
    assert (data / "profiles" / other).is_dir()  # the other voice is untouched


# ---------------- audio analysis ----------------


def test_analyze_reports_levels_and_flags_problems():
    ok = analyze(*speechish())
    assert ok.ok and -40 < ok.rms_db < 0 and ok.silence_pct < 30
    short = analyze(*speechish(seconds=2.0))
    assert short.ok and any("short clip" in w for w in short.warnings)
    quiet = analyze(*speechish(amp=0.07))
    assert quiet.ok and any("quiet" in w for w in quiet.warnings)
    assert not analyze(np.zeros(24000 * 3, np.float32), 24000).ok


def test_stereo_uploads_are_mixed_to_mono(client):
    s, sr = speechish()
    stereo = np.stack([s, s * 0.5], axis=1)
    buf = io.BytesIO()
    sf.write(buf, stereo, sr, format="WAV", subtype="PCM_16")
    pid = make_profile(client)
    assert add_clip(client, pid, data=buf.getvalue()).status_code == 200


# ---------------- any audio file, long recordings, base voice, similarity ----------------


def _encode_with_av(samples, sr, fmt, codec):
    import av

    buf = io.BytesIO()
    with av.open(buf, "w", format=fmt) as c:
        st = c.add_stream(codec, rate=sr)
        st.layout = "mono"
        pcm = (samples * 32767).astype(np.int16)
        for i in range(0, len(pcm), 960):  # small frames: encoders may drop an oversized one
            frame = av.AudioFrame.from_ndarray(pcm[i : i + 960].reshape(1, -1), format="s16", layout="mono")
            frame.sample_rate = sr
            frame.pts = i
            for pkt in st.encode(frame):
                c.mux(pkt)
        for pkt in st.encode(None):
            c.mux(pkt)
    return buf.getvalue()


def test_mp3_uploads_are_accepted(client):
    s, sr = speechish(seconds=6.0, sr=22050)
    buf = io.BytesIO()
    sf.write(buf, s, sr, format="MP3")
    pid = make_profile(client)
    r = add_clip(client, pid, data=buf.getvalue())
    assert r.status_code == 200, r.text
    assert r.json()["clips"][0]["report"]["seconds"] == pytest.approx(6.0, abs=0.3)


@pytest.mark.parametrize("fmt,codec", [("ipod", "aac"), ("webm", "libopus")])
def test_m4a_webm_and_other_formats_are_decoded_through_ffmpeg(client, fmt, codec):
    pytest.importorskip("av")
    s, sr = speechish(seconds=5.0, sr=48000)
    try:
        data = _encode_with_av(s, sr, fmt, codec)
    except Exception as e:  # this ffmpeg build lacks that encoder: nothing to test
        pytest.skip(f"cannot encode {fmt}/{codec}: {e}")
    pid = make_profile(client)
    r = add_clip(client, pid, data=data)
    assert r.status_code == 200, r.text
    assert r.json()["clips"][0]["report"]["seconds"] == pytest.approx(5.0, abs=0.5)


def test_ogg_and_flac_uploads_are_accepted(client):
    s, sr = speechish(seconds=5.0, sr=24000)
    pid = make_profile(client)
    for fmt in ("OGG", "FLAC"):
        buf = io.BytesIO()
        sf.write(buf, s, sr, format=fmt)
        r = add_clip(client, pid, data=buf.getvalue())
        assert r.status_code == 200, (fmt, r.text)


def test_a_long_recording_is_split_at_pauses_into_clips(client):
    sr = 24000
    pieces = []
    for i in range(8):  # eight 12 s "sentences" separated by 0.6 s pauses = about 100 s
        pieces += [speechish(seconds=12.0, sr=sr, seed=i)[0], np.zeros(int(0.6 * sr), np.float32)]
    long = np.concatenate(pieces)
    pid = make_profile(client)
    r = add_clip(client, pid, label="interview", data=wav(long, sr))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["split"] is True and len(body["clips"]) >= 4
    assert all(c["report"]["seconds"] <= 25.5 for c in body["clips"])
    assert all(c["label"].startswith("interview (part ") for c in body["clips"])
    assert sum(c["report"]["seconds"] for c in body["clips"]) == pytest.approx(len(long) / sr, abs=2.0)  # nothing dropped


def test_split_pieces_that_fail_the_checks_are_skipped_not_fatal(client):
    sr = 24000
    long = np.concatenate([speechish(seconds=30.0, sr=sr)[0], np.zeros(40 * sr, np.float32), speechish(seconds=30.0, sr=sr, seed=3)[0]])
    pid = make_profile(client)
    body = add_clip(client, pid, data=wav(long, sr)).json()
    assert body["split"] and body["clips"] and body["skipped"]
    assert any("almost no speech" in e for k in body["skipped"] for e in k["errors"])


def test_a_long_recording_with_no_speech_is_rejected(client):
    pid = make_profile(client)
    r = add_clip(client, pid, data=wav(np.zeros(24000 * 90, np.float32), 24000))
    assert r.status_code == 422 and "no usable speech" in r.json()["error"]


def test_the_base_voice_is_selectable_and_validated(env):
    client, _, engine, _ = env
    assert "EN_INDIA" in client.get("/health").json()["bases"]
    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    r = client.post("/v1/synthesize", json={"profileId": pid, "text": "hi", "base": "EN-AU"}, headers=H)
    assert r.status_code == 200 and engine.renders[-1]["base"] == "EN-AU"
    assert client.post("/v1/synthesize", json={"profileId": pid, "text": "hi"}, headers=H).status_code == 200
    assert engine.renders[-1]["base"] == "EN-US"
    assert client.post("/v1/synthesize", json={"profileId": pid, "text": "hi", "base": "nope"}, headers=H).status_code == 409


def test_build_flags_clips_that_sound_unlike_the_rest(env):
    client, _, engine, _ = env
    engine.clip_similarity = lambda paths: [0.97, 0.96, 0.41]  # the third clip is "someone else"
    pid = make_profile(client)
    for i in range(3):
        add_clip(client, pid, data=wav(*speechish(seed=i)))
    b = client.post(f"/v1/profiles/{pid}/build", headers=H).json()
    assert b["flagged"] == ["clip-001.wav"]  # clips are scored newest-first, so 0.41 belongs to the oldest clip
    assert b["clipsUsed"] == 3  # flagged, never silently dropped
    two = make_profile(client)
    for i in range(2):
        add_clip(client, two, data=wav(*speechish(seed=i)))
    assert "flagged" not in client.post(f"/v1/profiles/{two}/build", headers=H).json()  # too few clips to judge


# ---------------- voices are per engine ----------------


def test_a_voice_built_with_one_engine_is_not_built_for_another(env):
    client, settings, engine, data = env
    from voice_sidecar.store import ProfileStore

    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    store = ProfileStore(data)
    assert store.status(pid, "fake")["built"] is True
    other = store.status(pid, "chatterbox")
    assert other["built"] is False and other["builtWith"] == ["fake"]
    assert store.embedding_path(pid, "fake").name == "embedding-fake.pt"
    assert store.embedding_path(pid, "openvoice-v2").name == "embedding.pth"  # the original filename, so old profiles keep working


def test_build_versions_only_go_up_so_old_cached_audio_can_never_match(client):
    pid = make_profile(client)
    add_clip(client, pid)
    v1 = client.post(f"/v1/profiles/{pid}/build", headers=H).json()["embeddingVersion"]
    add_clip(client, pid)  # invalidates the build
    assert client.get(f"/v1/profiles/{pid}", headers=H).json()["embeddingVersion"] == 0
    v2 = client.post(f"/v1/profiles/{pid}/build", headers=H).json()["embeddingVersion"]
    assert (v1, v2) == (1, 2)


def test_profiles_written_before_engines_were_tracked_still_load_as_openvoice(env):
    client, _, _, data = env
    from voice_sidecar.store import ProfileStore

    pid = make_profile(client)
    meta = data / "profiles" / pid / "meta.json"
    m = json.loads(meta.read_text())
    legacy = {"clips": m["clips"], "embeddingVersion": 3, "built": True, "paused": False, "nextClip": 1}  # the old shape
    meta.write_text(json.dumps(legacy))
    s = ProfileStore(data).status(pid, "openvoice-v2")
    assert s["built"] is True and s["embeddingVersion"] == 3
    assert ProfileStore(data).status(pid, "chatterbox")["built"] is False
    assert ProfileStore(data).mark_built(pid, "openvoice-v2") == 4  # continues from the old counter


def test_engine_options_reach_the_engine_and_are_clamped(env):
    client, _, engine, _ = env
    pid = make_profile(client)
    add_clip(client, pid)
    client.post(f"/v1/profiles/{pid}/build", headers=H)
    client.post("/v1/synthesize", json={"profileId": pid, "text": "hi", "exaggeration": 9, "cfgWeight": -2}, headers=H)
    assert (engine.renders[-1]["exaggeration"], engine.renders[-1]["cfg_weight"]) == (1.5, 0.0)
    assert client.get("/health").json()["capabilities"]["exaggeration"] is True


def test_choose_reference_leads_with_the_cleanest_clip_near_ten_seconds():
    from voice_sidecar.chatterbox_engine import choose_reference

    clips = [
        {"path": "short", "seconds": 3.0, "warnings": ["short clip"], "clipped_pct": 0.0, "rms_db": -22},
        {"path": "noisy", "seconds": 10.0, "warnings": ["quiet", "silence"], "clipped_pct": 0.5, "rms_db": -35},
        {"path": "good", "seconds": 9.0, "warnings": [], "clipped_pct": 0.0, "rms_db": -20},
        {"path": "long", "seconds": 20.0, "warnings": [], "clipped_pct": 0.0, "rms_db": -21},
    ]
    order = choose_reference(clips, first_target=10.0, cap=25.0)
    assert order[0] == "good"
    assert "short" in order or "noisy" in order or "long" in order  # more audio follows for the speaker embedding
    total = {c["path"]: c["seconds"] for c in clips}
    assert sum(total[p] for p in order) >= 25.0 or len(order) == len(clips)
    assert choose_reference(clips[:1])[0] == "short"  # a lone clip is used as is


# ---------------- real engine plumbing (no models loaded) ----------------


def test_openvoice_engine_creates_its_temp_directory_and_names_missing_models(tmp_path):
    from voice_sidecar.engine import EngineError, OpenVoiceEngine

    tmp = tmp_path / "data" / "tmp"
    e = OpenVoiceEngine(tmp_path / "no-weights", tmp_dir=tmp)  # constructing must not need torch or weights
    assert tmp.is_dir()
    with pytest.raises(EngineError, match="fetch_weights"):
        e.load()


# ---------------- CLI ----------------


def test_cli_refuses_to_train_without_consent(tmp_path, capsys):
    p = tmp_path / "a.wav"
    p.write_bytes(wav(*speechish()))
    code = cli_main(["--data", str(tmp_path / "d"), "--engine", "fake", "train", str(p)])
    assert code == 2 and "consent" in capsys.readouterr().err
    assert not (tmp_path / "d" / "profiles").exists() or not any((tmp_path / "d" / "profiles").iterdir())


def test_cli_train_and_say_round_trip(tmp_path, capsys):
    clips = []
    for i in range(2):
        p = tmp_path / f"c{i}.wav"
        p.write_bytes(wav(*speechish(seed=i)))
        clips.append(str(p))
    bad = tmp_path / "bad.wav"
    bad.write_bytes(wav(np.zeros(24000, np.float32), 24000))
    d = str(tmp_path / "d")
    assert cli_main(["--data", d, "--engine", "fake", "train", "--i-am-the-voice-owner", *clips, str(bad)]) == 0
    out = capsys.readouterr().out
    assert "rejected bad.wav" in out and "built in" in out
    pid = out.split("profile ")[1].split()[0]
    out_wav = tmp_path / "x.wav"
    assert cli_main(["--data", d, "--engine", "fake", "say", pid, "Hello", "-o", str(out_wav)]) == 0
    assert out_wav.read_bytes()[:4] == b"RIFF"
    assert cli_main(["--data", d, "--engine", "fake", "delete", pid, "--yes"]) == 0
    assert cli_main(["--data", d, "--engine", "fake", "say", pid, "Hello", "-o", str(out_wav)]) == 1
