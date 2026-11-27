import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editBundle, inspectHosts, reload, until } from "../support/routing.mjs";
import { runLocalTurn } from "../../plugins/ai/src/client/lib/local-turn.ts";
import { FORCE_STOP_MS, RELOADED } from "../../plugins/ai/src/shared/turn-timing.ts";
import { alive, gitPids, stall } from "./code-snapshot-review-cases.mjs";

export async function separateProcesses({ h, runner, desk, code, project, start, refs, turnRef }) {
  const { chat } = h.api;
  const hosts = await inspectHosts(runner);
  const host = (id) => hosts().find((process) => process.id === id)?.pid;
  const originalAi = host("ai");
  const originalCode = host("code");
  assert.ok(
    originalAi && originalCode && originalAi !== originalCode,
    "snapshots warm a separate code process",
  );

  const roots = await Promise.all([project("first-thread"), project("second-thread")]);
  const running = await Promise.all(
    roots.map(async ({ folder }, i) => {
      await writeFile(join(folder, "agent.txt"), `Before thread ${i}\n`);
      const thread = await start(desk, folder);
      const done = thread.run(thread.messageId, "edit");
      await thread.edited();
      return { thread, done };
    }),
  );
  for (const i of [1, 0]) {
    const { thread, done } = running[i];
    const { folder, git } = roots[i];
    await h.gate(folder, "go");
    const { turnId, state, hookNotice } = await done;
    assert.equal(state, "done");
    assert.equal(hookNotice, undefined);
    const prefix = turnRef(thread.threadId, turnId);
    assert.equal(git("show", `${prefix}/before:agent.txt`), `Before thread ${i}`);
    assert.equal(git("rev-parse", `${prefix}/after^`), git("rev-parse", `${prefix}/before`));
  }

  const crash = await project("code-process-crash");
  const crashedTurn = await start(desk, crash.folder);
  const interrupted = crashedTurn.run(crashedTurn.messageId, "edit");
  await crashedTurn.edited();
  process.kill(originalCode, "SIGKILL");
  await until("code's process exited", () => !alive(originalCode));
  // The replacement process must find the before ref without any in-memory state.
  await desk.action(code.hooks.prune, {});
  await h.gate(crash.folder, "go");
  const done = await interrupted;
  assert.deepEqual(done, { turnId: done.turnId, state: "done" });
  const recovered = turnRef(crashedTurn.threadId, done.turnId);
  assert.deepEqual(refs(crash.git), [`${recovered}/after`, `${recovered}/before`]);
  assert.equal(crash.git("rev-parse", `${recovered}/after^`), crash.git("rev-parse", `${recovered}/before`));
  assert.equal(host("ai"), originalAi);

  const updated = await project("code-process-reload");
  const reloadedTurn = await start(desk, updated.folder);
  const duringReload = reloadedTurn.run(reloadedTurn.messageId, "edit");
  await reloadedTurn.edited();
  const oldCode = host("code");
  await editBundle(join(h.plugins, "code"), "/* replacement local artifact */");
  await reload(runner, join(h.scratch, "snapshots"), "code");
  await desk.action(code.hooks.prune, {});
  assert.ok(hosts().some(({ id, pid }) => id === "code" && pid !== oldCode));
  await h.gate(updated.folder, "go");
  const finished = await duringReload;
  assert.deepEqual(finished, { turnId: finished.turnId, state: "done" });
  const reloaded = turnRef(reloadedTurn.threadId, finished.turnId);
  assert.equal(
    updated.git("rev-parse", `${reloaded}/after^`),
    updated.git("rev-parse", `${reloaded}/before`),
  );
  const newTurn = await reloadedTurn.run(await reloadedTurn.post(), "edit");
  assert.deepEqual(newTurn, { turnId: newTurn.turnId, state: "done" });
  assert.deepEqual(
    hosts()
      .filter(({ id }) => id === "ai")
      .map(({ pid }) => pid),
    [originalAi],
    "a new turn reuses the only ai process after changing Code",
  );
  await desk.action(chat.threads.removeLocal, { threadId: reloadedTurn.threadId });
  assert.deepEqual(refs(updated.git), [], "the deletion hook routes to the replacement code process");
  console.log(
    "code snapshots: overlapping turns, separate provider PID, code crash, code reload and routed deletion",
  );
}

