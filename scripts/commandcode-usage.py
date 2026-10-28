#!/usr/bin/env python3
"""Read Command Code plan usage out of Bifrost's own request log.

Why this exists: the Command Code usage endpoint needs a Command Code API key,
and only the Bifrost gateway may hold one. Bifrost already fetches that endpoint
for the dedicated `commandcode-billing` provider block (its `list_models` path
override points at the billing URL), and it stores the response body in its log
database. This script copies the numbers out of that log. It never sees a key
and never calls the provider itself.

A refresh that fails (Bifrost's own 504 timeout, a cancelled fetch) still
commits a row, just without a body, so the newest row is not always usable:
the newest row that carries a payload wins, and the card keeps showing the last
good numbers while the vendor's route is flaky.

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
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = "~/.config/bifrost/logs.db"
DEFAULT_PROVIDER = "commandcode-billing"
DEFAULT_GATEWAY = "http://127.0.0.1:8090"


def parse_args():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", default=DEFAULT_DB, help="Bifrost log database (read-only)")
    p.add_argument("--provider", default=DEFAULT_PROVIDER, help="provider block that fetched the usage")
    p.add_argument("--gateway", default=DEFAULT_GATEWAY, help="Bifrost base URL, for the refresh poke")
    p.add_argument("--stale-seconds", type=int, default=300,
                   help="skip the refresh poke when the newest payload row is younger than this")
    p.add_argument("--timeout", type=float, default=20.0, help="refresh poke timeout")
    return p.parse_args()


def recent_rows(db_path, provider, limit=40):
    """Newest (timestamp, status, body) rows for one provider, newest first."""
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    try:
        cur = conn.execute(
            "select timestamp, status, raw_response from logs "
            "where provider = ? order by timestamp desc limit ?",
            (provider, limit),
        )
        return cur.fetchall()
    finally:
        conn.close()


def newest_row(db_path, provider):
    """Newest (timestamp, status, body) for one provider, or None."""
    rows = recent_rows(db_path, provider, 1)
    return rows[0] if rows else None


def row_age_seconds(timestamp_text):
    """Age of a log row in seconds, or None when the text is unparseable."""
    text = (timestamp_text or "")[:26]
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            then = datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
            return (datetime.now(timezone.utc) - then).total_seconds()
        except ValueError:
            continue
    return None


def poke_gateway(base_url, timeout):
    """Make Bifrost refresh provider model lists, which fires the billing fetch.

    Keyless on purpose: this is a plain loopback GET, no credential involved.
    """
    url = base_url.rstrip("/") + "/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            response.read(1024)
    except Exception as error:  # the poke is best effort; the row may be fresh enough
        print(f"refresh poke failed: {error}", file=sys.stderr)


def payload_from_body(body):
    """Extract the billing payload from a captured response body.

    Bifrost stores the body as JSON. It can be the object itself, a one-element
    array, or an array of string chunks, depending on the capture path.
    """
    if not body:
        return None
    try:
        parsed = json.loads(body)
    except (TypeError, ValueError):
        return None
    stack = [parsed]
    while stack:
        node = stack.pop(0)
        if isinstance(node, dict):
            if "windowLimits" in node or "credits" in node:
                return node
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
        elif isinstance(node, str):
            try:
                stack.append(json.loads(node))
            except ValueError:
                continue
    return None


def newest_payload_row(rows):
    """Newest row that carries a billing payload, as `(row, payload)`.

    A failed refresh still writes a row, but with no body (Bifrost's own 504
    timeout, or a cancelled fetch), so the newest row is not necessarily the
    newest usable one. Falling back to the last good row keeps the card showing
    real numbers while the vendor's route is flaky.
    """
    for row in rows:
        payload = payload_from_body(row[2])
        if payload is not None:
            return row, payload
    return None, None


def newest_payload_after(db_path, provider, previous_timestamp, attempts=12, delay=0.25):
    """Wait briefly for Bifrost to commit a payload row newer than the shown one."""
    for _ in range(attempts):
        row, payload = newest_payload_row(recent_rows(db_path, provider))
        if payload is not None and (previous_timestamp is None or row[0] != previous_timestamp):
            return row, payload
        time.sleep(delay)
    return newest_payload_row(recent_rows(db_path, provider))


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
    args = parse_args()
    db_path = str(Path(args.db).expanduser())
    row, payload = newest_payload_row(recent_rows(db_path, args.provider))
    age = row_age_seconds(row[0]) if row is not None else None
    refreshed = False
    if payload is None or age is None or age > args.stale_seconds:
        previous = row[0] if row is not None else None
        poke_gateway(args.gateway, args.timeout)
        refreshed = True
        row, payload = newest_payload_after(db_path, args.provider, previous)
    if payload is None:
        newest = newest_row(db_path, args.provider)
        if newest is None:
            print(f"no '{args.provider}' row in {db_path}; is the Bifrost provider block configured and Bifrost running?",
                  file=sys.stderr)
        else:
            print(f"rows for '{args.provider}' hold no usage payload (newest {newest[0]} status={newest[1]}); "
                  "capture disabled, body trimmed, or every recent billing fetch failed", file=sys.stderr)
        return 1
    timestamp, status = row[0], row[1]
    result = normalize(payload)
    if not result["windows"]:
        print(f"row {timestamp} status={status} has no usable windows", file=sys.stderr)
        return 1
    result.update({
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "rowTimestamp": timestamp,
        "rowStatus": status,
        "refreshed": refreshed,
    })
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
