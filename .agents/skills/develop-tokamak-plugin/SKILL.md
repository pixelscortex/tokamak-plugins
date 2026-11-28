---
name: develop-tokamak-plugin
description: Build, install and reload a Tokamak plugin in the tokamak-plugins repository, and write its server part, caller actions, window part and contracts. Use when creating or changing a Tokamak plugin.
---

Plugins live in the separate `tokamak-plugins` repository, one folder per plugin at `plugins/<id>/`,
named by its id. They build against a Tokamak checkout on disk; nothing is
published yet. The app ships with no plugins: it loads the builds in its
**plugins folder**. To **install** a plugin is to place its build there.

## Set up

- Clone Tokamak next to `tokamak-plugins` as `../tokamak`, or anywhere and set
  `TOKAMAK_DIR`. Install its dependencies there with
  `proto run bun -- install --frozen-lockfile`.
- In `tokamak-plugins`, run `./setup.sh`. It links `@tokamak/sdk`,
  `@tokamak/build`, `@tokamak/ui`, `@tokamak/runtime` and the toolchain they
  build with into `node_modules`. Run it again after moving the checkout.
- Change Tokamak in its own repository, never through the links.

## Create

Copy `plugins/hello`, the smallest working plugin, or run
`tokamak-server plugin create plugins/<id>` from `tokamak-plugins` with a
`tokamak-server` built from the Tokamak checkout. Either way the plugin has:

- `plugin.ts`: `definePlugin({ id, version, ... })`. List the plugins it uses
  in `depends` or `optional`.
- `package.json` with no `@tokamak/*` dependencies; `setup.sh` provides them.
- `src/server/` with `tsconfig.json` extending `@tokamak/sdk/tsconfig.server.json`.
- `src/client/` with `tsconfig.json` extending `@tokamak/sdk/tsconfig.window.json`
  and `styles.css` importing `@tokamak/ui/theme.css` by reference.
- `DESIGN.md`: the plugin's design note (see the `tokamak-design` skill).

Configs extend Tokamak's packages by name, never by a path into the checkout.
A plugin that uses another plugin builds when both sit side by side in
`plugins/`.

## Build, install and reload

- `./install.sh <id>` builds the plugin, places the build at
  `<plugins folder>/<id>` in one step and asks a running app to reload it.
  With no id it installs every plugin, owners before the plugins that depend
  on them. A failed build copies nothing; the installed builds keep working.
- `./install.sh --dev <id>` installs into the dev (debug) build's plugins
  folder instead.
- If the app is not running, the plugin loads at the next start. The script
  prints the plugins folder, each reload result and the Tokamak commit it
  built against. An app older than that commit may fail to load the build.
- To build without installing, run
  `proto run bun -- node_modules/@tokamak/build/src/build.ts plugins/<id>`.
- `proto run bun -- run check` type-checks every plugin, as the editor does.
- Commit the generated references in `src/server/_generated/` and component
  declarations in `src/client/_generated/`.
- Test against a throwaway folder (`TOKAMAK_PLUGIN_DIR`, `TOKAMAK_SERVER_DIR`)
  unless told to install into the owner's app.