export async function stopIsolation({ h, desk, project, start, refs, turnRef }) {
  const { ai } = h.api;
  const { folder, git } = await project("force-stop");
  const agent = await start(desk, folder);
  const running = agent.run(agent.messageId, "ignore-stop");
  const [turn] = await agent.turns.until("agent turn started", (rows) => rows.length === 1);
  await h.waitFor(folder, "process-tree.json");
  const agentPids = await Bun.file(join(folder, "process-tree.json")).json();
  const args = { turnId: turn._id };
  await desk.action(ai.run.stop, args);
  const [stopping] = await agent.turns.until("agent stopping", (rows) => !!rows[0]?.stoppingAt);

  const blocked = await project("stop-before");
  await stall(blocked);
  await blocked.write("agent.txt", "Start a slow before snapshot.\n");
  const hook = await start(desk, blocked.folder);
  const pending = hook.run(hook.messageId, "edit");
  const pids = await gitPids(blocked);
  await Bun.sleep(Math.max(0, stopping.stoppingAt + FORCE_STOP_MS - Date.now()));
  assert.equal(await desk.action(ai.run.forceStop, args), null);
  assert.ok(agentPids.every((pid) => !alive(pid)));
  assert.ok(pids.every(alive), "agent Force stop leaves the running hook's Git group alone");
  assert.deepEqual(await running, { turnId: turn._id, state: "stopped" });
  const prefix = turnRef(agent.threadId, turn._id);
  assert.deepEqual(refs(git, prefix), [`${prefix}/after`, `${prefix}/before`]);

  const [before] = await hook.turns.until("before hook is running", (rows) => rows.length === 1);
  await desk.action(ai.run.stop, { turnId: before._id });
  assert.deepEqual(await pending, { turnId: before._id, state: "stopped" });
  await until("Stop cancels the hook's Git group", () => pids.every((pid) => !alive(pid)));
  assert.deepEqual(refs(blocked.git), []);

  console.log("code snapshots: Force stop isolated agent programs; Stop cancelled before");
}

export async function windowOwnership({ h, desk, project, start }) {
  const { ai } = h.api;
  const { folder } = await project("window-ownership");
  const thread = await start(desk, folder);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const run = (windowId, messageId) =>
    desk.action(ai.run.turn, {
      windowId,
      threadId: thread.threadId,
      messageId,
      folder,
      agentId: "fake-agent",
      model: "ask-once",
      access: "ask",
    });
  const waiting = (messageId) =>
    thread.turns
      .until("permission question owned by its window", (rows) =>
        rows.some((row) => row.messageId === messageId && row.state === "waiting"),
      )
      .then((rows) => rows.find((row) => row.messageId === messageId));

  const running = run(first, thread.messageId);
  void running.catch(() => {});
  const turn = await waiting(thread.messageId);
  const question = { turnId: turn._id, questionId: turn.question.id };
  assert.equal(await desk.action(ai.run.pending, { windowId: first, ...question }), true);
  assert.equal(await desk.action(ai.run.pending, { windowId: second, ...question }), false);
  assert.equal(
    (await desk.action(ai.run.answer, { windowId: second, ...question, answer: "approve" })).kind,
    "Expired",
  );
  assert.equal((await desk.action(ai.run.stop, { windowId: second, turnId: turn._id })).kind, "NotRunning");
  assert.equal(
    (await desk.action(ai.run.steer, { windowId: second, turnId: turn._id, text: "Other window" })).kind,
    "NotRunning",
  );
  assert.deepEqual(await desk.action(ai.working.list, { windowId: second }), []);
  assert.equal(await desk.action(ai.working.stopAll, { windowId: second }), 0);
  assert.equal(
    await desk.action(ai.run.answer, { windowId: first, ...question, answer: "approveSession" }),
    null,
  );
  assert.equal((await running).state, "done");
  assert.equal((await run(first, await thread.post())).state, "done");

  const messageId = await thread.post();
  const afterReload = run(second, messageId);
  void afterReload.catch(() => {});
  const askedAgain = await waiting(messageId);
  assert.equal(
    await desk.action(ai.run.answer, {
      windowId: second,
      turnId: askedAgain._id,
      questionId: askedAgain.question.id,
      answer: "approve",
    }),
    null,
  );
  assert.equal((await afterReload).state, "done");
}

