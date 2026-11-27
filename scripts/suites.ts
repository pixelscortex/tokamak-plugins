import { buildPluginsIn } from "../tests/support/build-plugins.ts";
import { proxyFiles } from "../tests/support/server-vitest.config.ts";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Suite = { kind: "server" | "unit" | "browser"; script: string; mode?: "run" | "replay" | "vitest"; optIn?: boolean; linuxOnly?: boolean; files?: string[] };
const suites: Record<string, Suite> = {
  unit: { kind: "unit", script: "scripts/test.ts" },
  browser: { kind: "browser", script: "tests/e2e/browser.ts" },
  "chat-threads": { kind: "server", script: "tests/server/chat-threads-driver.mjs", mode: "run" },
  "ai-turns": { kind: "server", script: "tests/server/ai-turns-driver.mjs", mode: "run" },
  "ai-threads": { kind: "server", script: "tests/server/ai-threads-driver.mjs", mode: "run" },
  "ai-liveness": { kind: "server", script: "tests/server/ai-liveness-driver.mjs", mode: "run" },
  "code-changes": { kind: "server", script: "tests/server/code-changes-driver.mjs", mode: "replay" },
  "code-snapshots": { kind: "server", script: "tests/server/code-snapshots-driver.mjs", mode: "replay" },
  "claude-turns": { kind: "server", script: "plugins/claude/tests/turns.mjs", mode: "replay" },
  "codex-turns": { kind: "server", script: "plugins/codex/tests/e2e.mjs", mode: "replay" },
  "agent-routing": { kind: "server", script: "tests/runner/agent-routing.mjs", mode: "replay" },
  "agent-proxy-server": { kind: "server", script: "node_modules/vitest/vitest.mjs", mode: "vitest", files: proxyFiles },
  "ai-profiles-server": { kind: "server", script: "node_modules/vitest/vitest.mjs", mode: "vitest", files: ["plugins/ai-profiles/tests/profiles-server.test.ts"] },
  starter: { kind: "server", script: "tests/starter.mjs", mode: "run" },
  "chat-schema": { kind: "server", script: "tests/server/chat-schema-driver.mjs", mode: "run" },
  "measure-first-text": { kind: "server", script: "tests/runner/measure-first-text.mjs", mode: "replay", optIn: true },
  "measure-linux-memory": { kind: "server", script: "tests/runner/measure-linux-memory.mjs", mode: "replay", optIn: true, linuxOnly: true },
  "replay-privacy": { kind: "server", script: "tests/support/replay-privacy.mjs" },
};

const repo = resolve(import.meta.dir, "..");
const checkout = resolve(repo, process.env.TOKAMAK_DIR || "../tokamak");
const binarySpecs = {
  server: ["TOKAMAK_SERVER_BIN", "server", "tokamak-server"],
  runner: ["TOKAMAK_RUNNER_BIN", "tokamak-runner", "tokamak-runner"],
  host: ["TOKAMAK_PLUGIN_HOST_BIN", "tokamak-plugin-host", "tokamak-plugin-host"],
  cloudServer: ["TOKAMAK_CLOUD_SERVER_BIN", "server", "tokamak-server"],
  cloudHost: ["TOKAMAK_CLOUD_PLUGIN_HOST_BIN", "tokamak-plugin-host", "tokamak-plugin-host"],
} as const;

