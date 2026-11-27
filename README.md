# tokamak-plugins

The plugins for [Tokamak](https://github.com/pixelscortex/tokamak). The app
ships with no plugins: it loads whatever builds are in its **plugins folder**.
This repository builds and installs `chat`, `ai`, `code`, `claude`, `codex`,
`basic-auth`, `agent-proxy` and `ai-profiles`, plus the `hello` example.

## Set up

You need [proto](https://moonrepo.dev/proto) (or Bun 1.4.4) and a Tokamak
checkout with its dependencies installed. Nothing is published yet, so the
plugins build against that checkout.

```sh
# Next to this repository, as ../tokamak (or anywhere, then set TOKAMAK_DIR)
git clone https://github.com/pixelscortex/tokamak ../tokamak
(cd ../tokamak && proto run bun -- install --frozen-lockfile)

./setup.sh                          # links ../tokamak
TOKAMAK_DIR=/path/to/tokamak ./setup.sh
```

`setup.sh` links `@tokamak/sdk`, `@tokamak/build`, `@tokamak/ui` and
`@tokamak/runtime`, plus the plugins' build and test dependencies, into `node_modules`. Run it
again after moving the checkout; it only replaces its own links.

## Install

```sh
./install.sh                # build and install every plugin
./install.sh hello          # only the named plugins
./install.sh --dev hello    # into the dev (debug) build's plugins folder
```

For each plugin it builds `plugins/<id>`, then places the build at
`<plugins folder>/<id>`, replacing what was there. Owners are built and
reloaded before the plugins that depend on them. If any build fails, nothing
is copied and the installed builds keep working.

If Tokamak is running, the script asks it to reload each plugin, so the change
shows without a restart. Otherwise the plugins load at the next start. The
script never starts or quits the app. It prints the plugins folder, the result
of each reload and the Tokamak commit it built against: an app older than that
commit may fail to load the build.

The plugins folder is `~/Library/Application Support/com.pixelscortex.Tokamak/plugins`
(`com.pixelscortex.Tokamak.dev` with `--dev`). Override it with
`TOKAMAK_PLUGIN_DIR`, and the app's data folder (where a running app keeps its
control credential) with `TOKAMAK_SERVER_DIR`.

This script is a stopgap until Tokamak has its own installer. The app knows
nothing about it; the plugins folder is the only thing they share.

## Check

After setup, build once to generate the types for imports between plugins.
Use a temporary install folder for local checks:

```sh
d=$(mktemp -d)
TOKAMAK_SERVER_DIR="$d/data" TOKAMAK_PLUGIN_DIR="$d/plugins" ./install.sh
proto run bun -- run check
proto run bun -- run test
```

## Tests

After setup, use the pinned Bun to run the suites:

```sh
proto run bun -- run test:all                # unit, server and browser suites
proto run bun -- run test:server             # server-backed suites and replay privacy
proto run bun -- run test:suite chat-threads # one suite by name
```

`bun run test` still runs just the plugin unit tests. Set `TOKAMAK_DIR` for
both setup and tests if the checkout is somewhere other than `../tokamak`.
The runner prints the checkout commit and builds missing debug binaries there.
Set `TOKAMAK_SERVER_BIN`, `TOKAMAK_RUNNER_BIN`, or `TOKAMAK_PLUGIN_HOST_BIN`
to use a different build.

Suites run one at a time and use fake agents. Each gets a fresh folder under
the system temp directory for data, plugins and CLI configuration. The
runner removes it on success and prints its path on failure.

- `agent-routing`: Runner host isolation, reloads, channel routing and turn limits.
- `agent-proxy-server`: sign-in, company management and proxy requests against the Runner and cloud server builds.
- `ai-profiles-server`: profile management and persistence against both server builds.
- `starter`: loads all eight plugins and stores a Chat message in a fresh installation.
- `chat-schema`: upgrades the legacy Chat schema and reads the original assistant message after restart.
- `measure-first-text` (opt-in): measures time to first text with replay agents.
- `measure-linux-memory` (opt-in, Linux only): samples Runner plugin host memory from `/proc`.

The Runner and cloud Vitest suites build the cloud server and plugin host on
demand. Set `TOKAMAK_CLOUD_SERVER_BIN` and `TOKAMAK_CLOUD_PLUGIN_HOST_BIN` to
use prebuilt cloud binaries. Run the measurements by name; neither runs in
`test:all` or `test:server`.

The browser suite builds these plugins and serves a production build of the
Tokamak app. It uses Node.js for Playwright. Install Chromium and WebKit once
from the linked Tokamak checkout, then run the suite from this repository:

```sh
(cd "${TOKAMAK_DIR:-../tokamak}" && proto run bun -- x playwright install --no-shell chromium webkit)
proto run bun -- run test:e2e
proto run bun -- run test:suite browser -- chat.spec.ts --project=chromium
```

On Linux add `--with-deps` to the Playwright install command. The default runs
both Chromium and WebKit with one worker. Ports 1420, 1421, 43123 and 43124 must
be free; set `TOKAMAK_E2E_PORT` to override 1420. Set `TOKAMAK_SCREENS` to an
output directory to enable the screenshot specs. Failure traces and the HTML
report are under `.ci-results/playwright*`.

## Sync from Tokamak

```sh
TOKAMAK_DIR=/path/to/tokamak ./scripts/sync-from-tokamak.sh          # all eight
TOKAMAK_DIR=/path/to/tokamak ./scripts/sync-from-tokamak.sh chat ai  # named plugins
TOKAMAK_DIR=/path/to/tokamak ./scripts/sync-from-tokamak.sh --tests  # shared tests
```

The script mirrors the tracked source and design notes, including deletions.
It preserves local manifests and configurations, and prints the source commit.
Review and commit the diff after each sync. Run `--tests` to refresh the
shared drivers, fixtures, browser specs and fake-agent harness. Sync the
`claude codex agent-proxy ai-profiles` plugins for their own tests. Both
commands rewrite the copied imports for this repository.

## Layout

- `plugins/<id>/`: one plugin per folder, named by its id, with its
  `DESIGN.md`. `hello` is the smallest working example: one server function
  and one page that shows its result.
- `setup.sh`, `install.sh`: the two commands above. The work is in `scripts/`.