export async function reloadManager({ h, runner, desk, project, start }) {
  const { ai } = h.api;
  const waiting = await project("reload-during-question");
  const thread = await start(desk, waiting.folder);
  const running = desk.action(ai.run.turn, {
    threadId: thread.threadId,
    messageId: thread.messageId,
    folder: waiting.folder,
    agentId: "fake-agent",
    model: "ask-once",
    access: "ask",
  });
  void running.catch(() => {});
  const [turn] = await thread.turns.until("agent is waiting", (rows) => rows[0]?.state === "waiting");
  const hosts = await inspectHosts(runner);
  const fake = hosts().find(({ id }) => id === "fake-agent");
  assert.ok(fake);
  const children = Bun.spawnSync(["ps", "-ww", "-axo", "pid=,ppid=,command="])
    .stdout.toString()
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 3))
    .filter(([, parent]) => Number(parent) === fake.pid)
    .map(([pid]) => Number(pid));
  assert.ok(children.length, "the waiting agent has a program to reap");

  const blocked = await project("reload-during-before");
  await stall(blocked);
  await blocked.write("agent.txt", "Stall the before snapshot.\n");
  const hook = await start(desk, blocked.folder);
  const before = hook.run(hook.messageId, "edit");
  void before.catch(() => {});
  const git = await gitPids(blocked);

  await editBundle(join(h.plugins, "ai"), "/* replaced while waiting for permission */");
  await reload(runner, join(h.scratch, "snapshots"), "ai");
  const why = "AI was reloaded while the turn was running.";
  assert.deepEqual(await running, { turnId: turn._id, state: "interrupted", ended: why });
  const lostBefore = await before;
  assert.equal(lostBefore.state, "interrupted");
  assert.equal(lostBefore.hookNotice, why);
  const row = await thread.reply(turn._id);
  assert.equal(row.state, "interrupted");
  assert.equal(row.error, why);
  assert.equal(row.question, undefined);
  assert.equal((await desk.action(ai.run.stop, { turnId: turn._id })).kind, "NotRunning");
  const question = { turnId: turn._id, questionId: turn.question.id };
  assert.equal(await desk.action(ai.run.pending, question), false);
  assert.equal((await desk.action(ai.run.answer, { ...question, answer: "approve" })).kind, "Expired");
  assert.deepEqual(await desk.action(ai.working.list, {}), []);
  assert.equal(await desk.action(ai.working.stopAll, {}), 0);
  await until("AI reload reaped the agent and Git", () => [...children, ...git].every((pid) => !alive(pid)));
  await h.gate(waiting.folder, "go");
  assert.equal((await thread.run(await thread.post(), "edit")).state, "done");
  console.log(
    "code snapshots: AI reload interrupted a waiting turn and a before hook, reaped both programs, and freed the thread",
  );
}