- A plugin that fails to load is skipped with a reason; the others still
  load. Settings → Plugins shows loaded and failed plugins. The catalog
  (`GET /plugins`, or `tokamak-server plugin list` with
  `TOKAMAK_SERVER_DIR` set to the app's data folder) lists each reason under
  `skipped`, such as "not built" or "needs chat, which is not installed".

## Write the plugin

- **Server** (`src/server`): use `query` to read, `mutation` to write in one
  transaction, and `action` for effects. Define table schemas with
  `defineSchema` and `defineTable`; validate arguments with `v`. Read the caller
  from `ctx.auth.user` and `ctx.auth.device`, and check authorization before a
  write. Use `internalQuery`, `internalMutation`, or `internalAction` for
  operations private to this plugin. Use the generated `internal` references
  with `ctx.runQuery`, `ctx.runMutation`, or `ctx.runAction`. Return
  `fail(kind, data)` for expected failures and check them with `isFailure`.
  A mutation that returns `fail` rolls back its writes. A caller can handle a
  nested mutation's failure and keep its own writes, or return the failure to
  roll them back too. An action returning `fail` keeps mutations it already ran.
- **HTTP routes**: export `httpAction({ path, handler })` from the server part.
  A route such as `/:profile/*` answers under `/plugins/<id>/`. Check the caller
  in the handler; these routes do not require member sign-in. Use the web
  `Request` and return a `Response`, including a direct `fetch` response to
  stream it. The context provides `ctx.serverUrl`, `ctx.path` and `ctx.params`.
  Use `ctx.runQuery`, `ctx.runMutation`, and `ctx.runAction` with your own
  plugin's generated references. Those calls have no signed-in member.
  Read declared `env:NAME` permissions with `await ctx.env("NAME")`.
  Set `TOKAMAK_PUBLIC_URL` on the Server to read `ctx.serverUrl`. Core routes
  `/plugins/<id>/<revision>/assets/<name...>` and `/plugins/<id>/reload` take
  precedence. Handle `OPTIONS` yourself if you need CORS. Duplicate headers
  are joined and response `Set-Cookie` is dropped. Pass `request.signal` to
  outbound fetches so they can end on disconnect. Declare the usual network
  permission; each fetch from a fresh host performs its own DNS lookup and,
  for HTTPS, TLS handshake.
- **Caller actions**: use `action({ on: "caller", args, handler })` for files and programs on the
  person's computer. Use `ctx.proc([program, ...args], { cwd })` for programs
  and `ctx.signal` for cancellation. Call public server functions with their
  generated references; those calls use the same session as the window.
- **Window** (`src/client/api.tsx`): read server data using `useQuery` and
  public generated references. Use `useClient().action(ref, args)` and handle the `noMachine`
  failure when the action needs a Runner. Use `auth.me()` to read the signed-in member.
  Export a page with `view({ route: "/", title: "Editor" }, () => <Editor />)`.
  Write plain JSX. A build generates a typed `find` function on the client entry.
  A dependent plugin imports `plugin:<id>/client` and exports an action such as
  `after(owner.find("button", { in: "Editor" }), Tools)`.
  A static `data-part` or `id` supplies the element name when present. Narrow
  a name with literal `type`, `href`, `role`, or `aria` filters, such as
  `find("button", { aria: { label: "Stop" } })`. They match only static string
  attributes; `nth` counts the remaining matches. Both builds warn and ask
  for `data-part` when a search reaches a plain tag with no static name.
  The actions are `before`, `after`, `prepend`, `append`, `layer`, `attrs`, and `hide`.
  Use `layer(target, (props, Original) => <Original>New text</Original>)` to change
  contents while keeping the owner's markup. `<Original />` draws the next layer
  (or the owner); draw it at most once. Use `<Original.Children />` once inside
  `<Original>` to keep the children supplied by an outer layer or the owner's
  children with inside additions. If no layer draws the original element, it
  unloads. Layers stack by install order; `before` and `after` stay outside the stack.
  Use `attrs(target, (props, current) => ({ title: props.label }))` to set typed
  HTML attributes or component props. Classes merge; other defined values
  override in install order, then `order`, plugin ID, and export name. Read
  `current` to combine with earlier values. `<Original class="dim" />` applies
  after `attrs` if the owner is drawn. Identifiers, refs, contents, event handlers,
  and function props cannot be changed as attributes.
  Use `{ when: (props) => … }` on an action to apply it only to matching
  component instances.
  Use `attach(owner.find("Editor"), TrackEditor)` to run a component for each
  mounted instance of a named render function. Unlike placements, the search
  matches render functions. The attachment gets live props and can use effects,
  cleanup, context and regions; its JSX is not drawn in place. Hiding or
  layering an element inside the render function leaves it running.
  The view's **Plugin alerts** list reports skipped searches, layers that omit
  `Original` and cover another plugin's actions, hides that remove another
  plugin's actions, and failures in additions, layers, attribute callbacks,
  attachments, or `when`. Attribute alerts also report covered attributes,
  overwrites without reading `current`, forbidden attributes, and owners
  that need a rebuild. Cover and hide alerts clear when the action stops
  causing the loss. Failure alerts clear when the plugin is removed or reloaded.
  Use `state` for window values, `derived` for computed values, and
  `keep: "device"` or `keep: "me"` when a value needs to survive a restart.
- **Contracts**: export a typed `contract<T>("name")` from `src/contracts.ts`.
  A provider declares the owner in `depends` or `optional`, imports
  `plugin:<id>/contracts`, and exports `provide(key, implementation)`. The
  owner calls `key.list(ctx)` or `key.get(id, ctx)` from an action, and leaves `ctx` out in a query or mutation. For a Runner
  contract add `{ on: "caller" }` and use caller actions for members that need a
  Runner context.
  An optional provider may copy the owner's declaration to `contracts/<id>.ts`;
  keep it byte-identical. For membership changes, use `onMember` with the
  event from `plugin:auth/contracts`.
