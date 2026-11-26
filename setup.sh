#!/usr/bin/env bash
# Links Tokamak's packages from a Tokamak checkout into node_modules, so the
# plugins here build and type-check against that checkout. Nothing is
# published yet; the checkout on disk is the source of the SDK and builder.
#
#   ./setup.sh                       uses ../tokamak next to this repository
#   TOKAMAK_DIR=/path ./setup.sh     uses that checkout
#
# Safe to run again: it only replaces its own links.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tokamak="${TOKAMAK_DIR:-$repo/../tokamak}"

fail() {
  echo "setup: $1" >&2
  exit 1
}

[ -d "$tokamak" ] || fail "no Tokamak checkout at $tokamak. Clone it there or set TOKAMAK_DIR."
tokamak="$(cd "$tokamak" && pwd -P)"
[ -f "$tokamak/packages/sdk/package.json" ] ||
  fail "$tokamak is not a Tokamak checkout (no packages/sdk). Set TOKAMAK_DIR to one."
[ -d "$tokamak/node_modules" ] && [ -e "$tokamak/packages/build/node_modules/solid-js" ] ||
  fail "the Tokamak checkout at $tokamak has no installed dependencies. Run 'proto run bun -- install --frozen-lockfile' there first."

# Makes node_modules/<name> a link to <target>. Refuses to replace a real
# folder (for example one written by `bun install`), so nothing is deleted.
link() {
  local name="$1" target="$2" path="$repo/node_modules/$1"
  [ -e "$target" ] || fail "the Tokamak checkout at $tokamak is missing $target. Run 'proto run bun -- install --frozen-lockfile' there."
  target="$(cd "$target" && pwd -P)"
  mkdir -p "$(dirname "$path")"
  if [ -e "$path" ] && [ ! -L "$path" ]; then
    fail "$path is a real folder, not a link. Move it aside and run setup again."
  fi
  ln -sfn "$target" "$path"
  echo "  $name -> $target"
}

echo "Linking from the Tokamak checkout at $tokamak"
# Tokamak's own packages: the SDK, the builder, the UI kit and the runtime.
for package in sdk build ui runtime; do
  link "@tokamak/$package" "$tokamak/packages/$package"
done
# The toolchain a plugin with a window imports or type-checks against, taken
# from the checkout's own installs so the versions always match what Tokamak
# builds with. A plugin that imports anything else needs it added here.
link "solid-js" "$tokamak/packages/build/node_modules/solid-js"
link "@solidjs/web" "$tokamak/packages/build/node_modules/@solidjs/web"
link "tailwindcss" "$tokamak/packages/ui/node_modules/tailwindcss"
link "vite" "$tokamak/node_modules/vite"
link "@types/node" "$tokamak/node_modules/@types/node"
link "typescript" "$tokamak/packages/sdk/node_modules/typescript"

echo "Tokamak commit: $(git -C "$tokamak" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "Done. Build and install with ./install.sh [--dev] [id...]"
