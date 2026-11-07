#!/usr/bin/env python3
"""Read a vendor's usage payload out of Bifrost's own request log.

Why this exists: usage and billing endpoints need the vendor's API key, and
only the Bifrost gateway may hold one. Bifrost fetches such an endpoint for a
dedicated provider block whose `list_models` path override points at the usage
URL, and it stores the response body in its log database. This module copies
the newest usable body out of that log. It never sees a key and never calls the
vendor itself.

A refresh that fails (Bifrost's own 504 timeout, a cancelled fetch) still
commits a row, just without a body, so the newest row is not always usable: the
newest row that carries a payload wins, and the card keeps showing the last
good numbers while the vendor's route is flaky.

Two blocks use this today — `commandcode-billing` and `opencode-go-billing` —
each through its own thin CLI (`commandcode-usage.py`,
`opencode-go-usage.py`), because the payload shapes differ and the adapter
owns its vendor's normalization.
"""

import json
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = "~/.config/bifrost/logs.db"
DEFAULT_GATEWAY = "http://127.0.0.1:8090"


class CaptureError(RuntimeError):
    """No usable payload row could be produced; the message is user-facing."""


def add_arguments(parser):
    """Add the flags every usage CLI shares."""
    parser.add_argument("--db", default=DEFAULT_DB, help="Bifrost log database (read-only)")
    parser.add_argument("--gateway", default=DEFAULT_GATEWAY, help="Bifrost base URL, for the refresh poke")
    parser.add_argument("--stale-seconds", type=int, default=300,
                        help="skip the refresh poke when the newest payload row is younger than this")
    parser.add_argument("--timeout", type=float, default=20.0, help="refresh poke timeout")
    return parser


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
    """Make Bifrost refresh provider model lists, which fires the usage fetch.

    Keyless on purpose: this is a plain loopback GET, no credential involved.
    """
    url = base_url.rstrip("/") + "/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            response.read(1024)
    except Exception as error:  # the poke is best effort; the row may be fresh enough
        print(f"refresh poke failed: {error}", file=sys.stderr)


def payload_from_body(body, markers):
    """Extract the usage payload from a captured response body.

    Bifrost stores the body as JSON. It can be the object itself, a one-element
    array, or an array of string chunks, depending on the capture path. A
    payload is the first object carrying one of the vendor `markers`.
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
            if any(marker in node for marker in markers):
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


def newest_payload_row(rows, markers):
    """Newest row that carries a payload, as `(row, payload)`.

    A failed refresh still writes a row, but with no body (Bifrost's own 504
    timeout, or a cancelled fetch), so the newest row is not necessarily the
    newest usable one. Falling back to the last good row keeps the card showing
    real numbers while the vendor's route is flaky.
    """
    for row in rows:
        payload = payload_from_body(row[2], markers)
        if payload is not None:
            return row, payload
    return None, None


def newest_payload_after(db_path, provider, markers, previous_timestamp, attempts=12, delay=0.25):
    """Wait briefly for Bifrost to commit a payload row newer than the shown one."""
    for _ in range(attempts):
        row, payload = newest_payload_row(recent_rows(db_path, provider), markers)
        if payload is not None and (previous_timestamp is None or row[0] != previous_timestamp):
            return row, payload
        time.sleep(delay)
    return newest_payload_row(recent_rows(db_path, provider), markers)


def capture(args, provider, markers):
    """Newest usable payload for one provider block, refreshing through Bifrost.

    Resolves to `{payload, rowTimestamp, rowStatus, refreshed}`; raises
    CaptureError with a user-facing message when no recent row carries a
    payload.
    """
    db_path = str(Path(args.db).expanduser())
    row, payload = newest_payload_row(recent_rows(db_path, provider), markers)
    age = row_age_seconds(row[0]) if row is not None else None
    refreshed = False
    if payload is None or age is None or age > args.stale_seconds:
        previous = row[0] if row is not None else None
        poke_gateway(args.gateway, args.timeout)
        refreshed = True
        row, payload = newest_payload_after(db_path, provider, markers, previous)
    if payload is None:
        newest = newest_row(db_path, provider)
        if newest is None:
            raise CaptureError(
                f"no '{provider}' row in {db_path}; is the Bifrost provider block configured and Bifrost running?")
        raise CaptureError(
            f"rows for '{provider}' hold no usage payload (newest {newest[0]} status={newest[1]}); "
            "capture disabled, body trimmed, or every recent usage fetch failed")
    return {
        "payload": payload,
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "rowTimestamp": row[0],
        "rowStatus": row[1],
        "refreshed": refreshed,
    }
