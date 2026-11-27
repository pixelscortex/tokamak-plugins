import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { within } from "../../../tests/fake-agent/harness.mjs";
import { FORCE_STOP_MS } from "../../ai/src/shared/turn-timing.ts";

function alive(pid) {
  const stat = Bun.spawnSync(["ps", "-ww", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return !!stat && !stat.startsWith("Z");
}

export function overlappingHello(h, run, prompt) {
  return async (name, exercise) => {
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    const folder = await h.folder(`claude-hello-${name}`);
    const other = run(`hello-${name}`, prompt, {
      async during(turn) {
        assert.equal((await turn.firstText()).parts[0].text, "Hello Tokamak");
        ready.resolve();
        await release.promise;
        await h.gate(folder, "go");
      },
    });
    void other.catch(ready.reject);
    try {
      await within(ready.promise, `overlapping hello: ${name}`);
      const pid = Number(await readFile(join(folder, "claude.pid"), "utf8"));
      assert.ok(alive(pid));
      await exercise();
      assert.ok(alive(pid), `${name} left the other CLI running`);
    } finally {
      release.resolve();
    }
    const completed = await other;
    assert.equal(completed.text, "Hello Tokamak.");
    assert.equal(completed.row.sessionId, "ed0f9193-a023-4ab1-a74c-a8bba2877dc3");
    assert.deepEqual(completed.reply.usage, {
      inputTokens: 27422,
      cachedInputTokens: 27420,
      outputTokens: 11,
      costUsd: 0.002856,
    });
    return completed;
  };
}

export async function resistantTurns({ h, client, hello, overlap, wire }) {
  const { ai, chat } = h.api;
  for (const action of ["force", "cancel"]) {
    await overlap(action, async () => {
      const folder = await h.folder(`claude-resistant-${action}`);
      const { threadId, messageId } = await client.mutation(chat.threads.start, {
        text: hello,
        folder: { kind: "chosen", path: folder },
      });
      const turns = h.watch(client, ai.turns.list, { threadId });
      const messages = h.watch(client, chat.messages.list, { threadId });
      const controller = new AbortController();
      const held = action === "cancel" ? wire.hold("Hello Tokamak") : undefined;
      try {
        const running = client.action(
          ai.run.turn,
          { threadId, messageId, folder, agentId: "claude", model: "sonnet", effort: "low" },
          { signal: controller.signal },
        );
        void running.catch(() => {});
        const [row] = await turns.until("resistant turn started", (rows) => rows.length === 1);
        await messages.until("resistant turn's first write", (rows) =>
          rows.some((msg) => msg._id === row.replyId && msg.parts[0]?.text === "Hello Tokamak"),
        );
        await held?.pending();
        await h.waitFor(folder, "process-tree.json");
        const pids = JSON.parse(await readFile(join(folder, "process-tree.json"), "utf8"));
        assert.equal(new Set(pids).size, 3);
        assert.ok(pids.every(alive));
        const args = { turnId: row._id };
        if (action === "force") {
          assert.equal(await client.action(ai.run.stop, args), null);
          assert.equal((await client.action(ai.run.forceStop, args)).kind, "TooEarly");
          const [stopping] = await turns.until("stop requested", ([turn]) => !!turn?.stoppingAt);
          await Bun.sleep(Math.max(0, stopping.stoppingAt + FORCE_STOP_MS - Date.now()));
          assert.ok(
            pids.every(alive),
            "the deadline makes Force stop available; it does not kill the program",
          );
          assert.equal(await client.action(ai.run.forceStop, args), null);
          assert.deepEqual(await within(running, "forced turn returns"), { ...args, state: "stopped" });
        } else {
          controller.abort();
          await assert.rejects(within(running, "cancelled turn returns"), /cancel/i);
          held.release();
        }
        const deadline = Date.now() + 3000;
        while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(20);
        assert.ok(!pids.some(alive), `${action} killed the resistant CLI and its descendants`);
        const [stored] = await client.query(ai.turns.list, { threadId });
        const message = (await client.query(chat.messages.list, { threadId })).find(
          (m) => m._id === row.replyId,
        );
        const state = action === "force" ? "stopped" : "running";
        assert.equal(stored.state, state);
        assert.equal(message.status, action === "force" ? "cancelled" : "streaming");
        assert.equal(message.parts[0].text, "Hello Tokamak");
      } finally {
        held?.release();
        controller.abort();
      }
    });
  }
}