export async function reloadManagerTimeout({ h, runner, desk, project, start }) {
  const { ai } = h.api;
  const { folder } = await project("reload-timeout");
  const thread = await start(desk, folder);
  const plugin = join(h.plugins, "ai");
  const workspace = join(h.scratch, "snapshots");
  const original = await readFile(join(plugin, "local.js"), "utf8");
  const finish = "state = await ctx.runMutation(api.turns.finish,";
  assert.ok(original.includes(finish));
  // Hold finish inside the retired build, so the test works when the action
  // reaches the Runner directly without passing through a window worker.
  await editBundle(plugin, 'import { writeFile as markFinish } from "node:fs/promises";', (code) =>
    code.replace(
      finish,
      `await markFinish(${JSON.stringify(join(folder, "finish-attempted"))}, "");
       await new Promise(() => {});
       ${finish}`,
    ),
  );
  await reload(runner, workspace, "ai");
  const hosts = await inspectHosts(runner);
  const running = runLocalTurn(desk, {
    threadId: thread.threadId,
    messageId: thread.messageId,
    folder,
    agentId: "fake-agent",
    model: "ask-once",
    access: "ask",
  });
  void running.catch(() => {});
  const [turn] = await thread.turns.until(
    "the agent asks permission",
    (rows) => rows[0]?.state === "waiting",
  );
  const old = hosts().find(({ id }) => id === "ai");
  assert.ok(old);
  assert.equal(
    await desk.mutation(ai.liveness.releaseReloaded, {
      messageId: thread.messageId,
      replyToken: "another invocation",
    }),
    false,
  );
  await editBundle(plugin, "", () => original);
  await reload(runner, workspace, "ai");
  await h.waitFor(folder, "finish-attempted");
  assert.deepEqual(await running, { state: "interrupted", ended: RELOADED });
  const row = await thread.reply(turn._id);
  assert.equal(row.state, "interrupted");
  assert.equal(row.error, RELOADED);
  assert.equal(row.question, undefined);
  await until("the Runner closed the stuck retired host", () => !alive(old.pid));
  await h.gate(folder, "go");
  const messageId = await thread.post();
  const replyToken = "01".repeat(32);
  const next = await desk.action(ai.run.turn, {
    threadId: thread.threadId,
    messageId,
    replyToken,
    folder,
    agentId: "fake-agent",
    model: "edit",
  });
  assert.equal(next.state, "done");
  assert.equal(await desk.mutation(ai.liveness.releaseReloaded, { messageId, replyToken }), "ended");
  assert.equal((await thread.reply(next.turnId)).state, "done");
  console.log("code snapshots: the window saved the reload reason when old AI could not finish");
}

export async function stopDuringAfter({ h, desk, project, start, refs, turnRef }) {
  const { ai } = h.api;
  const final = await project("stop-after");
  const after = await start(desk, final.folder);
  const finishing = after.run(after.messageId, "edit");
  await after.edited();
  await stall(final, "while [ ! -f .git/release-filter ]; do sleep 0.05; done");
  await h.gate(final.folder, "go");
  const afterPids = await gitPids(final);
  const [last] = await after.turns.until("after hook is running", (rows) => rows.length === 1);
  for (let i = 0; i < 2; i++) {
    const result = await desk.action(ai.run.stop, { turnId: last._id });
    assert.equal(result.kind, "NotRunning", "Stop cannot change a turn whose agent has settled");
    assert.equal(result.data.finishing, true, "the window shows no notice for a turn that is only finishing");
  }
  assert.ok(afterPids.every(alive), "Stop leaves the after hook's Git group alone");
  await final.write(".git/release-filter", "");
  assert.deepEqual(await finishing, { turnId: last._id, state: "done" });
  const saved = turnRef(after.threadId, last._id);
  assert.deepEqual(refs(final.git), [`${saved}/after`, `${saved}/before`]);
  console.log("code snapshots: repeated Stop left the after hook and turn outcome alone");
}

