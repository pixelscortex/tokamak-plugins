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

/**
 * Puts `<plugin>/dist` at `<plugins folder>/<id>`. The copy is made under a
 * dot-named folder, which the app ignores, and appears under the real name by
 * one rename, so the app never sees a half-copied build.
 */
async function place(plugin: Plugin): Promise<string> {
  const target = join(pluginsFolder, plugin.id);
  const staging = join(pluginsFolder, `.${plugin.id}.installing-${process.pid}`);
  const aside = join(pluginsFolder, `.${plugin.id}.replaced-${process.pid}`);
  await deleteTree(staging);
  await cp(join(plugin.folder, "dist"), staging, { recursive: true });
  const replacing = existsSync(target);
  if (replacing) await rename(target, aside);
  try {
    await rename(staging, target);
  } catch (error) {
    // Put the old build back so the app keeps what it had.
    if (replacing) await rename(aside, target);
    throw error;
  }
  if (replacing) await deleteTree(aside);
  return target;
}

// ---- Reload -----------------------------------------------------------------

type App = { url: string; credential: string };

/**
 * Finds a running app from the files the Runner writes into its data folder:
 * `runner.json` holds the address, `runner.control` the credential that may
 * only list and reload plugins. Both are removed on a clean exit.
 */
async function runningApp(): Promise<App | null> {
  try {
    const discovery = JSON.parse(readFileSync(join(data, "runner.json"), "utf8"));
    const credential = readFileSync(join(data, "runner.control"), "utf8").trim();
    const url = new URL(discovery.url);
    if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
      return null;
    }
    const app = { url: `http://${url.host}`, credential };
    // A file left behind by a crash points at nothing; check that it answers.
    const response = await fetch(`${app.url}/plugins`, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? app : null;
  } catch {
    return null;
  }
}

async function reload(app: App, id: string): Promise<string | null> {
  try {
    const response = await fetch(`${app.url}/plugins/${encodeURIComponent(id)}/reload`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.credential}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return null;
    return `${response.status} ${(await response.text()).trim()}`;
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

for (const plugin of chosen) {
  console.log(`\nBuilding ${plugin.id}`);
  // Start from an empty dist: the builder rewrites changed files but never
  // removes old ones, and the whole folder is what gets installed.
  await deleteTree(join(plugin.folder, "dist"));
  if (!build(plugin)) {
    fail(`${plugin.id} failed to build. Nothing was installed; the installed builds are unchanged.`);
  }
}

await mkdir(pluginsFolder, { recursive: true });
console.log("");
for (const plugin of chosen) console.log(`Installed ${plugin.id} at ${await place(plugin)}`);

const app = await runningApp();
if (!app) {
  console.log("\nTokamak is not running. The plugins load at the next start.");
  process.exit(0);
}
let failed = 0;
for (const plugin of chosen) {
  const error = await reload(app, plugin.id);
  if (error) failed++;
  console.log(error ? `Reload of ${plugin.id} failed: ${error}` : `Reloaded ${plugin.id}`);
}
if (failed) {
  console.log("A failed reload keeps the app's previous build running; the new build loads at the next start.");
  process.exit(1);
}
