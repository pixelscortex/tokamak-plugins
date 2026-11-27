// Real-server counterpart of chat_starts_with_current_schema_and_keeps_legacy_messages.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApi } from "@tokamak/sdk";
import { connect, startServer, within } from "../fake-agent/harness.mjs";
import { buildPlugin, buildPluginsIn } from "../support/build-plugins.ts";
import { testModules, testTemp, workspace } from "../support/paths.mjs";

const binary = process.argv[2];
assert.ok(binary && process.env.TOKAMAK_TEST_TEMP, "Run via test:suite chat-schema");

const root = await mkdtemp(join(testTemp, "chat-schema-"));
const chat = join(workspace, "plugins/chat");
const previous = join(root, "previous/chat");
const source = join(previous, "src/server");
await mkdir(join(source, "messages"), { recursive: true });
await symlink(testModules, join(previous, "node_modules"), "dir");
await writeFile(join(previous, "plugin.ts"), `
  import { definePlugin } from "@tokamak/sdk";
  export default definePlugin({ id: "chat", version: "0.1.0" });
`);
await writeFile(join(previous, "package.json"), '{"name":"chat","type":"module"}');
const schema = await readFile(join(chat, "tests/fixtures/schema-before-local-turns.ts"), "utf8");
await writeFile(join(source, "schema.ts"), schema.replace("../../src/server/messages/parts", "./messages/parts"));
await cp(join(chat, "src/server/messages/parts.ts"), join(source, "messages/parts.ts"));
// Only the old build exposes a test writer. The post-upgrade read uses Chat's API.
await writeFile(join(source, "fixture.ts"), `
  import { createFunctions } from "@tokamak/sdk";
  import schema from "./schema";

  export const seed = createFunctions(schema).mutation({
    args: {},
    handler: async ({ db }) => {
      const threadId = await db.insert("threads", {
        title: "Legacy", createdAt: 1, updatedAt: 1,
      });
      const messageId = await db.insert("messages", {
        threadId, role: "assistant", createdAt: 1, status: "complete",
        parts: [{ type: "text", text: "Earlier reply" }],
      });
      return { threadId, messageId };
    },
  });
`);
buildPlugin(previous);
const current = join(root, "current");
await buildPluginsIn(current, ["chat"]);

const token = randomBytes(32).toString("hex");
const localDir = join(root, "local");
await mkdir(localDir);
await writeFile(join(localDir, "server.token"), token, { mode: 0o600 });
const api = createApi("chat");

async function withChat(version, use) {
  const cleanup = [];
  const servers = [];
  try {
    const address = await startServer({
      binary,
      dir: join(root, `server-${version}`),
      dataDir: join(root, "store"),
      localDir,
      pluginsDir: join(root, version),
      cleanup,
      servers,
    });
    return await use(await connect(address, { token, cleanup }));
  } finally {
    for (const stop of cleanup.reverse()) await stop();
    for (const server of servers) {
      server.kill("SIGTERM");
      try {
        await within(server.exited, "server shutdown");
      } catch (error) {
        server.kill("SIGKILL");
        await server.exited;
        throw error;
      }
    }
  }
}

const { threadId, messageId } = await withChat("previous", (client) => client.mutation(api.fixture.seed, {}));
const rows = await withChat("current", (client) => client.query(api.messages.list, { threadId }));
assert.equal(rows.length, 1);
assert.equal(rows[0]._id, messageId);
assert.equal(rows[0].role, "assistant");
assert.deepEqual(rows[0].parts, [{ type: "text", text: "Earlier reply" }]);
console.log("Chat schema upgrade: current Chat read the same assistant message after restart.");
