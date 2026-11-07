"""`./hosted.sh doctor`: is the ElevenLabs key accepted, and does the plan allow what we need?

Prints a plain report and advice. It reads the account's plan and voice-slot usage (one read-only request) and never
prints the key. A restricted key that can speak but cannot read account details is reported as such, not as broken.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

from .elevenlabs import DEFAULT_BASE_URL, ElevenLabsClient, ElevenLabsError, key_shape_warning


def diagnose(client: ElevenLabsClient) -> "tuple[list[str], bool]":
    """Returns (report lines, everything needed looks fine)."""
    lines: "list[str]" = []
    try:
        sub = client.subscription()
    except ElevenLabsError as e:
        if e.status == 502 and "refused" in str(e):
            lines += [
                "Key: REFUSED by ElevenLabs when reading the account.",
                "  Either the key is wrong or revoked, or it is a restricted key without permission to read account details.",
                "  A restricted key can still work for voices and speech. If you restricted it, allow reading the user/subscription,",
                "  or use `./hosted.sh smoke` to test cloning directly. Otherwise create a new key and run `./hosted.sh key-set`.",
            ]
        else:
            lines += [f"Could not read the account: {e}"]
        return lines, False

    ok = True
    tier, status = sub.get("tier"), sub.get("status")
    lines.append(f"Key: accepted. Plan: {tier or 'unknown'} (status: {status or 'unknown'}).")
    if status in ("past_due", "free_disabled", "incomplete"):
        lines.append(f"  The subscription status is '{status}': check billing in the ElevenLabs dashboard.")
        ok = False
    can = sub.get("can_use_instant_voice_cloning")
    if can is True:
        lines.append("Instant voice cloning: allowed.")
    elif can is False:
        lines.append("Instant voice cloning: NOT allowed on this plan. Cloning needs at least the Starter plan.")
        ok = False
    else:
        lines.append("Instant voice cloning: unknown (ElevenLabs did not say).")
    used, limit = sub.get("voice_slots_used"), sub.get("voice_limit")
    if isinstance(used, int) and isinstance(limit, int):
        free = limit - used
        lines.append(f"Voice slots: {used} of {limit} used, {free} free.")
        if free <= 0:
            lines.append("  No free slot: delete an old voice in the ElevenLabs dashboard (Voices), or upgrade the plan.")
            ok = False
        lines.append(f"  Our service's own cap is VOICE_SLOT_LIMIT (default 10): set it to {limit} or less to match this plan.")
    cc, cl = sub.get("character_count"), sub.get("character_limit")
    if isinstance(cc, int) and isinstance(cl, int):
        lines.append(f"Characters this period: {cc:,} of {cl:,} used.")
        if cc >= cl:
            lines.append("  Out of characters: speech will fail until the period resets or the plan is upgraded.")
            ok = False
    lines.append("Result: " + ("everything needed looks fine." if ok else "something above needs fixing before voices can be created."))
    return lines, ok


def main(argv: Optional[list] = None) -> int:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        print("No key found. Run `./hosted.sh key-set` first (or set ELEVENLABS_API_KEY).", file=sys.stderr)
        return 2
    warn = key_shape_warning(key)
    if warn:
        print(f"Warning: {warn}\n")
    client = ElevenLabsClient(key, os.environ.get("ELEVENLABS_BASE_URL", DEFAULT_BASE_URL))
    lines, ok = diagnose(client)
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
