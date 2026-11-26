/**
 * Builds plugins and installs them into the Tokamak app's plugins folder.
 * Run it through ../install.sh: `./install.sh [--dev] [id...]`.
 *
 * This is an escape hatch until Tokamak has its own installer. The app knows
 * nothing about this script: the plugins folder is the only thing they share.
 * To install a plugin is to place its build at `<plugins folder>/<id>`.
 *
 * Steps:
 *   1. Build every named plugin (all of them when none is named), owners
 *      before the plugins that depend on them. Any failed build stops the run
 *      before anything is copied, so the installed builds keep working.
 *   2. Place each build in one step: copy it to a dot-named folder inside the
 *      plugins folder (the app ignores dot-folders), move the old build aside,
 *      rename the copy to `<id>`, then delete the old build. No version check:
 *      an install always replaces what was there.
 *   3. If the app is running, ask it to reload each installed id, owners first.
 *      Otherwise say the plugins load at the next start. The app is never
 *      started or quit.
 *
 * Deleting walks the tree with unlink and rmdir; nothing here calls rm.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const pluginsSource = join(repo, "plugins");

type Plugin = { id: string; folder: string; depends: string[] };

function fail(message: string): never {
  console.error(`install: ${message}`);
  process.exit(1);
}

// ---- Arguments --------------------------------------------------------------

const args = process.argv.slice(2);
const dev = args.includes("--dev");
const unknown = args.filter((arg) => arg.startsWith("-") && arg !== "--dev");
if (unknown.length) fail(`unknown option ${unknown.join(", ")}. Usage: ./install.sh [--dev] [id...]`);
const named = args.filter((arg) => !arg.startsWith("-"));

// ---- Where things are -------------------------------------------------------

/**
 * The app's data folder, matching `Folders::resolve` in Tokamak: the
 * TOKAMAK_SERVER_DIR override, else the platform data folder, named
 * `Tokamak.dev` for a debug build. The control credential lives here.
 */
function dataFolder(): string {
  const override = process.env.TOKAMAK_SERVER_DIR;
  if (override) return resolve(override);
  const name = dev ? "Tokamak.dev" : "Tokamak";
  if (process.platform === "darwin") {
    return join(homedir(), "Library/Application Support", `com.pixelscortex.${name}`);
  }
  if (process.platform === "linux") {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
    return join(base, name.toLowerCase());
  }
  fail(`no default data folder on ${process.platform}; set TOKAMAK_SERVER_DIR and TOKAMAK_PLUGIN_DIR`);
}

const data = dataFolder();
// The plugins folder: TOKAMAK_PLUGIN_DIR, else `plugins` in the data folder.
const pluginsFolder = resolve(process.env.TOKAMAK_PLUGIN_DIR || join(data, "plugins"));

/** The checkout the build runs against, found through setup.sh's link. */
function tokamakCheckout(): string {
  const sdk = join(repo, "node_modules/@tokamak/sdk");
  if (!existsSync(sdk)) fail("Tokamak's packages are not linked. Run ./setup.sh first.");
  return resolve(realpathSync(sdk), "../..");
}

function tokamakCommit(checkout: string): string {
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) return "unknown (not a git checkout)";
  const dirty = git("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "";
  return `${head.stdout.trim()}${dirty ? " (with uncommitted changes)" : ""}`;
}

// ---- Which plugins, in which order -----------------------------------------

/** Reads each plugin's descriptor for its id and required plugins. */
async function readPlugin(folder: string): Promise<Plugin> {
  const descriptor = (await import(join(folder, "plugin.ts"))).default as {
    id: string;
    depends?: string[] | Record<string, string>;
  };
  const depends = descriptor.depends ?? [];
  return {
    id: descriptor.id,
    folder,
    depends: Array.isArray(depends) ? depends : Object.keys(depends),
  };
}

async function allPlugins(): Promise<Map<string, Plugin>> {
  const plugins = new Map<string, Plugin>();
  for (const entry of readdirSync(pluginsSource, { withFileTypes: true })) {
    const folder = join(pluginsSource, entry.name);
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!existsSync(join(folder, "plugin.ts"))) continue;
    const plugin = await readPlugin(folder);
    if (plugin.id !== entry.name) {
      fail(`plugins/${entry.name} declares id "${plugin.id}"; the folder must be named by its id`);
    }
    plugins.set(plugin.id, plugin);
  }
  return plugins;
}

/**
 * Orders the chosen plugins so each comes after the plugins it depends on.
 * Owners outside the chosen set are not installed, only ordered around.
 */
