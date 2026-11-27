import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { build as buildPlugin, buildAgentPlugins } from "../fake-agent/harness.mjs";
import { tokamakDir, workspace } from "../support/paths.mjs";
import { browserPorts } from "./ports";

const scratch = process.env.TOKAMAK_TEST_TEMP;
const plugins = process.env.TOKAMAK_PLUGIN_DIR;
const local = process.env.TOKAMAK_SERVER_DIR;
if (!scratch || !plugins || !local || !process.env.TOKAMAK_TEST_SERVER_BIN) {
  throw new Error("Run this driver through bun run test:e2e");
}

const env = {
  ...process.env,
  TOKAMAK_FIXTURE_SOURCE: join(scratch, "fixture"),
  TOKAMAK_OTHER_DRAFT_SOURCE: join(scratch, "other-draft"),
  TOKAMAK_E2E_WEB_ROOT: join(scratch, "web"),
  TOKAMAK_E2E_EXTRA_PLUGINS: join(scratch, "extra-plugins"),
  TOKAMAK_E2E_PREVIEW_DIR: join(scratch, "preview"),
  TOKAMAK_E2E_BUN: process.execPath,
  TOKAMAK_ALLOWED_ORIGINS: `http://127.0.0.1:${browserPorts.preview}`,
  VITE_TOKAMAK_HTTP: `http://127.0.0.1:${browserPorts.local}`,
  VITE_TOKAMAK_TOKEN: randomBytes(32).toString("hex"),
  TOKAMAK_E2E_HOSTED_TOKEN: randomBytes(32).toString("hex"),
};

function run(command: string, args: string[], cwd: string, processEnv: NodeJS.ProcessEnv = env) {
  const result = spawnSync(command, args, { cwd, env: processEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.signal ?? result.status}`);
}

// Fail early, before building. Playwright and Vite also refuse to reuse a server.
for (const port of Object.values(browserPorts)) {
  await new Promise<void>((done, fail) => {
    const probe = createServer();
    probe.once("error", (error) => fail(new Error(`Browser suite needs a free port: 127.0.0.1:${port}`, { cause: error })));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done()));
  });
}

await mkdir(local, { mode: 0o700 });
await writeFile(join(local, "server.token"), env.VITE_TOKAMAK_TOKEN, { mode: 0o600 });
for (const [source, destination] of [
  ["integration", env.TOKAMAK_FIXTURE_SOURCE],
  ["other-draft", env.TOKAMAK_OTHER_DRAFT_SOURCE],
]) {
  await cp(join(tokamakDir, "app/tests/fixtures", source), destination, {
    recursive: true,
    filter: (path) => !["dist", ".tokamak", "node_modules"].includes(basename(path)),
  });
  // These copies are outside the Tokamak workspace's dependency tree.
  await symlink(join(tokamakDir, "app/node_modules"), join(destination, "node_modules"), "dir");
}
await writeFile(join(env.TOKAMAK_FIXTURE_SOURCE, "tsconfig.json"), JSON.stringify({
  extends: join(tokamakDir, "app/tsconfig.json"),
  include: ["src"],
}));
run(process.execPath, ["app/scripts/integration-fixture.ts", "--with-fixture-sign-in"], tokamakDir);

await buildAgentPlugins(scratch, (id: string) => join(plugins, id, "dist"));
for (const [directory, ids] of [
  [plugins, ["code", "basic-auth"]],
  [env.TOKAMAK_E2E_EXTRA_PLUGINS, ["agent-proxy", "ai-profiles", "claude", "codex"]],
] as const) {
  for (const id of ids) {
    const source = join(workspace, "plugins", id);
    buildPlugin(source);
    await cp(join(source, "dist"), join(directory, id, "dist"), { recursive: true });
  }
}
// Only the disposable copy can reach the fake sign-in companies.
const proxyManifest = join(env.TOKAMAK_E2E_EXTRA_PLUGINS, "agent-proxy/dist/manifest.json");
const manifest = JSON.parse(await readFile(proxyManifest, "utf8"));
manifest.plugin.permissions.push("net:127.0.0.1");
await writeFile(proxyManifest, JSON.stringify(manifest));

const build = ["run", "--cwd", "app", "build"];
const { VITE_TOKAMAK_HTTP: _http, VITE_TOKAMAK_TOKEN: _token, ...hostedEnv } = env;
run(process.execPath, [...build, "--outDir", env.TOKAMAK_E2E_WEB_ROOT], tokamakDir, hostedEnv);
run(process.execPath, [...build, "--outDir", env.TOKAMAK_E2E_PREVIEW_DIR], tokamakDir);

const home = join(scratch, "home");
await mkdir(home);
const browserCache = process.platform === "darwin" ? join(homedir(), "Library/Caches")
  : process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData/Local")
  : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
run("node", [
  join(workspace, "node_modules/@playwright/test/cli.js"),
  "test",
  ...process.argv.slice(2),
  "--config", "tests/e2e/playwright.config.ts",
  "--workers", "1",
], workspace, {
  ...env,
  // Use the normal browser install, but no personal app, agent or Git state.
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(browserCache, "ms-playwright"),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_DATA_HOME: join(scratch, "xdg-data"),
  XDG_STATE_HOME: join(scratch, "state"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: resolve(home, ".gitconfig"),
});