function binary(key: keyof typeof binarySpecs): string {
  const [variable, crate, name] = binarySpecs[key];
  const override = process.env[variable];
  const cloud = key === "cloudServer" || key === "cloudHost";
  const target = cloud ? join(checkout, "target/cloud") : join(checkout, "target");
  const file = override ? resolve(repo, override) : join(target, "debug", name);
  const requireExecutable = () => {
    if (!statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
    accessSync(file, constants.X_OK);
  };
  try {
    requireExecutable();
  } catch {
    if (override) throw new Error(`${variable} is not executable: ${file}`);
    console.log(`Building ${cloud ? "cloud " : ""}${name} in ${checkout}`);
    const packages = cloud
      ? ["--no-default-features", "-p", "server", "-p", "tokamak-plugin-host"]
      : ["-p", crate, "--bin", name];
    const result = spawnSync("cargo", ["build", "--locked", ...packages, "--target-dir", target], {
      cwd: checkout,
      env: { ...process.env, CARGO_BUILD_JOBS: "2" },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Cargo failed to build ${name}: ${result.signal ?? result.status}`);
    requireExecutable();
  }
  return file;
}

function clearDirectory(folder: string) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) clearDirectory(path);
    else unlinkSync(path);
  }
  rmdirSync(folder);
}

async function run(name: string, suite: Suite, extra: string[]) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `tokamak-tests-${name}-`));
  console.log(`\nRunning ${name}`);
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "1",
      TOKAMAK_DIR: checkout,
      TOKAMAK_TEST_TEMP: root,
      TOKAMAK_SERVER_DIR: join(root, "data"),
      TOKAMAK_PLUGIN_DIR: join(root, "plugins"),
      TOKAMAK_APP_DATA_DIR: join(root, "app-data"),
      TMPDIR: root,
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
    };
    const args = [suite.script];
    if (suite.mode || suite.kind === "browser") {
      const server = binary("server");
      const runner = binary("runner");
      const host = binary("host");
      Object.assign(env, {
        TOKAMAK_TEST_SERVER_BIN: server,
        TOKAMAK_TEST_RUNNER_BIN: runner,
        TOKAMAK_TEST_PLUGIN_HOST: host,
        TOKAMAK_PLUGIN_HOST: host,
      });
      if (suite.mode) {
        const home = join(root, "home");
        mkdirSync(home);
        Object.assign(env, {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: home,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "xdg-data"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_CACHE_HOME: join(root, "cache"),
        });
        if (suite.mode === "vitest") {
          const sources = join(root, "sources");
          Object.assign(env, {
            TOKAMAK_TEST_CLOUD_SERVER_BIN: binary("cloudServer"),
            TOKAMAK_TEST_CLOUD_PLUGIN_HOST: binary("cloudHost"),
            TOKAMAK_TEST_BUN: process.execPath,
          });
          await buildPluginsIn(sources, ["chat", "ai", "basic-auth", "agent-proxy", "ai-profiles"]);
          args.push("run", "--config", "tests/support/server-vitest.config.ts", ...suite.files!);
        } else {
          args.push(suite.mode === "run" ? server : runner);
        }
      }
      // The drivers supply their own fake executables and credentials.
      for (const variable of ["TOKAMAK_TEST_OFFLINE_CODEX", "TOKAMAK_AGENT_FIXTURES",
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) {
        delete env[variable];
      }
      if (suite.kind === "browser") args.push(...extra);
    }
    const result = spawnSync(process.execPath, args, { cwd: repo, env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`driver exited with ${result.signal ?? result.status}`);
    clearDirectory(root);
    console.log(`ok     ${name}`);
    return true;
  } catch (error) {
    console.error(`FAILED ${name}: ${error instanceof Error ? error.message : error}\n       Scratch folder: ${root}`);
    return false;
  }
}

const [selection, ...args] = process.argv.slice(2);
const extra = args[0] === "--" ? args.slice(1) : args;
if ((args.length && selection !== "browser") || !selection || (selection !== "all" && selection !== "server" && !Object.hasOwn(suites, selection))) {
  console.error(`Usage: bun scripts/suites.ts <all|server|${Object.keys(suites).join("|")}> [Playwright args for browser]`);
  process.exit(1);
}
const selected = Object.entries(suites).filter(([name, suite]) =>
  selection === name || (!suite.optIn && (selection === "all" || (selection === "server" && suite.kind === "server"))),
);

const runnable = selected.filter(([name, suite]) => {
  if (!suite.linuxOnly || process.platform === "linux") return true;
  console.log(`${name}: not run: Linux only`);
  return false;
});

if (runnable.some(([, suite]) => suite.mode || suite.kind === "browser")) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
  if (head.status !== 0) {
    console.error(`No Tokamak checkout at ${checkout}. Set TOKAMAK_DIR and run ./setup.sh.`);
    process.exit(1);
  }
  try {
    if (realpathSync(join(repo, "node_modules/@tokamak/sdk")) !== realpathSync(join(checkout, "packages/sdk"))) {
      throw new Error("The checkout and SDK link differ");
    }
    if (runnable.some(([, suite]) => suite.kind === "browser") &&
        realpathSync(join(repo, "node_modules/@playwright/test")) !== realpathSync(join(checkout, "node_modules/@playwright/test"))) {
      throw new Error("The checkout and Playwright link differ");
    }
  } catch {
    console.error(`Run TOKAMAK_DIR="${checkout}" ./setup.sh to link this checkout before running suites.`);
    process.exit(1);
  }
  console.log(`Tokamak commit: ${head.stdout.trim()}`);
}
const failed: string[] = [];
for (const [name, suite] of runnable) {
  if (!(await run(name, suite, extra))) failed.push(name);
}
console.log(`\nSuites: ${runnable.length - failed.length} passed, ${failed.length} failed${runnable.length !== selected.length ? `, ${selected.length - runnable.length} not run` : ""}${failed.length ? ` (${failed.join(", ")})` : ""}.`);
process.exitCode = failed.length ? 1 : 0;
