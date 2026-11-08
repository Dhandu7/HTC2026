"""hosted.sh decides where the ElevenLabs key comes from. These tests use placeholder values and a stand-in for
Python that just prints the key it was given, so they can check what was loaded without ever involving a real key."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parent.parent
SCRIPT = SIDECAR / "hosted.sh"


@pytest.fixture
def box(tmp_path):
    echo = tmp_path / "fakepython"
    echo.write_text('#!/bin/sh\nprintf "%s" "${ELEVENLABS_API_KEY-<unset>}"\n')
    echo.chmod(echo.stat().st_mode | stat.S_IEXEC)
    sec = tmp_path / "bin" / "security"
    sec.parent.mkdir()
    sec.write_text(
        '#!/bin/sh\n[ -f "$FAKE_KEYCHAIN" ] || exit 44\ncase "$1" in\n'
        '  find-generic-password) case " $* " in *" -w "*) cat "$FAKE_KEYCHAIN";; esac;;\nesac\n'
    )
    sec.chmod(sec.stat().st_mode | stat.S_IEXEC)
    return tmp_path


def run(box, cmd="smoke", env_file_text=None, extra_env=None, keychain=None, secrets_dir=True):
    envf = box / "test.env"
    if env_file_text is not None:
        envf.write_text(env_file_text)
    kc = box / "keychain"
    if keychain is not None:
        kc.write_text(keychain)
    env = {
        "PATH": f"{box / 'bin'}:/usr/bin:/bin",
        "HOME": str(box),
        "USER": "tester",
        "VOICE_ENV_FILE": str(envf),
        "VOICE_PY": str(box / "fakepython"),
        "FAKE_KEYCHAIN": str(kc),
        **(extra_env or {}),
    }
    r = subprocess.run(["bash", str(SCRIPT), cmd], cwd=SIDECAR, env=env, capture_output=True, text=True, timeout=30)
    return r


def loaded(box, text, **kw):
    """The key hosted.sh would hand to a command, given this .env content."""
    return run(box, "smoke", env_file_text=text, **kw).stdout


@pytest.mark.parametrize(
    "line,expected",
    [
        ("ELEVENLABS_API_KEY=sk_test_PLAIN", "sk_test_PLAIN"),
        ('ELEVENLABS_API_KEY="sk_test_DOUBLE"', "sk_test_DOUBLE"),
        ("ELEVENLABS_API_KEY='sk_test_SINGLE'", "sk_test_SINGLE"),
        ("export ELEVENLABS_API_KEY=sk_test_EXPORT", "sk_test_EXPORT"),
        ("  ELEVENLABS_API_KEY = sk_test_SPACED   # my key", "sk_test_SPACED"),
        ("# a comment\n\nOTHER=1\nELEVENLABS_API_KEY=sk_test_AFTER_OTHERS", "sk_test_AFTER_OTHERS"),
        ("ELEVENLABS_API_KEY=sk_first\nELEVENLABS_API_KEY=sk_second", "sk_first"),
    ],
)
def test_the_key_is_read_from_the_env_file_in_the_usual_formats(box, line, expected):
    assert loaded(box, line + "\n") == expected


@pytest.mark.parametrize("text", ["", "ELEVENLABS_API_KEY=\n", 'ELEVENLABS_API_KEY=""\n', "# ELEVENLABS_API_KEY=sk_commented_out\n", "OTHER=1\n"])
def test_an_empty_or_commented_out_key_counts_as_not_set(box, text):
    assert loaded(box, text) == "<unset>"


def test_the_env_file_is_read_as_text_and_never_run(box):
    text = f"ELEVENLABS_API_KEY=sk_x\n$(touch {box}/RAN_ONE)\n`touch {box}/RAN_TWO`; touch {box}/RAN_THREE\n"
    assert loaded(box, text) == "sk_x"
    assert not list(box.glob("RAN_*"))


def test_an_explicit_environment_variable_beats_the_file(box):
    assert loaded(box, "ELEVENLABS_API_KEY=from_file\n", extra_env={"ELEVENLABS_API_KEY": "from_env"}) == "from_env"


def test_when_secrets_manager_is_in_use_the_file_is_ignored(box):
    assert loaded(box, "ELEVENLABS_API_KEY=from_file\n", extra_env={"ELEVENLABS_SECRET_ID": "arn:aws:secretsmanager:x"}) == "<unset>"


def test_the_file_wins_over_the_keychain_and_the_keychain_is_the_fallback(box):
    assert loaded(box, "ELEVENLABS_API_KEY=from_file\n", keychain="from_keychain") == "from_file"
    assert loaded(box, "ELEVENLABS_API_KEY=\n", keychain="from_keychain") == "from_keychain"


def test_key_check_says_where_the_key_is_and_never_shows_it(box):
    r = run(box, "key-check", env_file_text="ELEVENLABS_API_KEY=sk_test_SECRET_VALUE\n")
    assert r.returncode == 0 and "found in" in r.stdout and "SECRET_VALUE" not in r.stdout + r.stderr
    r = run(box, "key-check", env_file_text="ELEVENLABS_API_KEY=\n", keychain="kc_SECRET")
    assert r.returncode == 0 and "Keychain" in r.stdout and "kc_SECRET" not in r.stdout + r.stderr
    (box / "keychain").unlink()  # nothing in the Keychain any more
    r = run(box, "key-check", env_file_text="ELEVENLABS_API_KEY=\n")
    assert r.returncode == 1 and "not found" in r.stdout


def test_a_missing_env_file_is_fine(box):
    r = run(box, "smoke", extra_env={"VOICE_ENV_FILE": str(box / "does-not-exist.env")})
    assert r.returncode == 0 and r.stdout == "<unset>"


def test_the_real_env_files_are_set_up_safely():
    """The .env example holds no key, and a real .env (if present) is ignored by git."""
    example = (SIDECAR.parent / ".env.example").read_text()
    assert "ELEVENLABS_API_KEY=\n" in example
    assert not any(l.split("=", 1)[1].strip() for l in example.splitlines() if l.startswith("ELEVENLABS_API_KEY="))
    r = subprocess.run(["git", "check-ignore", "-q", ".env"], cwd=SIDECAR.parent)
    assert r.returncode == 0, ".env must be ignored by git"
    r = subprocess.run(["git", "check-ignore", "-q", ".env.example"], cwd=SIDECAR.parent)
    assert r.returncode == 1, ".env.example must stay trackable"
    real = SIDECAR.parent / ".env"
    if real.exists():
        assert stat.S_IMODE(real.stat().st_mode) & 0o077 == 0, ".env must not be readable by other users"


def test_key_check_warns_when_the_stored_value_is_not_a_key_and_never_shows_it(box):
    r = run(box, "key-check", env_file_text="ELEVENLABS_API_KEY=abc123_THE_KEY_ID\n")
    out = r.stdout + r.stderr
    assert r.returncode == 0 and "does not start with sk_" in out and "THE_KEY_ID" not in out
    r = run(box, "key-check", env_file_text="ELEVENLABS_API_KEY=sk_looks_right\n")
    assert "does not start with sk_" not in r.stdout and "looks_right" not in r.stdout
    r = run(box, "key-check", env_file_text="ELEVENLABS_API_KEY=\n", keychain="idonly_KC_VALUE")
    assert "does not start with sk_" in r.stdout and "KC_VALUE" not in r.stdout + r.stderr and "the Keychain" in r.stdout


def test_local_refuses_to_start_without_a_key_and_says_what_to_do(box):
    r = run(box, "local", env_file_text="OTHER=1\n")
    assert r.returncode == 1 and "VisualEyes/.env" in r.stderr


def test_local_serves_with_the_key_from_the_env_file_and_safe_local_defaults(box):
    echo = box / "fakepython"
    echo.write_text('#!/bin/sh\nprintf "%s|%s|%s|%s" "$ELEVENLABS_API_KEY" "$VOICE_STORE" "$AUTH_MODE" "$CORS_ORIGINS"\n')
    r = run(box, "local", env_file_text="ELEVENLABS_API_KEY=sk_test_LOCAL\n")
    assert r.returncode == 0
    assert r.stdout.splitlines()[-1] == "sk_test_LOCAL|memory|accounts|http://localhost:5173,http://127.0.0.1:5173"
    assert "SECRET" not in r.stdout + r.stderr


def test_local_lets_the_caller_override_the_defaults(box):
    echo = box / "fakepython"
    echo.write_text('#!/bin/sh\nprintf "%s|%s" "$VOICE_STORE" "$CORS_ORIGINS"\n')
    r = run(box, "local", env_file_text="ELEVENLABS_API_KEY=sk_x\n", extra_env={"VOICE_STORE": "dynamodb", "CORS_ORIGINS": "http://example.test"})
    assert r.stdout.splitlines()[-1] == "dynamodb|http://example.test"


def test_local_sets_up_python_first_even_when_started_by_a_relative_path(box):
    """Regression: `bash voice-sidecar/hosted.sh local` on a fresh machine re-ran itself by that relative path after
    changing directory, and failed with 'No such file or directory'."""
    log = box / "uv.log"
    uv = box / "bin" / "uv"
    uv.write_text(f'#!/bin/sh\necho "uv $*" >> {log}\n')
    uv.chmod(uv.stat().st_mode | stat.S_IEXEC)
    env = {
        "PATH": f"{box / 'bin'}:/usr/bin:/bin",
        "HOME": str(box),
        "USER": "tester",
        "VOICE_ENV_FILE": str(box / "test.env"),
        "VOICE_PY": str(box / "python-not-installed-yet"),  # not executable: forces the setup step
    }
    (box / "test.env").write_text("ELEVENLABS_API_KEY=sk_test_FRESH\n")
    r = subprocess.run(["bash", "voice-sidecar/hosted.sh", "local"], cwd=SIDECAR.parent, env=env, capture_output=True, text=True, timeout=30)
    assert "No such file or directory" not in r.stdout + r.stderr or "python-not-installed-yet" in r.stderr
    assert "hosted.sh: No such file" not in r.stderr
    assert "pip install" in log.read_text(), "setup (uv pip install) should have run"