function dependencyOrder(chosen: string[], plugins: Map<string, Plugin>): Plugin[] {
  const order: Plugin[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") fail(`dependency cycle: ${[...path, id].join(" -> ")}`);
    const plugin = plugins.get(id);
    if (!plugin) return; // An owner that is not in this repository (for example `auth`).
    state.set(id, "visiting");
    for (const owner of plugin.depends) visit(owner, [...path, id]);
    state.set(id, "done");
    if (chosen.includes(id)) order.push(plugin);
  };
  for (const id of chosen) visit(id, []);
  return order;
}

// ---- Deleting without rm ----------------------------------------------------

/** Deletes a folder tree with unlink for files and links, rmdir for folders. */
async function deleteTree(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return;
  if (!stat.isDirectory()) return unlink(path);
  for (const name of await readdir(path)) await deleteTree(join(path, name));
  await rmdir(path);
}

// ---- Build ------------------------------------------------------------------

function build(plugin: Plugin): boolean {
  const result = spawnSync(
    process.execPath,
    [join(repo, "node_modules/@tokamak/build/src/build.ts"), plugin.folder],
    { cwd: repo, stdio: "inherit" },
  );
  return result.status === 0 && existsSync(join(plugin.folder, "dist/manifest.json"));
}

// ---- Place ------------------------------------------------------------------

type Staged = { plugin: Plugin; target: string; staging: string; aside: string; replaced: boolean };

/**
 * Copies `<plugin>/dist` to a dot-named folder inside the plugins folder. The
 * app ignores dot-folders, so a half-finished copy is never loaded.
 */
async function stage(plugin: Plugin): Promise<Staged> {
  const staged = {
    plugin,
    target: join(pluginsFolder, plugin.id),
    staging: join(pluginsFolder, `.${plugin.id}.installing-${process.pid}`),
    aside: join(pluginsFolder, `.${plugin.id}.replaced-${process.pid}`),
    replaced: false,
  };
  await deleteTree(staged.staging);
  try {
    await cp(join(plugin.folder, "dist"), staged.staging, { recursive: true });
  } catch (error) {
    await deleteTree(staged.staging);
    throw error;
  }
  return staged;
}

/**
 * Swaps every staged copy into place by rename: the old build moves aside,
 * the copy takes its name. If any swap fails, the ones already made are
 * undone, so the folder never holds a new owner beside an old dependent.
 * Old builds are deleted only after every swap has succeeded.
 */
async function swapAll(all: Staged[]): Promise<void> {
  const done: Staged[] = [];
  try {
    for (const staged of all) {
      staged.replaced = existsSync(staged.target);
      if (staged.replaced) await rename(staged.target, staged.aside);
      try {
        await rename(staged.staging, staged.target);
      } catch (error) {
        if (staged.replaced) await rename(staged.aside, staged.target);
        throw error;
      }
      done.push(staged);
    }
  } catch (error) {
    for (const staged of done.reverse()) {
      await rename(staged.target, staged.staging);
      if (staged.replaced) await rename(staged.aside, staged.target);
    }
    for (const staged of all) await deleteTree(staged.staging);
    throw error;
  }
  for (const staged of all) {
    if (!staged.replaced) continue;
    // The install has succeeded; a leftover dot-folder is only clutter.
    await deleteTree(staged.aside).catch((error) =>
      console.log(`Could not delete the old build at ${staged.aside}: ${error}`),
    );
  }
}

// ---- Reload -----------------------------------------------------------------

type App = { url: string; credential: string };
type Catalog = { pluginsFolder?: string; plugins: { plugin: { id: string }; folder?: string; hashes?: unknown }[] };

