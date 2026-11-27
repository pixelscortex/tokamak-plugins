// The local part as the desktop client starts it, and the `fake-agent` command,
// for any test runtime (Bun or Node): the server harness and the browser suite.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const program = fileURLToPath(new URL("./program.mjs", import.meta.url));
export const agentsFolder = fileURLToPath(new URL("./agents/", import.meta.url));

/** The fake agents: one plugin folder each under ./agents, named after the command it starts. */
export async function fakeAgents() {
  return (await readdir(agentsFolder, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** The pinned Bun: this process under Bun, else what the runner passed in TOKAMAK_E2E_BUN. */
export function bunPath() {
  const bun = process.versions.bun ? process.execPath : process.env.TOKAMAK_E2E_BUN;
  if (!bun) throw new Error("Run under Bun or set TOKAMAK_E2E_BUN");
  return bun;
}

/**
 * Puts each of `commands` (by default every fake agent's) in `bin`: a shell script
 * running the replay program with the pinned Bun, as `claude` or `codex`
 * would sit on PATH.
 */
export async function installFakeAgent(bin, commands) {
  await mkdir(bin, { recursive: true });
  for (const command of commands ?? (await fakeAgents())) {
    await writeFile(
      join(bin, command),
      `#!/bin/sh\nexec ${JSON.stringify(bunPath())} ${JSON.stringify(program)} "$@"\n`,
    );
    await chmod(join(bin, command), 0o755);
  }
}

/**
 * Launches a plugin process directly for server-only fixtures
 * (the Runner implementation is in packages/runner/src/local.rs): the installed, hash-checked `local-entry.js`
 * and `local.js` with the QuickJS host and the desktop’s short environment.
 * Programs started with `ctx.proc` inherit exactly that environment.
 * `installed(id)` is the folder holding a plugin's build.
 */
export function localLauncher(binary, installed, env, observe) {
  const host = resolve(
    process.env.TOKAMAK_TEST_PLUGIN_HOST ??
      process.env.TOKAMAK_PLUGIN_HOST ??
      join(dirname(binary), "tokamak-plugin-host"),
  );

  async function verified(artifact) {
    const root = installed(artifact.id);
    for (const [name, hash] of [
      ["local-entry.js", artifact.entryHash],
      ["local.js", artifact.codeHash],
    ]) {
      const actual = createHash("sha256")
        .update(await readFile(join(root, name)))
        .digest("hex");
      if (actual !== hash) throw new Error(`${artifact.id}/${name} does not match the catalog`);
    }
    return root;
  }
  return async (artifact, receive, closed) => {
    const root = await verified(artifact);
    assert.ok(
      await stat(host)
        .then((file) => file.isFile())
        .catch(() => false),
      `Missing plugin host: ${host}`,
    );
    await access(host, constants.X_OK);
    const worker = spawn(host, [join(root, "local.js")], {
      detached: true,
      stdio: ["pipe", "pipe", "inherit"],
      cwd: env.HOME,
      env,
    });
    worker.stdin.on("error", (error) => closed(String(error)));
    const exited = new Promise((resolve) => {
      worker.once("exit", resolve);
      worker.once("error", (error) => {
        closed(String(error));
        resolve();
      });
    });
    void (async () => {
      try {
        for await (const line of createInterface({ input: worker.stdout })) {
          const frame = JSON.parse(line);
          observe?.(artifact.id, frame, "fromWorker");
          receive(frame);
        }
        closed("Plugin process exited");
      } catch (error) {
        closed(String(error));
      }
    })();
    return {
      async route() {
        throw new Error("Use a Runner for local contract routing");
      },
      async retire() {},
      async send(value) {
        const hold = observe?.(artifact.id, value, "toWorker");
        if (hold) await hold;
        worker.stdin.write(JSON.stringify(value) + "\n");
      },
      async close() {
        worker.stdin.end();
        await exited;
      },
    };
  };
}

export { startRunner } from "./start-runner.ts";
