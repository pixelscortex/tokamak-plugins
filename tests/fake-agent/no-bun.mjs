// Bundle this client with the SDK on the build machine. Run it with Node 22+
// and prebuilt artifacts on a machine without Bun. The Runner needs the OS CA
// bundle, and the temporary directory must allow executing the test agent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, TokamakClient, WebSocketTransport } from "../../node_modules/@tokamak/sdk/src/index.ts";
import { LocalFunctions } from "../../node_modules/@tokamak/runtime/js/local.ts";
import { startRunner } from "./start-runner.ts";

const probe = createApi("no-bun-action");
const chat = createApi("chat");
const ai = createApi("ai");
const args = process.argv.slice(2);
assert.equal(spawnSync("/bin/sh", ["-c", "! command -v bun"], { stdio: "ignore" }).status, 0);
process.stdout.write("no-bun\n");

let socket;
let local;
let runner;
let scratch;
try {
  const deadline = AbortSignal.timeout(30_000);
  let ws;
  let token;
  if (args[0] === "--server") {
    const origin = new URL(args[1]);
    const headers = { Authorization: `Bearer ${process.env.TOKAMAK_ACCESS_TOKEN}` };
    const health = await fetch(new URL("/health", origin), { headers, signal: deadline });
    assert.equal(health.status, 200);
    process.stdout.write("health 200\n");
    const owner = await fetch(new URL("/auth/owner", origin), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName: "No Bun smoke test" }),
      signal: deadline,
    });
    assert.equal(owner.status, 200, await owner.clone().text());
    ({ key: token } = await owner.json());
    ws = new URL("/ws", origin);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  } else {
    const [binary, plugins] = args;
    assert.ok(binary && plugins, "Expected the Runner binary and prebuilt plugins folder");
    scratch = await mkdtemp(join(tmpdir(), "tokamak-no-bun-"));
    const bin = join(scratch, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "fake-agent"),
      `#!/bin/sh
case "$1" in
  --list) printf '%s\\n' smoke ;;
  --replay)
    IFS= read -r prompt
    printf '%s\\n' '{"type":"text","delta":"Hello from the fake agent."}'
    printf '%s\\n' '{"type":"done","sessionId":"no-bun-smoke"}'
    ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    runner = await startRunner({
      binary,
      plugins,
      directory: join(scratch, "runner"),
      env: { HOME: scratch, PATH: `${bin}:/usr/bin:/bin` },
    });
    ({ ws, token } = runner.endpoint);
  }
  assert.ok(token);
  socket = new WebSocket(ws, ["tokamak", `tokamak.bearer.${token}`]);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
    deadline.addEventListener("abort", () => reject(deadline.reason), { once: true });
  });
  const transport = new WebSocketTransport(socket);
  if (runner) {
    const url = new URL(ws);
    local = new LocalFunctions(transport, runner.launch, url.origin + url.pathname);
  }
  const client = new TokamakClient(transport, local);
  const action = await client.action(probe.probe.run, {}, { signal: deadline });
  assert.deepEqual(action, { ran: true, bun: false });
  process.stdout.write(`server action: ${JSON.stringify(action)}\n`);
  if (runner) {
    const started = await client.mutation(chat.threads.start, {
      text: "Say hello.",
      folder: { kind: "chosen", path: scratch },
    });
    const { threadId, messageId } = started;
    assert.ok(threadId && messageId, `Could not start the thread: ${JSON.stringify(started)}`);
    const turn = await client.action(
      ai.run.turn,
      {
        windowId: "no-bun",
        threadId,
        messageId,
        folder: scratch,
        agentId: "fake-agent",
        model: "smoke",
        access: "full",
      },
      { signal: deadline },
    );
    assert.equal(turn.state, "done", JSON.stringify(turn));
    const [row] = await client.query(ai.turns.list, { threadId });
    assert.equal(row.sessionId, "no-bun-smoke");
    const messages = await client.query(chat.messages.list, { threadId });
    const reply = messages.find(({ _id }) => _id === row.replyId);
    assert.equal(reply.status, "complete");
    assert.equal(reply.parts[0].text, "Hello from the fake agent.");
    process.stdout.write(`fake-agent turn: ${turn.state}; ${reply.parts[0].text}\n`);
  }
} finally {
  await local?.close();
  socket?.close();
  if (runner) assert.equal(await runner.stop(), 0);
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
