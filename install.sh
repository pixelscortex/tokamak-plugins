#!/usr/bin/env bash
# Builds plugins and installs them into the Tokamak app's plugins folder.
#
#   ./install.sh              build and install every plugin
#   ./install.sh hello        build and install the named plugins
#   ./install.sh --dev hello  install into the dev (debug) build's plugins folder
#
# TOKAMAK_PLUGIN_DIR overrides the plugins folder and TOKAMAK_SERVER_DIR the
# app's data folder (where a running app's control credential is).
# Run ./setup.sh once first. The work is in scripts/install.ts.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo"
if command -v proto >/dev/null 2>&1; then
  exec proto run bun -- scripts/install.ts "$@"
fi
exec bun scripts/install.ts "$@"
