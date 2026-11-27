// End to end for a turn whose app went away (see e2e/fake-agent): the real
// server, real windows and local parts, and the replay program. While a turn
// runs, the sender's local part sends a sign of life; after 45 seconds of
// silence the server ends the turn as interrupted ("Tokamak was closed"),
// keeps the reply so far and frees the thread. A slow agent in an open app is
// never interrupted, however long it is quiet.
//
// The 45 seconds are a constant of ai's server code, which a test cannot
// change on the real server, so this waits them out for real: twice in a row
// (a running turn, then the queue stranded behind it), with the lost-server
// case alongside. Allow about two minutes in the offline server suite.
import assert from "node:assert/strict";
import { isFailure } from "../../node_modules/@tokamak/sdk/src/index.ts";
import { BEAT_MS, RELOADED, SILENCE_MS } from "../../plugins/ai/src/shared/turn-timing.ts";
import { cp, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { agentHarness, connect, watchQuery } from "../fake-agent/harness.mjs";
import { startRunner } from "../fake-agent/start-runner.ts";
import { editBundle, inspectHosts } from "../support/routing.mjs";

import { runLocalTurn } from "../../plugins/ai/src/client/lib/local-turn.ts";

const h = await agentHarness({ binary: process.argv[2], name: "ai-liveness" });
const { ai, chat } = h.api;
const AGENT = { id: "fake-agent", name: "Fake agent" };
const replyOf = (turn) => (messages) => messages.find((message) => message._id === turn.replyId);
/** Allow for the server's sweep and slower scheduling under CI load. */
const NOTICED_MS = SILENCE_MS + 30_000;

try {
  // The lost server and a crashed ai host wait out their deadlines alongside.
  const scenarios = [lostServer(), crashedApp(), windowReloadTimeout()];
  const binary = process.env.TOKAMAK_TEST_RUNNER_BIN;
  if (binary) scenarios.push(crashedManager(binary));
  await Promise.all(scenarios);
  console.log(
    "ai liveness: killed app interrupted after 45 s with its reply kept, waiting question ended, stranded queue settled, slow turn kept running, thread free again, agent stopped when the server stays out of reach",
  );
} finally {
  await h.close();
}

/** A shared server dispatches the action through the caller’s window and attached desktop Runner. */
async function windowReloadTimeout() {
  const pluginsDir = join(h.scratch, "window-reload-plugins");
  await cp(h.plugins, pluginsDir, { recursive: true });
  const plugin = join(pluginsDir, "ai");
  const original = await readFile(join(plugin, "local.js"), "utf8");
  const finish = "state = await ctx.runMutation(api.turns.finish,";
  assert.ok(original.includes(finish));
  await editBundle(plugin, "", (code) => code.replace(finish, `await new Promise(() => {}); ${finish}`));
  const address = await h.serve("window-reload", { shared: true, pluginsDir, windowRouted: true });
  const desk = await h.connect(address, {
    token: await h.ownerDevice(address, "Reloading window"),
    local: true,
    pluginsDir,
  });
  const folder = await h.folder("window-reload");
  const { threadId, messageId } = await desk.mutation(chat.threads.start, {
    text: "Wait for permission",
    folder: { kind: "chosen", path: folder },
  });
  const turns = h.watch(desk, ai.turns.list, { threadId });
  const running = runLocalTurn(desk, {
    threadId,
    messageId,
    folder,
    agentId: AGENT.id,
    model: "ask-once",
    access: "ask",
  });
  void running.catch(() => {});
  await turns.until("window-routed caller action opens a question", (rows) => rows[0]?.state === "waiting");

  await editBundle(plugin, "", () => original);
  const route = new URL("/plugins/ai/reload", address.replace(/^ws:/, "http:"));
  const response = await fetch(route, {
    method: "POST",
    headers: { Authorization: "Bearer " + h.ownerToken },
  });
  assert.equal(response.status, 200, await response.text());

  assert.deepEqual(await running, { state: "interrupted", ended: RELOADED });
  const [row] = await turns.until(
    "the window settles the timed-out turn",
    (rows) => rows[0]?.state === "interrupted",
  );
  assert.equal(row.error, RELOADED);
  assert.equal(row.question, undefined);
}

/** Kill only the manager host. Leave the window attached and let maintenance free its thread. */
async function crashedManager(binary) {
  const runner = await startRunner({
    binary,
    plugins: h.plugins,
    directory: join(h.scratch, "manager-crash"),
    env: {
      HOME: h.home,
      PATH: [h.bin, "/usr/bin", "/bin"].join(delimiter),
    },
  });
  const cleanup = [];
  try {
    const hosts = await inspectHosts(runner);
    const manager = () => hosts().find(({ id }) => id === "ai")?.pid;
    const window = await connect(runner.endpoint.ws, {
      token: runner.endpoint.token,
      launch: runner.launch,
      cleanup,
    });
    const folder = await h.folder("manager-turn");
    const { threadId, messageId } = await window.mutation(chat.threads.start, {
      text: "Ask first",
      folder: { kind: "chosen", path: folder },
    });
    const invoke = (messageId, model, access) =>
      window.action(ai.run.turn, { threadId, messageId, folder, agentId: AGENT.id, model, access });
    const stopped = assert.rejects(invoke(messageId, "ask-once", "ask"), /Plugin ai process:/);
    void stopped.catch(() => {});
    const turns = watchQuery(window, ai.turns.list, { threadId }, cleanup);
    const [waiting] = await turns.until(
      "the manager's open question",
      (rows) => rows[0]?.state === "waiting",
    );
    const pid = manager();
    assert.ok(pid);
    const killedAt = Date.now();
    process.kill(pid, "SIGKILL");
    await stopped;
    assert.deepEqual(await window.action(ai.working.list, {}), []);
    assert.ok(manager() && manager() !== pid, "ai restarted while the window remained connected");
    const [ended] = await turns.until(
      "maintenance interrupts the turn whose manager crashed",
      (rows) => rows[0]?._id === waiting._id && rows[0].state === "interrupted",
      NOTICED_MS,
    );
    const waited = Date.now() - killedAt;
    assert.ok(waited >= SILENCE_MS - BEAT_MS);
    assert.equal(ended.question, undefined);
    assert.equal(ended.error, "Tokamak was closed");
    const next = await window.mutation(chat.messages.post, { threadId, text: "Carry on" });
    await h.gate(folder, "go");
    assert.equal((await invoke(next, "slow", "full")).state, "done");
    console.log(
      `Server maintenance freed the connected window's thread ${(waited / 1000).toFixed(1)} s after ai's host died.`,
    );
  } finally {
    for (const close of cleanup.reverse()) await close();
    assert.equal(await runner.stop(), 0);
  }
}

async function crashedApp() {
  const address = await h.serve("liveness");
  // Two apps on the person's computer: one crashes mid-turn, the other stays open.
  const crashing = await h.connect(address, { local: true });
  const open = await h.connect(address, { local: true });
  const watcher = await h.connect(address);

  /** A new thread with its first message sent from `client`, and its turn started there. */
  async function startTurn(client, label, model, more = {}) {
    const folder = await h.folder(label);
    const { threadId, messageId } = await client.mutation(chat.threads.start, {
      text: `Work on ${label}`,
      folder: { kind: "chosen", path: folder },
    });
    const running = client.action(ai.run.turn, {
      threadId,
      messageId,
      folder,
      agentId: AGENT.id,
      model,
      ...more,
    });
    void running.catch(() => {});
    const turns = h.watch(watcher, ai.turns.list, { threadId });
    const messages = h.watch(watcher, chat.messages.list, { threadId });
    return { folder, threadId, running, turns, messages };
  }

  // A running turn that has written part of its reply, a turn waiting on a
  // permission question with a message queued behind it, and a slow turn in the open app.
  const writing = await startTurn(crashing, "writing", "echo");
  const asking = await startTurn(crashing, "asking", "ask-once", { access: "ask" });
  const slow = await startTurn(open, "slow", "slow");
  const [written] = await writing.turns.until("running turn", (list) => list[0]?.state === "running");
  await writing.messages.until(
    "partial reply",
    (list) => replyOf(written)(list)?.parts[0]?.text === "Reading your message.",
  );
  const [waiting] = await asking.turns.until("waiting turn", (list) => list[0]?.state === "waiting");
  assert.equal(waiting.question.subject, "git push origin feat/csv-export");
  const queued = await crashing.mutation(ai.turns.enqueue, {
    threadId: asking.threadId,
    text: "Then push the tag",
    agent: AGENT,
    model: "echo",
    access: "full",
  });
  const [slowTurn] = await slow.turns.until("slow turn running", (list) => list[0]?.state === "running");

  // The first app dies with its turns on the go: nobody calls finish.
  await h.quit(crashing);
  const quitAt = Date.now();

  // Not before the silence limit: the last sign of life came at most one beat before the quit.
  await Bun.sleep(SILENCE_MS - BEAT_MS - 5_000);
  assert.equal((await watcher.query(ai.turns.list, { threadId: writing.threadId }))[0].state, "running");

  const [interrupted] = await writing.turns.until(
    "interrupted after the silence",
    (list) => list[0].state === "interrupted",
    NOTICED_MS,
  );
  const silence = Date.now() - quitAt;
  assert.ok(silence >= SILENCE_MS - BEAT_MS && silence <= NOTICED_MS, `interrupted after ${silence} ms`);
  assert.equal(interrupted.error, "Tokamak was closed");
  assert.ok(interrupted.finishedAt >= interrupted.startedAt);
  // The reply so far is kept, and marked as interrupted with its reason.
  const kept = replyOf(interrupted)(await watcher.query(chat.messages.list, { threadId: writing.threadId }));
  assert.equal(kept.status, "interrupted");
  assert.equal(kept.error, "Tokamak was closed");
  assert.equal(kept.parts[0].text, "Reading your message.");

  // The waiting turn ends the same way and its question is gone.
  const [ended] = await asking.turns.until(
    "waiting turn interrupted",
    (list) => list[0].state === "interrupted",
  );
  assert.equal("question" in ended, false);
  assert.deepEqual(await open.query(ai.turns.questions, {}), []);

  // The slow turn in the open app was quiet just as long, and still runs.
  const [still] = await slow.turns.until("slow turn", () => true);
  assert.equal(still.state, "running", "a slow but alive turn is never interrupted");
  assert.ok(Date.now() - slowTurn.startedAt > SILENCE_MS);

  // The thread is free: the open app begins a new turn in it at once.
  const next = await open.mutation(chat.messages.post, { threadId: writing.threadId, text: "Carry on" });
  const resumed = await open.action(ai.run.turn, {
    threadId: writing.threadId,
    messageId: next,
    folder: writing.folder,
    agentId: AGENT.id,
    model: "fail",
  });
  assert.ok(!isFailure(resumed), `a new turn begins: ${JSON.stringify(resumed)}`);
  assert.equal(resumed.state, "failed");

  // The message queued in the crashed app is left with nobody to start it.
  // Once its thread has been free for the same 45 seconds, it is settled too,
  // so the thread does not stay blocked behind it.
  const settled = await asking.turns.until(
    "stranded queue settled",
    (list) => list.find((turn) => turn._id === queued.turnId)?.state === "interrupted",
    NOTICED_MS,
  );
  assert.equal(settled.find((turn) => turn._id === queued.turnId).error, "Tokamak was closed");
  const delivered = (await watcher.query(chat.messages.list, { threadId: asking.threadId })).find(
    (message) => message._id === queued.messageId,
  );
  assert.notEqual(delivered.status, "queued", "the dashed message is no longer queued");
  assert.equal(await watcher.query(ai.turns.pending, { threadId: asking.threadId }), null);

  // The slow turn finishes normally when its agent is done.
  assert.equal((await watcher.query(ai.turns.list, { threadId: slow.threadId }))[0].state, "running");
  await h.gate(slow.folder, "go");
  assert.equal((await slow.running).state, "done");
}

/**
 * The other way round: the app stays open but cannot reach the server (it
 * crashed, the network went). After the same 45 seconds without a beat getting
 * through, the app stops its agent, so nothing keeps working into a turn the
 * server has given up on, even an agent that ignores Stop and its children.
 */
async function lostServer() {
  const address = await h.serve("lost");
  const desk = await h.connect(address, { local: true });
  const folder = await h.folder("lost");
  const { threadId, messageId } = await desk.mutation(chat.threads.start, {
    text: "Keep going",
    folder: { kind: "chosen", path: folder },
  });
  const running = desk.action(ai.run.turn, {
    threadId,
    messageId,
    folder,
    agentId: AGENT.id,
    model: "ignore-stop",
  });
  void running.catch(() => {});
  const turns = h.watch(desk, ai.turns.list, { threadId });
  const [turn] = await turns.until("running turn", (list) => list[0]?.state === "running");
  const pids = await within(async () =>
    JSON.parse(await readFile(join(folder, "process-tree.json"), "utf8")),
  );
  assert.equal(pids.length, 3);
  // Let the agent's first write land before testing heartbeat loss. A failed
  // reply write stops the agent independently of the heartbeat deadline.
  await h
    .watch(desk, chat.messages.list, { threadId })
    .until(
      "partial reply saved",
      (list) => replyOf(turn)(list)?.parts[0]?.text === "Partial reply from a stuck agent.",
    );
  await h.halt(address);
  const cutOff = Date.now();
  await Bun.sleep(SILENCE_MS - BEAT_MS);
  assert.ok(pids.every(alive), "the agent runs on while the server may still come back");
  const deadline = cutOff + NOTICED_MS;
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(500);
  assert.deepEqual(
    pids.filter(alive),
    [],
    "the agent and its children are stopped once the server stays out of reach",
  );
}

/** Retries `read` until it stops throwing (a file the agent writes a moment later). */
async function within(read, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() > until) throw error;
      await Bun.sleep(100);
    }
  }
}

/** Whether a process still runs (a zombie waiting for its parent counts as gone). */
function alive(pid) {
  const stat = Bun.spawnSync(["ps", "-ww", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return stat !== "" && !stat.startsWith("Z");
}
