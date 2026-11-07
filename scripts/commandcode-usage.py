#!/usr/bin/env python3
"""Read Command Code plan usage out of Bifrost's own request log.

Why this exists: the Command Code usage endpoint needs a Command Code API key,
and only the Bifrost gateway may hold one. Bifrost already fetches that endpoint
for the dedicated `commandcode-billing` provider block (its `list_models` path
override points at the billing URL), and it stores the response body in its log
database. This script copies the numbers out of that log. It never sees a key
and never calls the provider itself.

The log reading, refresh poke and last-good-row fallback live in
`bifrost_usage.py`, shared with the OpenCode Go helper; this file owns the
Command Code payload shape.

Prints one JSON object on stdout:

    {"windows": {"5h": {...}, "week": {...}, "month": {...}},
     "fetchedAt": "<ISO>", "rowTimestamp": "<UTC text>", "refreshed": true|false}

Window rows are `{status, percent, used?, cap?, resetsAt?}` where percent is how
much of the cap is used and used/cap are the vendor's raw credit figures (the
adapter reads the caps to identify the plan's monthly credit pool). Exits
non-zero with a message on stderr when it cannot produce a row.
"""

import argparse
import json
import sys
from datetime import datetime, timezone

import bifrost_usage as bifrost

DEFAULT_PROVIDER = "commandcode-billing"

# The billing payload is the object carrying the window caps and the credit
# balance; Bifrost wraps it in a one-element array in the captured body.
PAYLOAD_MARKERS = ("windowLimits", "credits")


def iso_from_ms(value):
    try:
        ms = int(float(value))
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z") if ms > 0 else None


def percent_of(used, cap):
    try:
        used_f, cap_f = float(used), float(cap)
    except (TypeError, ValueError):
        return None
    if cap_f <= 0:
        return None
    return min(100.0, max(0.0, round(used_f / cap_f * 100)))


def normalize(payload):
    """Billing payload -> widget windows, matching dsh-spend's adapter contract."""
    windows = {}
    limits = payload.get("windowLimits") or {}
    for field, key in (("fiveHour", "5h"), ("weekly", "week")):
        row = limits.get(field) or {}
        pct = percent_of(row.get("used"), row.get("cap"))
        if pct is None:
            continue
        entry = {"status": "ok", "percent": pct}
        try:
            entry["used"] = float(row.get("used"))
            entry["cap"] = float(row.get("cap"))
        except (TypeError, ValueError):
            pass
        resets = iso_from_ms(row.get("resetAt"))
        if resets:
            entry["resetsAt"] = resets
        windows[key] = entry
    credits = payload.get("credits") or {}
    try:
        remaining = float(credits.get("monthlyCredits"))
        purchased = float(credits.get("purchasedCredits") or 0)
        free = float(credits.get("freeCredits") or 0)
    except (TypeError, ValueError):
        remaining = None
    return {"windows": windows, "monthlyCredits": remaining, "purchasedCredits": purchased if remaining is not None else None,
            "freeCredits": free if remaining is not None else None}


def main():
    parser = bifrost.add_arguments(argparse.ArgumentParser(description=__doc__.splitlines()[0]))
    parser.add_argument("--provider", default=DEFAULT_PROVIDER, help="provider block that fetched the usage")
    args = parser.parse_args()
    try:
        captured = bifrost.capture(args, args.provider, PAYLOAD_MARKERS)
    except bifrost.CaptureError as error:
        print(str(error), file=sys.stderr)
        return 1
    result = normalize(captured["payload"])
    if not result["windows"]:
        print(f"row {captured['rowTimestamp']} status={captured['rowStatus']} has no usable windows", file=sys.stderr)
        return 1
    result.update({
        "fetchedAt": captured["fetchedAt"],
        "rowTimestamp": captured["rowTimestamp"],
        "rowStatus": captured["rowStatus"],
        "refreshed": captured["refreshed"],
    })
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
