#!/usr/bin/env bash
# Copy the eight plugins (or the named subset) from a Tokamak checkout.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
if command -v proto >/dev/null 2>&1; then
  exec proto run bun -- scripts/sync.ts "$@"
fi
exec bun scripts/sync.ts "$@"
