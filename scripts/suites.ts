import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Suite = { kind: "server" | "unit"; script: string; mode?: "run" | "replay" };
const suites: Record<string, Suite> = {
  unit: { kind: "unit", script: "scripts/test.ts" },
  "chat-threads": { kind: "server", script: "tests/server/chat-threads-driver.mjs", mode: "run" },
  "ai-turns": { kind: "server", script: "tests/server/ai-turns-driver.mjs", mode: "run" },
  "ai-threads": { kind: "server", script: "tests/server/ai-threads-driver.mjs", mode: "run" },
  "ai-liveness": { kind: "server", script: "tests/server/ai-liveness-driver.mjs", mode: "run" },
  "code-changes": { kind: "server", script: "tests/server/code-changes-driver.mjs", mode: "replay" },
  "code-snapshots": { kind: "server", script: "tests/server/code-snapshots-driver.mjs", mode: "replay" },
  "claude-turns": { kind: "server", script: "plugins/claude/tests/turns.mjs", mode: "replay" },
  "codex-turns": { kind: "server", script: "plugins/codex/tests/e2e.mjs", mode: "replay" },
  "replay-privacy": { kind: "server", script: "tests/support/replay-privacy.mjs" },
};

const repo = resolve(import.meta.dir, "..");
const checkout = resolve(repo, process.env.TOKAMAK_DIR || "../tokamak");
const binarySpecs = {
  server: ["TOKAMAK_SERVER_BIN", "server", "tokamak-server"],
  runner: ["TOKAMAK_RUNNER_BIN", "tokamak-runner", "tokamak-runner"],
  host: ["TOKAMAK_PLUGIN_HOST_BIN", "tokamak-plugin-host", "tokamak-plugin-host"],
} as const;

function binary(key: keyof typeof binarySpecs): string {
  const [variable, crate, name] = binarySpecs[key];
  const override = process.env[variable];
  const target = join(checkout, "target");
  const file = override ? resolve(repo, override) : join(target, "debug", name);
  const requireExecutable = () => {
    if (!statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
    accessSync(file, constants.X_OK);
  };
  try {
    requireExecutable();
  } catch {
    if (override) throw new Error(`${variable} is not executable: ${file}`);
    console.log(`Building ${name} in ${checkout}`);
    const result = spawnSync("cargo", ["build", "--locked", "-p", crate, "--bin", name, "--target-dir", target], {
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

function run(name: string, suite: Suite) {
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
    if (suite.mode) {
      const server = binary("server");
      const runner = binary("runner");
      const host = binary("host");
      const home = join(root, "home");
      mkdirSync(home);
      Object.assign(env, {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        TOKAMAK_TEST_SERVER_BIN: server,
        TOKAMAK_TEST_RUNNER_BIN: runner,
        TOKAMAK_TEST_PLUGIN_HOST: host,
        TOKAMAK_PLUGIN_HOST: host,
      });
      // The drivers supply their own fake executables and credentials.
      for (const variable of ["TOKAMAK_TEST_OFFLINE_CODEX", "TOKAMAK_AGENT_FIXTURES",
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) {
        delete env[variable];
      }
      args.push(suite.mode === "run" ? server : runner);
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

const [selection, ...extra] = process.argv.slice(2);
if (extra.length || !selection || (selection !== "all" && selection !== "server" && !Object.hasOwn(suites, selection))) {
  console.error(`Usage: bun scripts/suites.ts <all|server|${Object.keys(suites).join("|")}>`);
  process.exit(1);
}
const selected = Object.entries(suites).filter(([name, suite]) =>
  selection === "all" || (selection === "server" ? suite.kind === "server" : selection === name),
);

if (selected.some(([, suite]) => suite.mode)) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
  if (head.status !== 0) {
    console.error(`No Tokamak checkout at ${checkout}. Set TOKAMAK_DIR and run ./setup.sh.`);
    process.exit(1);
  }
  try {
    if (realpathSync(join(repo, "node_modules/@tokamak/sdk")) !== realpathSync(join(checkout, "packages/sdk"))) {
      throw new Error("The checkout and SDK link differ");
    }
  } catch {
    console.error(`Run TOKAMAK_DIR="${checkout}" ./setup.sh to link this checkout before running suites.`);
    process.exit(1);
  }
  console.log(`Tokamak commit: ${head.stdout.trim()}`);
}
const failed: string[] = [];
for (const [name, suite] of selected) {
  if (!run(name, suite)) failed.push(name);
}
console.log(`\nSuites: ${selected.length - failed.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join(", ")})` : ""}.`);
process.exitCode = failed.length ? 1 : 0;
