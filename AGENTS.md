# tokamak-plugins

Plugins for Tokamak, built against a Tokamak checkout and installed into the
app's plugins folder. See `README.md` for setup and install.

## Working rules

- **Builds against a Tokamak checkout.** `./setup.sh` links Tokamak's packages
  from `../tokamak` or `TOKAMAK_DIR`. Read the SDK and builder there
  (`packages/sdk`, `packages/build/README.md`, `packages/server/PLUGINS.md`,
  `packages/server/src/plugin-skill.md`). Change Tokamak in its own repository,
  never through the links.
- **Plugin layout.** `plugins/<id>/` with `plugin.ts`, `src/server`,
  `src/client`, and configs that extend Tokamak's packages by name
  (`@tokamak/sdk/tsconfig.server.json`, `@tokamak/sdk/tsconfig.window.json`,
  `@tokamak/ui/theme.css`). Commit the generated `src/server/_generated` and
  `src/client/_generated` files. `hello` is the reference example.
- **Design sync.** A plugin's design note is the `DESIGN.md` in its own folder.
  A change to what a plugin's screen looks like updates its `DESIGN.md` and its
  `App 1:1` page in Paper in the same piece of work, and checks the notes of
  every plugin it affects. The design rules live in Tokamak's `design/README.md`.
- **Deleting.** Use `unlink` (or `rmdir` for an empty folder), or move a folder
  aside. Never `rm`.
- **Commits.** Plain messages in the owner's voice. No AI attribution, no
  co-author lines, no "Generated with" footers, in commits, PRs or comments.
- **Installing.** `./install.sh [--dev] [id...]`. Test against a throwaway
  folder (`TOKAMAK_PLUGIN_DIR`, `TOKAMAK_SERVER_DIR`) unless told to install
  into the owner's app.
- **Checks.** `proto run bun -- run check` type-checks every plugin. There is
  no CI here for now; put what you ran and its result in the PR.
