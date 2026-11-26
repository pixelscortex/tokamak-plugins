# tokamak-plugins

The plugins for [Tokamak](https://github.com/pixelscortex/tokamak). The app
ships with no plugins: it loads whatever builds are in its **plugins folder**.
This repository builds plugins and puts them there.

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
`@tokamak/runtime`, plus the toolchain they build with (Solid, Vite, Tailwind,
TypeScript), into `node_modules`. Run it again after moving the checkout; it
only replaces its own links.

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

```sh
proto run bun -- run check   # type-check every plugin, as the editor does
```

## Layout

- `plugins/<id>/`: one plugin per folder, named by its id, with its
  `DESIGN.md`. `hello` is the smallest working example: one server function
  and one page that shows its result.
- `setup.sh`, `install.sh`: the two commands above. The work is in `scripts/`.