export async function unavailableProviders({ h, runner, desk, code, project, start, refs }) {
  const { chat } = h.api;
  const hosts = await inspectHosts(runner);
  const { folder, git, write } = await project("code-outage");
  const cached = await start(desk, folder);
  await stall({ folder, git, write });
  await write("agent.txt", "before the crash\n");
  await h.gate(folder, "go");
  const crashed = cached.run(cached.messageId, "edit");
  const pids = await gitPids({ folder });
  const owner = Number(Bun.spawnSync(["ps", "-ww", "-o", "ppid=", "-p", String(pids[0])]).stdout.toString());
  const codeHost = hosts().find(({ id, pid }) => id === "code" && pid === owner);
  assert.ok(codeHost, "the cached hook's Git process belongs to the Code host being killed");
  process.kill(codeHost.pid, "SIGKILL");
  const afterCrash = await crashed;
  assert.deepEqual(afterCrash, {
    turnId: afterCrash.turnId,
    state: "done",
    hookNotice: "Couldn't save this turn's code",
  });
  const { ai } = h.api;
  const [{ replyId }] = await desk.query(ai.turns.list, { threadId: cached.threadId });
  const reply = (await desk.query(chat.messages.list, { threadId: cached.threadId })).find(
    ({ _id }) => _id === replyId,
  );
  assert.equal(reply.status, "complete");
  assert.equal(reply.parts[0]?.text, "I edited agent.txt.");
  assert.deepEqual(refs(git), []);
  await until("crashed Code's Git group exited", () => pids.every((pid) => !alive(pid)));

  const installed = join(h.plugins, "code");
  const original = await readFile(join(installed, "local.js"), "utf8");
  // Keep Code's declaration available while making the new build fail to start.
  await editBundle(
    installed,
    "",
    (code) => `throw new Error("Code cannot start");
${code}`,
  );
  await reload(runner, join(h.scratch, "snapshots"), "code");
  const cold = await project("first-code-lookup");
  const fresh = await start(desk, cold.folder);
  await h.gate(cold.folder, "go");
  const first = await fresh.run(fresh.messageId, "edit");
  assert.deepEqual(first, {
    turnId: first.turnId,
    state: "done",
    hookNotice: "Couldn't save this turn's code",
  });
  assert.deepEqual(refs(cold.git), []);

  const cleanup = await project("unreachable-deletion");
  const doomed = await start(desk, cleanup.folder);
  // Record a real pair for the existing prune retry, then take this build down again.
  await editBundle(installed, "/* working before deletion */", () => original);
  await reload(runner, join(h.scratch, "snapshots"), "code");
  await h.gate(cleanup.folder, "go");
  assert.equal((await doomed.run(doomed.messageId, "edit")).hookNotice, undefined);
  assert.equal(refs(cleanup.git).length, 2);
  await editBundle(
    installed,
    "",
    (code) => `throw new Error("Code cannot start during deletion");
${code}`,
  );
  await reload(runner, join(h.scratch, "snapshots"), "code");
  assert.deepEqual(await desk.action(chat.threads.removeLocal, { threadId: doomed.threadId }), {
    warning: "The thread was deleted, but some of its local data couldn't be removed.",
  });
  assert.equal(await desk.query(chat.threads.get, { threadId: doomed.threadId }), null);
  assert.equal(refs(cleanup.git).length, 2);
  await editBundle(installed, "/* recovered from deletion outage */", () => original);
  await reload(runner, join(h.scratch, "snapshots"), "code");
  await desk.action(code.hooks.prune, {});
  assert.deepEqual(refs(cleanup.git), []);
  console.log(
    "code snapshots: crashed cached hook, failed first lookup and deletion outage with prune retry",
  );
}

export async function cancelledCleanup({ h, desk, project, start, refs }) {
  const { chat } = h.api;
  const { folder, git, write } = await project("cancel-packed-deletion");
  const thread = await start(desk, folder);
  await h.gate(folder, "go");
  assert.equal((await thread.run(thread.messageId, "edit")).state, "done");
  git("pack-refs", "--all", "--prune");
  assert.equal(refs(git).length, 2);

  // For this fixture only, pause real Git at its prepared transaction hook
  // while it owns the packed refs lock. Production still disables user hooks.
  const shim = join(h.bin, "git");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    shim,
    `#!/bin/sh
if [ "$PWD" = ${quote(folder)} ]; then
  case " $* " in
    *" update-ref --no-deref --stdin "*) exec /usr/bin/git -c core.hooksPath=.git/hooks update-ref --no-deref --stdin ;;
  esac
fi
exec /usr/bin/git "$@"
`,
  );
  await chmod(shim, 0o755);
  await write(
    ".git/hooks/reference-transaction",
    `#!/bin/sh
if [ "$1" = prepared ] && [ -f .git/packed-refs.lock ]; then
  : > .git/cleanup-locked
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ -f .git/release-cleanup ] && break
    sleep 1
  done
fi
cat >/dev/null
`,
  );
  await chmod(join(folder, ".git/hooks/reference-transaction"), 0o755);
  const fileExists = (path) =>
    stat(join(folder, path)).then(
      () => true,
      () => false,
    );
  const controller = new AbortController();
  const removing = desk.action(
    chat.threads.removeLocal,
    { threadId: thread.threadId },
    { signal: controller.signal },
  );
  await until("Git holds the packed refs lock", () => fileExists(".git/cleanup-locked"));
  assert.ok(await fileExists(".git/packed-refs.lock"));
  controller.abort();
  await assert.rejects(removing, /cancelled/);
  await write(".git/release-cleanup", "");
  await until(
    "Git completes the deletion and unlocks its refs",
    async () => !(await fileExists(".git/packed-refs.lock")) && refs(git).length === 0,
  );
  assert.equal(await desk.query(chat.threads.get, { threadId: thread.threadId }), null);
  console.log("code snapshots: cancellation lets Git release its packed refs lock");
}

