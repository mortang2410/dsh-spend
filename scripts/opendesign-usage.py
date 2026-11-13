#!/usr/bin/env python3
"""Read OpenDesign's plan allowances from the account control plane.

Why this exists: an OpenDesign inference key (`sk-amr-…`) cannot see quota —
every usage path answers 404 for it — and live completions carry no allowance
headers. The allowance numbers live on the *account control plane*
(`amr-api.open-design.ai`) behind a different credential, a `vela_ctrl_…`
control key, which is issued by approving a CLI sign-in
(`POST /api/v1/cli/device-authorizations`, then polling the token route). The
tool that mints that key is `od-login` on this host; it stores the key at
`~/.config/opendesign/control-key` with owner-only permissions.

This script holds no key of its own and writes none: it reads that file, asks
the control plane for the current workspace, then reads
`billing/preflight`, which reports each allowance window with its limit, used
and remaining credits and the instant the window resets.

Prints one JSON object on stdout:

    {"windows": {"5h": {...}, "week": {...}},
     "workspace": "<id>", "plan": "<name>", "fetchedAt": "<ISO>"}

Window rows are `{status, percent, used, limit, remaining, resetsAt}` with
credits in the vendor's own unit. The duration labels come from
`durationSeconds` (18000 → 5h, 604800 → week); an unknown duration is skipped
rather than guessed. Exits non-zero with one message on stderr when the key is
missing or the control plane refuses.

`--base` and `--key-file` exist so the tests can drive a local stub instead of
the vendor, and so a workspace that hides its keys can move the file.
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_BASE = "https://amr-api.open-design.ai/api/v1"
DEFAULT_KEY_FILE = "~/.config/opendesign/control-key"
USER_AGENT = "dsh-spend/opendesign-usage"

# Window length in seconds -> the label dsh-spend's plan rows use.
WINDOW_LABELS = {18_000: "5h", 604_800: "week"}


def iso_now():
    return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")


def read_key(path):
    """Return the control key, or None when the file is absent or empty."""
    file = pathlib.Path(os.path.expanduser(path))
    if not file.exists():
        return None
    key = file.read_text().strip()
    return key or None


def call(base, route, key):
    """GET one control-plane route; returns (status, decoded body)."""
    request = urllib.request.Request(
        base.rstrip("/") + route,
        headers={
            "accept": "application/json",
            "user-agent": USER_AGENT,
            "authorization": "Bearer " + key,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = response.read()
            try:
                return response.status, json.loads(payload or b"{}")
            except ValueError:
                return response.status, {}
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read() or b"{}")
        except ValueError:
            body = {}
        return error.code, body


def number(value):
    """Credits arrive as numbers or numeric strings; anything else is absent."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def window_row(raw):
    """Normalize one vendor window row, or None when it is not usable."""
    duration = raw.get("durationSeconds")
    try:
        label = WINDOW_LABELS.get(int(duration))
    except (TypeError, ValueError):
        label = None
    limit = number(raw.get("limitCredits"))
    used = number(raw.get("usedCredits"))
    remaining = number(raw.get("remainingCredits"))
    if label is None or limit is None or used is None or limit <= 0:
        return None
    row = {
        "status": "ok",
        "percent": min(100.0, max(0.0, round(used / limit * 100, 1))),
        "used": used,
        "limit": limit,
        "remaining": remaining if remaining is not None else max(0.0, limit - used),
    }
    resets = raw.get("resetsAt")
    if isinstance(resets, str) and resets:
        row["resetsAt"] = resets
    return label, row


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read OpenDesign plan allowances.")
    parser.add_argument("--base", default=os.environ.get("OPENDESIGN_CONSOLE_BASE", DEFAULT_BASE))
    parser.add_argument("--key-file", default=os.environ.get("OPENDESIGN_CONTROL_KEY_FILE", DEFAULT_KEY_FILE))
    parser.add_argument("--workspace", default=os.environ.get("OPENDESIGN_WORKSPACE_ID", ""))
    args = parser.parse_args(argv)

    key = read_key(args.key_file)
    if key is None:
        print(
            "no OpenDesign control key: " + os.path.expanduser(args.key_file)
            + " is missing or empty; run od-login to approve a CLI sign-in",
            file=sys.stderr,
        )
        return 2

    workspace = args.workspace.strip()
    if not workspace:
        status, body = call(args.base, "/workspaces/current", key)
        if status != 200:
            print(f"workspaces/current answered HTTP {status}", file=sys.stderr)
            return 1
        workspace = str(body.get("activeWorkspaceId") or body.get("workspaceId") or "")
        if not workspace:
            print("the account reports no readable workspace", file=sys.stderr)
            return 1

    status, body = call(args.base, f"/workspaces/{workspace}/billing/preflight", key)
    if status != 200:
        print(f"billing/preflight answered HTTP {status}", file=sys.stderr)
        return 1

    plan = body.get("codingPlan") if isinstance(body.get("codingPlan"), dict) else {}
    windows = {}
    for raw in plan.get("windows") or []:
        if not isinstance(raw, dict):
            continue
        row = window_row(raw)
        if row is not None:
            windows[row[0]] = row[1]

    if not windows:
        print("the preflight payload carried no recognizable allowance window", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "windows": windows,
                "workspace": workspace,
                "plan": plan.get("plan"),
                "balanceUsd": body.get("balanceUsd"),
                "fetchedAt": iso_now(),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
