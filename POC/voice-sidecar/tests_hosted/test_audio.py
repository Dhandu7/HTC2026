"""audio.py: decoding any common format, judging clip quality, and splitting long recordings at pauses.
These rules decide which of a user's recordings are sent to ElevenLabs, so they are tested directly."""

import io

import numpy as np
import pytest
import soundfile as sf

from voice_sidecar.audio import AudioError, analyze, load_audio, split_at_pauses, wav_bytes


def speechish(seconds=4.0, sr=24000, amp=0.3, seed=0):
    """Noise with a 4 Hz syllable-like envelope: loud enough and mostly 'voiced'."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    env = 0.55 + 0.45 * np.sin(2 * np.pi * 4 * t)
    return (amp * env * rng.standard_normal(len(t)) * 0.5).clip(-0.95, 0.95).astype(np.float32), sr


# ---------------- quality rules ----------------


def test_a_healthy_clip_passes_with_sensible_levels():
    r = analyze(*speechish())
    assert r.ok and -40 < r.rms_db < 0 and r.silence_pct < 30 and r.errors == []


def test_short_and_quiet_clips_pass_with_warnings():
    short = analyze(*speechish(seconds=2.0))
    assert short.ok and any("short clip" in w for w in short.warnings)
    quiet = analyze(*speechish(amp=0.07))
    assert quiet.ok and any("quiet" in w for w in quiet.warnings)


@pytest.mark.parametrize(
    "make,expect",
    [
        (lambda: speechish(seconds=0.5), "too short"),
        (lambda: (np.zeros(24000 * 3, np.float32), 24000), "almost no speech"),
        (lambda: speechish(amp=0.02), "quiet"),
        (lambda: (np.clip(speechish(amp=6.0)[0] * 40, -1, 1).astype(np.float32), 24000), "clipping"),
        (lambda: speechish(seconds=61.0), "too long"),
    ],
)
def test_unusable_clips_are_rejected_with_a_reason(make, expect):
    r = analyze(*make())
    assert not r.ok and any(expect in e for e in r.errors), r.errors


# ---------------- decoding ----------------


def test_wav_mp3_ogg_and_flac_decode_to_the_right_length():
    s, sr = speechish(seconds=5.0, sr=24000)
    for fmt in ("WAV", "MP3", "OGG", "FLAC"):
        buf = io.BytesIO()
        sf.write(buf, s, sr, format=fmt)
        y, got_sr = load_audio(buf.getvalue())
        assert len(y) / got_sr == pytest.approx(5.0, abs=0.3), fmt


def test_stereo_is_mixed_to_mono():
    s, sr = speechish()
    buf = io.BytesIO()
    sf.write(buf, np.stack([s, s * 0.5], axis=1), sr, format="WAV", subtype="PCM_16")
    y, _ = load_audio(buf.getvalue())
    assert y.ndim == 1 and len(y) == len(s)


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


@pytest.mark.parametrize("fmt,codec", [("ipod", "aac"), ("webm", "libopus")])
def test_m4a_and_webm_decode_through_ffmpeg(fmt, codec):
    s, sr = speechish(seconds=5.0, sr=48000)
    try:
        data = _encode_with_av(s, sr, fmt, codec)
    except Exception as e:  # this ffmpeg build lacks that encoder: nothing to test
        pytest.skip(f"cannot encode {fmt}/{codec}: {e}")
    y, got_sr = load_audio(data)
    assert len(y) / got_sr == pytest.approx(5.0, abs=0.5)


@pytest.mark.parametrize("junk", [b"", b"not audio at all", b"RIFF" + b"\x00" * 20])
def test_things_that_are_not_audio_are_refused_cleanly(junk):
    with pytest.raises(AudioError):
        load_audio(junk)


# ---------------- splitting ----------------


def test_a_short_recording_is_one_piece():
    s, _ = speechish(seconds=20.0)
    assert len(split_at_pauses(s, 24000)) == 1


def test_a_long_recording_is_cut_at_pauses_and_nothing_is_lost():
    sr = 24000
    parts = []
    for i in range(8):  # eight 12 s "sentences" separated by 0.6 s pauses
        parts += [speechish(seconds=12.0, sr=sr, seed=i)[0], np.zeros(int(0.6 * sr), np.float32)]
    long = np.concatenate(parts)
    pieces = split_at_pauses(long, sr)
    assert len(pieces) >= 4 and all(len(p) / sr <= 25.5 for p in pieces)
    assert sum(len(p) for p in pieces) == len(long)  # every sample is in exactly one piece
    # every cut lands in (or right at the edge of) a pause, never in the middle of a sentence
    cuts = np.cumsum([len(p) for p in pieces])[:-1] / sr
    pauses = [(k * 12.6 + 12.0, k * 12.6 + 12.6) for k in range(8)]
    assert all(any(a - 0.15 <= c <= b + 0.15 for a, b in pauses) for c in cuts), cuts


def test_wav_bytes_round_trips():
    s, sr = speechish(seconds=2.0)
    y, got = load_audio(wav_bytes(s, sr))
    assert got == sr and len(y) == len(s) and np.abs(y - s).max() < 1e-3


# ---------------- reading only as much as needed ----------------


def test_only_the_first_part_of_a_long_file_is_decoded_in_every_format():
    s, sr = speechish(seconds=10.0, sr=24000)
    for fmt in ("WAV", "MP3", "OGG", "FLAC"):
        buf = io.BytesIO()
        sf.write(buf, s, sr, format=fmt)
        y, got_sr = load_audio(buf.getvalue(), max_seconds=3.0)
        assert len(y) / got_sr == pytest.approx(3.0, abs=0.15), fmt
    y, got_sr = load_audio(wav_bytes(s, sr))  # the default is generous: a normal file is read whole
    assert len(y) / got_sr == pytest.approx(10.0, abs=0.01)


@pytest.mark.parametrize("fmt,codec", [("ipod", "aac"), ("webm", "libopus")])
def test_the_ffmpeg_path_also_stops_early(fmt, codec):
    s, sr = speechish(seconds=8.0, sr=48000)
    try:
        data = _encode_with_av(s, sr, fmt, codec)
    except Exception as e:
        pytest.skip(f"cannot encode {fmt}/{codec}: {e}")
    y, got_sr = load_audio(data, max_seconds=2.0)
    assert len(y) / got_sr == pytest.approx(2.0, abs=0.2)


@pytest.mark.parametrize("data", [b"%PDF-1.4\n\x00\x01\x02", b"just some text, not audio at all", bytes(range(256)) * 4])
def test_a_file_that_is_not_audio_gets_a_plain_message_without_decoder_noise(data):
    with pytest.raises(AudioError) as e:
        load_audio(data)
    msg = str(e.value)
    assert "does not look like audio" in msg
    assert "Errno" not in msg and "<none>" not in msg