export async function managerCrash({ h, runner, desk, code: codeApi, project, start, refs, turnRef }) {
  const { ai } = h.api;
  const hosts = await inspectHosts(runner);
  const agent = await project("manager-crash-agent");
  const agentThread = await start(desk, agent.folder);
  const agentDone = assert.rejects(
    agentThread.run(agentThread.messageId, "ignore-stop"),
    /Plugin ai process:/,
  );
  void agentDone.catch(() => {});
  await h.waitFor(agent.folder, "process-tree.json");
  const agentPids = await Bun.file(join(agent.folder, "process-tree.json")).json();
  assert.ok(agentPids.length > 1 && agentPids.every(alive));
  const [running] = await agentThread.turns.until("agent turn is running", (rows) => rows.length === 1);
  const abandoned = turnRef(agentThread.threadId, running._id);
  assert.deepEqual(refs(agent.git), [`${abandoned}/before`]);

  const hook = await project("manager-crash-hook");
  await stall(hook);
  await hook.write("agent.txt", "Wait inside the before snapshot.\n");
  const hookThread = await start(desk, hook.folder);
  const hookDone = assert.rejects(hookThread.run(hookThread.messageId, "edit"), /Plugin ai process:/);
  void hookDone.catch(() => {});
  const hookPids = await gitPids(hook);

  const manager = hosts().find(({ id }) => id === "ai");
  const code = hosts().find(({ id }) => id === "code");
  assert.ok(manager && code);
  process.kill(manager.pid, "SIGKILL");
  await Promise.all([agentDone, hookDone]);
  await until("the agent and hook groups die after ai exits", () =>
    [...agentPids, ...hookPids].every((pid) => !alive(pid)),
  );
  assert.ok(alive(code.pid), "cancellation leaves Code's host up");
  assert.deepEqual(refs(agent.git), [`${abandoned}/before`]);
  // Reopen recovery waits until the old invocation has missed a heartbeat.
  await until(
    "the restarted local part can recover its orphaned turn",
    async () => (await desk.mutation(ai.liveness.release, { running: [] })) === 0,
    25_000,
  );
  const notice = () =>
    desk.action(codeApi.notices.forTurn, {
      threadId: agentThread.threadId,
      turnId: running._id,
    });
  const interruptedSnapshot = { omitted: [], warning: "Couldn't save this turn's code" };
  assert.deepEqual(await notice(), interruptedSnapshot);
  await h.gate(agent.folder, "go");
  const next = await agentThread.run(await agentThread.post(), "edit");
  assert.equal(next.state, "done");
  const saved = turnRef(agentThread.threadId, next.turnId);
  assert.deepEqual(refs(agent.git), [`${abandoned}/before`, `${saved}/after`, `${saved}/before`].sort());
  assert.deepEqual(await notice(), interruptedSnapshot);
  console.log(
    "code snapshots: ai crash reaped the agent and hook; the interrupted snapshot and warning survived the next turn",
  );
}