async function request(app: App, path: string, method = "GET", timeout = 10_000): Promise<Response> {
  return fetch(`${app.url}${path}`, {
    method,
    redirect: "manual",
    headers: { authorization: `Bearer ${app.credential}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
    signal: AbortSignal.timeout(timeout),
  });
}

/**
 * Finds a running app from the files the Runner writes into its data folder:
 * `runner.json` holds the address, `runner.control` the credential that may
 * only list and reload plugins. Both are removed on a clean exit, so no file
 * means no running app. A file that is present but does not answer is
 * reported as such, not as a stopped app.
 */
async function runningApp(): Promise<{ app: App; catalog: Catalog } | { absent: true } | { problem: string }> {
  const discoveryFile = join(data, "runner.json");
  if (!existsSync(discoveryFile)) return { absent: true };
  let app: App;
  try {
    const url = new URL(JSON.parse(readFileSync(discoveryFile, "utf8")).url);
    if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
      return { problem: `${discoveryFile} does not point at a local address` };
    }
    app = { url: `http://${url.host}`, credential: readFileSync(join(data, "runner.control"), "utf8").trim() };
  } catch (error) {
    return { problem: `cannot read ${discoveryFile} or runner.control: ${error}` };
  }
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await request(app, "/plugins");
      if (response.ok) return { app, catalog: (await response.json()) as Catalog };
      last = `${response.status} ${(await response.text()).trim()}`;
      if (response.status === 401 || response.status === 403) break;
    } catch (error) {
      // Connection refused: most likely a file left behind by a crash.
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { problem: `${app.url} did not answer (${last})` };
}

/**
 * Reloads one plugin and confirms the app now runs the build just placed:
 * same folder, same artifact hashes. A 200 alone could mean it reloaded
 * some other copy.
 */
async function reload(app: App, id: string, target: string): Promise<string | null> {
  try {
    const response = await request(app, `/plugins/${encodeURIComponent(id)}/reload`, "POST", 60_000);
    if (!response.ok) return `${response.status} ${(await response.text()).trim()}`;
    const catalog = (await (await request(app, "/plugins")).json()) as Catalog;
    const entry = catalog.plugins.find((plugin) => plugin.plugin.id === id);
    if (!entry) return "the app does not list it after the reload";
    if (!entry.folder || realpathSync(entry.folder) !== realpathSync(target)) {
      return `the app loaded it from ${entry.folder}, not ${target}`;
    }
    const installed = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
    // Compare as sorted entries: the catalog lists files in another order.
    const sorted = (hashes: unknown) =>
      JSON.stringify(Object.entries((hashes ?? {}) as Record<string, string>).sort());
    if (sorted(entry.hashes) !== sorted(installed.hashes)) {
      return "the app still runs a different build";
    }
    return null;
  } catch (error) {
    return String(error);
  }
}

// ---- Run --------------------------------------------------------------------

const checkout = tokamakCheckout();
const plugins = await allPlugins();
for (const id of named) if (!plugins.has(id)) fail(`no plugin "${id}" in ${pluginsSource}`);
const chosen = dependencyOrder(named.length ? named : [...plugins.keys()].sort(), plugins);
if (!chosen.length) fail(`no plugins found in ${pluginsSource}`);

console.log(`Tokamak checkout: ${checkout}`);
console.log(`Tokamak commit:   ${tokamakCommit(checkout)}`);
console.log(`Plugins folder:   ${pluginsFolder}${dev ? " (dev build)" : ""}`);

// The plugins folder must not be (or sit inside) this repository: the
// install would then delete and replace the sources it builds from.
await mkdir(pluginsFolder, { recursive: true });
const realFolder = realpathSync(pluginsFolder);
const realRepo = realpathSync(repo);
if (realFolder === realRepo || realFolder.startsWith(`${realRepo}/`) || realRepo.startsWith(`${realFolder}/`)) {
  fail(`the plugins folder ${pluginsFolder} overlaps this repository; point TOKAMAK_PLUGIN_DIR elsewhere`);
}

for (const plugin of chosen) {
  console.log(`\nBuilding ${plugin.id}`);
  // Start from an empty dist: the builder rewrites changed files but never
  // removes old ones, and the whole folder is what gets installed.
  await deleteTree(join(plugin.folder, "dist"));
  if (!build(plugin)) {
    fail(`${plugin.id} failed to build. Nothing was installed; the installed builds are unchanged.`);
  }
}

const staged: Staged[] = [];
try {
  for (const plugin of chosen) staged.push(await stage(plugin));
  await swapAll(staged);
} catch (error) {
  for (const copy of staged) await deleteTree(copy.staging).catch(() => {});
  fail(`could not place the builds (${error}). The installed builds are unchanged.`);
}
console.log("");
for (const copy of staged) console.log(`Installed ${copy.plugin.id} at ${copy.target}`);

const found = await runningApp();
if ("absent" in found) {
  console.log("\nTokamak is not running. The plugins load at the next start.");
  process.exit(0);
}
if ("problem" in found) {
  console.log(`\nCould not reach a running Tokamak: ${found.problem}.`);
  console.log("If the app is running, restart it to load the plugins; otherwise they load at the next start.");
  process.exit(1);
}
const appFolder = found.catalog.pluginsFolder;
if (appFolder && realpathSync(appFolder) !== realFolder) {
  console.log(`\nThe running Tokamak loads plugins from ${appFolder}, not ${pluginsFolder}. Not reloading.`);
  process.exit(1);
}
let failed = 0;
for (const copy of staged) {
  const error = await reload(found.app, copy.plugin.id, copy.target);
  if (error) failed++;
  console.log(error ? `Reload of ${copy.plugin.id} failed: ${error}` : `Reloaded ${copy.plugin.id}`);
}
if (failed) {
  console.log("A failed reload keeps the app's previous build running; the new build loads at the next start.");
  process.exit(1);
}
