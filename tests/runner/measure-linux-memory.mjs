import { testTemp } from "../support/paths.mjs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { connect } from "../fake-agent/harness.mjs";
import { startRunner } from "../fake-agent/start-runner.ts";
import { createApi } from "../../node_modules/@tokamak/sdk/src/index.ts";
import { prepareReplayAgents } from "./support/agents.mjs";
import { cleanScratch } from "./support/scratch.mjs";

// See the Runner README for the release build and measurement procedure.
assert.equal(process.platform, "linux", "This benchmark uses Linux smaps_rollup");
const binary = resolve(process.argv[2] ?? "target/release/tokamak-runner");
const scratch = await mkdtemp(join(testTemp, "tkm246-memory-"));
try {
  await syntheticHosts();
  await productionHosts();
} finally {
  if (!process.env.TOKAMAK_TEST_TEMP) await cleanScratch(scratch);
}

async function sample(pid) {
  const smaps = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
  const kib = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(smaps)?.[1]);
  return { pssKiB: kib("Pss"), anonPssKiB: kib("Pss_Anon"), filePssKiB: kib("Pss_File"), rssKiB: kib("Rss") };
}

async function childrenOf(pid) {
  const task = `/proc/${pid}/task`;
  const children = await Promise.all(
    (await readdir(task)).map((tid) => readFile(join(task, tid, "children"), "utf8").catch(() => "")),
  );
  return [...new Set(children.join(" ").match(/\d+/g) ?? [])];
}

async function command(pid) {
  return (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
}

async function productionHosts() {
  const dir = join(scratch, "production");
  await mkdir(dir);
  const { plugins, env } = await prepareReplayAgents(dir);
  const runner = await startRunner({ binary, plugins, directory: join(dir, "runner"), env });
  const cleanup = [];
  try {
    const client = await connect(runner.endpoint.ws, {
      token: runner.endpoint.token,
      launch: runner.launch,
      cleanup,
    });
    const row = await client.action(createApi("ai").agents.list, { windowId: "measure-linux-memory" });
    assert.deepEqual(row.map(({ id }) => id).sort(), ["claude", "codex"]);
    assert.ok(row.every(({ info }) => info.installed && info.signedIn));
    await Bun.sleep(400);
    const {
      endpoint: { http, token },
    } = runner;
    const { pid } = await (
      await fetch(http + "/health", {
        headers: { Authorization: "Bearer " + token },
      })
    ).json();
    const hosts = [];
    for (const child of await childrenOf(pid)) {
      const args = await command(child);
      if (args[1] === "--local-plugin") hosts.push({ id: args[2], child });
    }
    assert.deepEqual(hosts.map(({ id }) => id).sort(), ["ai", "claude", "codex"]);
    for (const { id, child } of hosts) {
      console.log(`Production ${id} host: ${JSON.stringify(await sample(child))}`);
    }
  } finally {
    for (const close of cleanup.reverse()) await close();
    assert.equal(await runner.stop(), 0);
  }
}

async function syntheticHosts() {
  const plugins = join(scratch, "plugins");
  await mkdir(plugins);
  const token = randomBytes(32).toString("hex");
  const runner = spawn(binary, ["--desktop", "--plugins", plugins, "--data", join(scratch, "store")], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => runner.on("exit", resolve));
  const lines = createInterface({ input: runner.stdout });
  const address = new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      const ws = /^Tokamak listening on (\S+)/.exec(line);
      if (ws) resolve(ws[1]);
    });
    lines.once("close", () => reject(new Error("Runner exited")));
  });
  runner.stdin.write(token + "\n");
  const sockets = [];
  try {
    const url = new URL("/local-worker", await address);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const code =
      'export const functions={warm:{kind:"action",on:"caller",visibility:"public",args:{kind:"any"},invoke:()=>null}};';
    const entryHash = digest("");
    const codeHash = digest(code);
    async function warm(index) {
      const id = "bench-" + index;
      const folder = join(plugins, id);
      await mkdir(folder);
      await Promise.all([
        writeFile(join(folder, "local.js"), code),
        writeFile(join(folder, "local-entry.js"), ""),
        writeFile(
          join(folder, "manifest.json"),
          JSON.stringify({
            plugin: { id },
            entries: { local: { entry: "local-entry.js", code: "local.js" } },
            hashes: { "local-entry.js": entryHash, "local.js": codeHash },
          }),
        ),
      ]);
      const socket = new WebSocket(url, ["tokamak", "tokamak.bearer." + token]);
      sockets.push(socket);
      const send = (frame) => socket.send(JSON.stringify(frame));
      await new Promise((resolve, reject) => {
        socket.addEventListener("error", reject);
        socket.addEventListener("close", () => reject(new Error("Socket closed")));
        socket.addEventListener("open", () => send({ type: "start", artifact: { id, entryHash, codeHash } }));
        socket.addEventListener("message", ({ data }) => {
          const frame = JSON.parse(data);
          if (frame.type === "started")
            send({ type: "write", message: { type: "invoke", id: 1, fn: "warm", args: null, action: true } });
          else if (frame.message?.type === "op")
            send({ type: "write", message: { type: "opResult", id: frame.message.id, value: null } });
          else if (frame.message?.type === "result")
            frame.message.error ? reject(new Error(frame.message.error)) : resolve();
          else if (frame.type === "closed") reject(new Error(frame.reason));
        });
      });
    }
    async function memory() {
      const children = await childrenOf(runner.pid);
      const processes = (
        await Promise.all(
          children.map(async (pid) => {
            try {
              const args = await command(pid);
              const isHost = args[1] === "--local-plugin";
              const isGuardian = args.includes("worker-guardian");
              if (!isHost && !isGuardian) return;
              return { isHost, isGuardian, ...(await sample(pid)) };
            } catch {
              return;
            }
          }),
        )
      ).filter(Boolean);
      const summarize = (list) => ({
        count: list.length,
        pssKiB: list.reduce((total, p) => total + p.pssKiB, 0),
        anonPssKiB: list.reduce((total, p) => total + p.anonPssKiB, 0),
        filePssKiB: list.reduce((total, p) => total + p.filePssKiB, 0),
        rssKiB: list.reduce((total, p) => total + p.rssKiB, 0),
      });
      return {
        host: summarize(processes.filter((p) => p.isHost)),
        guardian: summarize(processes.filter((p) => p.isGuardian)),
      };
    }
    await warm(0);
    await Bun.sleep(200);
    const one = await memory();
    assert.equal(one.host.count, 1);
    console.log("One idle host: " + JSON.stringify(one));
    for (let i = 1; i < 100; i++) await warm(i);
    await Bun.sleep(400);
    const hundred = await memory();
    assert.equal(hundred.host.count, 100);
    console.log("100 idle hosts: " + JSON.stringify(hundred));
    console.log("Marginal host PSS KiB: " + ((hundred.host.pssKiB - one.host.pssKiB) / 99).toFixed(1));
  } finally {
    for (const socket of sockets) socket.close();
    runner.stdin.end();
    assert.equal(await exited, 0);
  }
}
