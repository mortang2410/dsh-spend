#!/usr/bin/env python3
"""Read the OpenCode Go plan usage out of Bifrost's own request log.

Why this exists: the Go usage route (`GET https://opencode.ai/zen/go/v1/usage`)
needs a Go API key, and only the Bifrost gateway may hold one. Bifrost fetches
that route for the dedicated `opencode-go-billing` provider block (its
`list_models` path override points at it) and stores the response body in its
log database. This script copies the newest usable body out of that log. It
never sees a key and never calls the vendor itself.

Prints one JSON object on stdout:

    {"payload": {"usage": {"rolling": {...}, "weekly": {...}, "monthly": {...}}},
     "fetchedAt": "<ISO>", "rowTimestamp": "<UTC text>", "rowStatus": "success",
     "refreshed": true|false}

Each window row is the vendor's own `{status, percent, resetsAt}`; the adapter
normalizes it through `stats.normalizeProviderUsage`. Exits non-zero with a
message on stderr when no recent row carries a payload.
"""

import argparse
import json
import sys

import bifrost_usage as bifrost


def main():
    parser = bifrost.add_arguments(argparse.ArgumentParser(description=__doc__.splitlines()[0]))
    parser.add_argument("--provider", default="opencode-go-billing", help="provider block that fetched the usage")
    args = parser.parse_args()
    try:
        captured = bifrost.capture(args, args.provider, ("usage",))
    except bifrost.CaptureError as error:
        print(str(error), file=sys.stderr)
        return 1
    if not captured["payload"].get("usage"):
        print(f"row {captured['rowTimestamp']} status={captured['rowStatus']} has no usage windows", file=sys.stderr)
        return 1
    json.dump(captured, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
