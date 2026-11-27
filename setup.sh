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

# The source must exist, and node_modules/<name> must be absent or a link:
# a real folder there (for example one written by `bun install`) is never
# replaced, so nothing is deleted.
check() {
  local path="$repo/node_modules/$1"
  [ -e "$2" ] || fail "the Tokamak checkout at $tokamak is missing $2. Run 'proto run bun -- install --frozen-lockfile' there."
  if [ -e "$path" ] && [ ! -L "$path" ]; then
    fail "$path is a real folder, not a link. Move it aside and run setup again."
  fi
}

# Makes node_modules/<name> a link to <target>.
link() {
  local name="$1" target path="$repo/node_modules/$1"
  target="$(cd "$2" && pwd -P)"
  mkdir -p "$(dirname "$path")"
  ln -sfn "$target" "$path"
  echo "  $name -> $target"
}

# Resolve packages with no stable workspace path in Bun's install store.
# A peer-qualified instance can have a suffix after the version.
store_package() {
  local name="$1" version="$2" dir
  local key="${name/\//+}@$version"
  local paths=()
  for dir in "$tokamak/node_modules/.bun/$key" "$tokamak/node_modules/.bun/$key"+*; do
    [ -f "$dir/node_modules/$name/package.json" ] && paths+=("$dir/node_modules/$name")
  done
  if [ "${#paths[@]}" -ne 1 ]; then
    fail "expected one copy of $name@$version in $tokamak/node_modules/.bun, found ${#paths[@]}. Run 'proto run bun -- install --frozen-lockfile' in $tokamak."
  fi
  echo "${paths[0]#"$tokamak/"}"
}

marked="$(store_package marked 18.2.0)"

# Name in node_modules, then the folder in the checkout it links to.
# Tokamak's own packages: the SDK, the builder, the UI kit and the runtime.
# Then the toolchain a plugin with a window imports or type-checks against,
# taken from the checkout's own installs so the versions always match what
# Tokamak builds with. A plugin that imports anything else needs it added here.
links=(
  "@tokamak/sdk" "packages/sdk"
  "@tokamak/build" "packages/build"
  "@tokamak/ui" "packages/ui"
  "@tokamak/runtime" "packages/runtime"
  "solid-js" "packages/build/node_modules/solid-js"
  "@solidjs/web" "packages/build/node_modules/@solidjs/web"
  "tailwindcss" "packages/ui/node_modules/tailwindcss"
  "vite" "node_modules/vite"
  "@playwright/test" "node_modules/@playwright/test"
  "@types/node" "node_modules/@types/node"
  "typescript" "packages/sdk/node_modules/typescript"
  "vitest" "packages/build/node_modules/vitest"
  "jsdom" "packages/build/node_modules/jsdom"
  "@testing-library/dom" "packages/ui/node_modules/@testing-library/dom"
  "@testing-library/user-event" "packages/ui/node_modules/@testing-library/user-event"
  "@solidjs/vite-plugin" "packages/build/node_modules/@solidjs/vite-plugin"
  "@ui-sdk/core" "packages/ui/node_modules/@ui-sdk/core"
  "@ui-sdk/solid" "packages/ui/node_modules/@ui-sdk/solid"
  "marked" "$marked"
)

# Check everything first, so a problem never leaves half the links changed.
for ((i = 0; i < ${#links[@]}; i += 2)); do
  check "${links[i]}" "$tokamak/${links[i + 1]}"
done

echo "Linking from the Tokamak checkout at $tokamak"
for ((i = 0; i < ${#links[@]}; i += 2)); do
  link "${links[i]}" "$tokamak/${links[i + 1]}"
done

echo "Tokamak commit: $(git -C "$tokamak" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "Done. Build and install with ./install.sh [--dev] [id...]"
