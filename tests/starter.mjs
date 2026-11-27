// Fresh packaged installation against the real server.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildStarterPlugins } from "./support/starter-plugins.ts";
import { cleanScratch } from "./runner/support/scratch.mjs";
import { testTemp } from "./support/paths.mjs";
import { createApi } from "../node_modules/@tokamak/sdk/src/index.ts";
import { connect, startServer } from "./fake-agent/harness.mjs";

const [binary, ...extra] = process.argv.slice(2);
assert.ok(binary && !extra.length, "Pass only the test server binary");
const root = await mkdtemp(join(testTemp, "starter-"));
const pluginsDir = join(root, "plugins");
const localDir = join(root, "local");
const token = randomBytes(32).toString("hex");
const cleanup = [];
const servers = [];
try {
  await buildStarterPlugins(join(root, "sources"), pluginsDir);
  await mkdir(localDir);
  await writeFile(join(localDir, "server.token"), token, { mode: 0o600 });
  const address = await startServer({
    binary,
    dir: join(root, "server"),
    localDir,
    pluginsDir,
    cleanup,
    servers,
  });
  const list = await fetch(new URL("/plugins", address.replace(/^ws:/, "http:")), {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(list.status, 200);
  const catalog = await list.json();
  assert.deepEqual(catalog.plugins.map((item) => item.plugin.id).sort(), [
    "agent-proxy",
    "ai",
    "ai-profiles",
    "basic-auth",
    "chat",
    "claude",
    "code",
    "codex",
  ]);
  assert.ok(!catalog.failures?.length);
  const api = { chat: createApi("chat") };
  const browser = await connect(address, { token, cleanup });
  const first = await browser.mutation(api.chat.threads.start, {
    text: "Fresh install",
    folder: { kind: "own" },
  });
  const [message] = await browser.query(api.chat.messages.list, { threadId: first.threadId });
  assert.equal(message.parts[0].text, "Fresh install");
  console.log(
    "Starter install: all eight plugins loaded, local device authenticated, Chat stored a message.",
  );
} finally {
  for (const stop of cleanup.reverse()) await stop();
  for (const child of servers) {
    child.kill();
    await child.exited;
  }
  if (!process.env.TOKAMAK_TEST_TEMP) await cleanScratch(root);
}
