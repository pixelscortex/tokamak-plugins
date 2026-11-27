import { testModules, testWindowConfig } from "../support/paths.mjs";
// End to end for ai's turns with the fake agent (see e2e/fake-agent): the real
// server, real windows, the real local part and the replay program. Checks
// what a person and a plugin author see: the agent offered, the reply
// streaming into the thread, the turn row, one writer per thread, and that
// nobody but the sender's own device can write to a turn. Later agent
// tickets extend this; add replays and fake agents rather than editing these.
import assert from "node:assert/strict";
import { cp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { authCaller, createApi, isFailure } from "../../node_modules/@tokamak/sdk/src/index.ts";
import { FORCE_STOP_MS } from "../../plugins/ai/src/shared/turn-timing.ts";
import { agentHarness, build, copySource, within, workspace } from "../fake-agent/harness.mjs";
import { checkProfileTurns } from "../fake-agent/profile-turns.mjs";
import { checkLaunchSettings } from "../fake-agent/launch-settings.mjs";

const h = await agentHarness({ binary: process.argv[2], name: "ai-turns" });
const { ai, chat } = h.api;
const probe = createApi("ai", ["probe:rows"]).probe;
await installRowsProbe();
const AGENT = { id: "fake-agent", name: "Fake agent" };
const replyOf = (turn) => (messages) => messages.find((message) => message._id === turn.replyId);

try {
  await h.assertLocalRuntime();
  await localServer();
  await reportsReachTheReply();
  await steerTurn();
  await noSteerHandler();
  await stopTurns();
  await queueTurns();
  await permissions();
  await sharedServer();
  await withoutAgents();
  await checkLaunchSettings(h);
  const profileHarness = await agentHarness({
    binary: process.env.TOKAMAK_TEST_RUNNER_BIN,
    name: "profile-turns",
  });
  try {
    await checkProfileTurns(profileHarness);
  } finally {
    await profileHarness.close();
  }
  console.log(
    "ai turns: agent listed, reply streamed, reports stored, one writer, steer, FIFO queue, graceful stop, force-stopped process group, permission questions, sender's device only, no agent, launch settings",
  );
} finally {
  await h.close();
}

/** The local server: the person is the owner. One window runs turns, another watches. */
async function localServer() {
  const address = await h.serve("local");
  const desk = await h.connect(address, { local: true });
  const other = await h.connect(address);

  // The agent row's list: the fake agent, installed and signed in, each replay a model.
  const listed = (await desk.action(ai.agents.list, {})).find((agent) => agent.id === AGENT.id);
  assert.equal(listed?.name, AGENT.name);
  // The mark the agent plugin registered (`Agent.icon`) reaches the window as SVG text.
  assert.match(listed.icon ?? "", /^<svg[^>]*viewBox="0 0 24 24"[\s\S]*<path d="M/);
  assert.equal(listed.info.installed && listed.info.signedIn, true);
  const models = listed.info.models.map((model) => model.id);
  assert.ok(models.includes("echo") && models.includes("fail"), `replays offered as models: ${models}`);

  // A Send: chat stores the message; the window then runs the turn on this computer.
  const project = await h.folder("invoices-app");
  const typed = 'Fix the "totals" ✓\n  keep   these spaces\tand tabs';
  const sent = await desk.mutation(chat.threads.start, {
    text: typed,
    folder: { kind: "chosen", path: project },
  });
  const turns = h.watch(other, ai.turns.list, { threadId: sent.threadId });
  const messages = h.watch(other, chat.messages.list, { threadId: sent.threadId });
  const run = (messageId, model, more = {}) =>
    desk.action(ai.run.turn, {
      threadId: sent.threadId,
      messageId,
      folder: project,
      agentId: AGENT.id,
      model,
      ...more,
    });
  const running = run(sent.messageId, "echo", { access: "ask", mode: "not-offered" });

  // The turn row records sender and device, agent, model and access, and keeps chat's reply capability to itself.
  const [turn] = await turns.until("running turn", (list) => list.length === 1);
  assert.equal(turn.state, "running");
  assert.equal(turn.messageId, sent.messageId);
  assert.equal(turn.sender.id, "local");
  assert.equal(turn.sender.name, "Sam");
  assert.equal(typeof turn.sender.device, "string");
  assert.deepEqual(turn.agent, AGENT);
  assert.equal(turn.model, "echo");
  assert.equal(turn.access, "ask");
  assert.equal(turn.mode, "default", "a mode the agent does not offer falls back to its first");
  assert.equal("replyToken" in turn, false);

  // The reply streams: the other window sees the first part while the agent still works.
  const partial = replyOf(turn)(
    await messages.until("first part of the reply", (list) => replyOf(turn)(list)?.parts.length > 0),
  );
  assert.equal(partial.status, "streaming");
  assert.equal(partial.role, "assistant");
  assert.deepEqual(partial.author, { id: `agent:${AGENT.id}`, name: AGENT.name });
  assert.equal(partial.parts[0].text, "Reading your message.");

  // One writer: while it runs, a second turn in the thread cannot begin; nor a second turn on one message.
  const second = await desk.mutation(chat.messages.post, { threadId: sent.threadId, text: "Also the dates" });
  const busy = await run(second, "echo");
  assert.ok(isFailure(busy) && busy.kind === "Busy", "second turn refused while one runs");
  assert.equal(busy.data.agent, AGENT.name);
  const again = await run(sent.messageId, "echo");
  assert.ok(isFailure(again) && again.kind === "Answered", "a message gets one turn");
  assert.equal((await other.query(ai.turns.list, { threadId: sent.threadId })).length, 1);

  // The agent carries on; the turn ends as done with the message exactly as typed in the reply.
  await h.gate(project, "go");
  assert.deepEqual(await running, { turnId: turn._id, state: "done" });
  const done = (await turns.until("done", (list) => list[0].state === "done"))[0];
  assert.equal(done.sessionId, "replay-echo-session");
  assert.ok(done.finishedAt >= done.startedAt);
  const reply = replyOf(turn)(
    await messages.until("finished reply", (list) => replyOf(turn)(list)?.status === "complete"),
  );
  assert.equal(reply.parts[0].text, `Reading your message. You wrote: ${typed}`);

  // The thread is free again. A failing agent ends its turn as failed, keeping what it wrote.
  const failed = await run(second, "fail");
  assert.equal(failed.state, "failed");
  const [, last] = await turns.until(
    "failed turn",
    (list) => list.length === 2 && list[1].state === "failed",
  );
  assert.equal(last.error, "rate limited");
  assert.equal(last.model, "fail");
  const kept = replyOf(last)(
    await messages.until("failed reply", (list) => replyOf(last)(list)?.status === "error"),
  );
  assert.equal(kept.parts[0].text, "Starting");

  // Two turns asked for at once in one thread: exactly one begins, the other is Busy.
  const [one, two] = await Promise.all(
    ["First at once", "Second at once"].map((text) =>
      desk.mutation(chat.messages.post, { threadId: sent.threadId, text }),
    ),
  );
  await h.closeGate(project, "go");
  const racing = [run(one, "echo"), run(two, "echo")];
  await turns.until("one of the two running", (list) => list.length === 3);
  await h.gate(project, "go");
  const results = await Promise.all(racing);
  assert.equal(results.filter((result) => isFailure(result) && result.kind === "Busy").length, 1);
  assert.equal(results.filter((result) => result.state === "done").length, 1);

  // A turn begins only on a message the caller sent in that thread.
  await assert.rejects(run(turn.replyId, "echo"), /not in this thread/);
}

/**
 * Everything an agent reports besides text (thinking, steps, tasks, a helper,
 * a plan, usage) is stored by ai and read back by any window from the
 * database: the thread's one live `turns:replies`, and what a folded part
 * opens to (`turns:steps`, `turns:thinking`, `turns:helper`).
 */
async function reportsReachTheReply() {
  const address = await h.serve("reports");
  const desk = await h.connect(address, { local: true });
  const other = await h.connect(address);
  const project = await h.folder("auth-service");
  const sent = await desk.mutation(chat.threads.start, {
    text: "The session test fails since the token refresh change. Fix it.",
    folder: { kind: "chosen", path: project },
  });
  const running = desk.action(ai.run.turn, {
    threadId: sent.threadId,
    messageId: sent.messageId,
    folder: project,
    agentId: AGENT.id,
    model: "work",
  });
  const replies = h.watch(other, ai.turns.replies, { threadId: sent.threadId });

  // While the agent waits on its command: the closed line's facts are on the turn.
  const [live] = await replies.until(
    "command running",
    (list) => list[0]?.current?.title === "pnpm test auth",
  );
  assert.equal(live.state, "running");
  assert.deepEqual([live.current.type, live.current.kind], ["tool", "command"]);
  assert.equal(live.actions, 4, "read, search, edit and the command; the helper is not an action");
  assert.equal(live.hasThinking, true);
  assert.equal("thinking" in live || "text" in live || "replyToken" in live, false, "long texts stay out");
  assert.deepEqual(
    live.tasks.map((task) => task.state),
    ["running", "pending", "pending"],
  );
  const opened = await other.query(ai.turns.steps, { turnId: live._id });
  const read = opened.steps.find((step) => step.key === "read-1");
  assert.ok(read.finishedAt >= read.startedAt, "a finished step has its time");
  assert.equal(opened.steps.find((step) => step.key === "command-1").finishedAt, undefined);

  await h.gate(project, "go");
  assert.equal((await running).state, "done");
  const [done] = await replies.until("turn done", (list) => list[0]?.state === "done");
  await expectWorkReplay(other, done);
  const message = (await other.query(chat.messages.list, { threadId: sent.threadId })).find(
    (row) => row._id === done.replyId,
  );
  assert.equal(message.parts[0].text, "The cache outlived the token. I fixed the cache, not the test.");

  await longReports(desk, other);
  await refusedReports(desk);
}

/** The `work` replay's reports, once its turn is done: on the turn, and in what folded parts open to. */
async function expectWorkReplay(other, done) {
  assert.equal(done.current, undefined, "nothing runs once the turn ended");
  assert.equal(done.actions, 5);
  assert.equal(done.modelName, "work");
  assert.deepEqual(
    done.tasks.map((task) => [task.text, task.state]),
    [
      ["Refresh the cached token with the session", "done"],
      ["Run the auth tests", "done"],
      ["Push the branch and open a PR", "pending"],
    ],
  );
  assert.equal(
    done.plan,
    "1. Refresh the cached token together with the session.\n2. Run the auth tests.\n3. Push the branch and open a PR.",
  );
  assert.deepEqual(done.usage, {
    inputTokens: 12400,
    outputTokens: 1100,
    cachedInputTokens: 9000,
    costUsd: 0.04,
  });
  const [helper] = done.helpers;
  assert.deepEqual(
    [helper.name, helper.title, helper.state, helper.hasText, "text" in helper],
    ["Explore", "Find where the token is cached", "done", true, false],
  );
  assert.equal(
    await other.query(ai.turns.helper, { stepId: helper._id }),
    "Session.current keeps the token from before refresh().",
  );
  assert.equal(
    await other.query(ai.turns.thinking, { turnId: done._id }),
    "The session test fails since the refresh change. The cached token is the suspect.",
  );

  // Steps in the order the agent began them; a report with a known id updated its step in place.
  const { steps, omitted } = await other.query(ai.turns.steps, { turnId: done._id });
  assert.equal(omitted, 0);
  assert.deepEqual(
    steps.map((step) => [step.key, step.state]),
    [
      ["read-1", "done"],
      ["search-1", "done"],
      ["edit-1", "done"],
      ["command-1", "done"],
      // Still running when the agent finished: closed with the turn.
      ["other-1", "done"],
    ],
  );
  const search = steps.find((step) => step.key === "search-1");
  assert.deepEqual([search.kind, search.title, search.detail], ["search", "refresh(", "4"]);
  assert.ok(steps.every((step) => step.finishedAt >= step.startedAt));
}

/** More than 1 MiB of thinking and a long plan: kept cut at their limits, and the turn still finishes. */
async function longReports(desk, other) {
  const project = await h.folder("long-thinking");
  const sent = await desk.mutation(chat.threads.start, {
    text: "Think hard",
    folder: { kind: "chosen", path: project },
  });
  const ended = await desk.action(ai.run.turn, {
    threadId: sent.threadId,
    messageId: sent.messageId,
    folder: project,
    agentId: AGENT.id,
    model: "long-thinking",
  });
  const [turn] = await other.query(ai.turns.replies, { threadId: sent.threadId });
  assert.equal(ended.state, "done", turn.error);
  const thinking = await other.query(ai.turns.thinking, { turnId: turn._id });
  const bytes = (text) => Buffer.byteLength(JSON.stringify(text));
  assert.ok(thinking.startsWith('Weighing the "cache" again.\n'));
  assert.ok(thinking.endsWith("\n…cut"), "cut thinking says so");
  assert.ok(
    bytes(thinking) <= 256 * 1024 && bytes(thinking) > 200 * 1024,
    `thinking kept: ${bytes(thinking)} bytes`,
  );
  assert.ok(turn.plan.endsWith("\n…cut") && bytes(turn.plan) <= 64 * 1024, "the plan is cut at 64 KB");
  const reply = (await other.query(chat.messages.list, { threadId: sent.threadId })).find(
    (row) => row._id === turn.replyId,
  );
  assert.equal(reply.parts[0].text, "Done thinking.");
}

/**
 * A malformed report is refused back to the agent; a report the server
 * refuses (the turn was ended meanwhile) stops the agent. Either way the turn
 * fails at once and the agent's program, which would have worked on for a
 * minute, is stopped.
 */
async function refusedReports(desk) {
  const project = await h.folder("refusals");
  const start = async (model, text) => {
    const sent = await desk.mutation(chat.threads.start, { text, folder: { kind: "chosen", path: project } });
    const begun = Date.now();
    const result = desk.action(ai.run.turn, {
      threadId: sent.threadId,
      messageId: sent.messageId,
      folder: project,
      agentId: AGENT.id,
      model,
    });
    return { sent, begun, result };
  };
  const stillRunning = (replay) =>
    Bun.spawnSync(["pgrep", "-f", `replay ${replay}`])
      .stdout.toString()
      .trim() !== "";

  const bad = await start("bad-report", "Go somewhere");
  assert.equal((await bad.result).state, "failed");
  assert.ok(Date.now() - bad.begun < 20_000, "the turn did not wait for the agent's minute");
  const [failed] = await desk.query(ai.turns.list, { threadId: bad.sent.threadId });
  assert.match(failed.error, /kind is one of command, read, edit, search, web, other/);
  assert.equal(stillRunning("bad-report"), false, "the agent program was stopped");

  const stall = await start("stall-after-gate", "Wait for me");
  const turns = h.watch(desk, ai.turns.list, { threadId: stall.sent.threadId });
  const [turn] = await turns.until("stalling turn", (list) => list.length === 1);
  // The sender's own device ends the turn while the agent waits: its next write is refused.
  await desk.mutation(ai.turns.finish, { turnId: turn._id, state: "done", finishedAt: Date.now() });
  await h.gate(project, "go");
  assert.equal((await stall.result).state, "failed");
  assert.ok(Date.now() - stall.begun < 20_000, "the turn did not wait for the agent's minute");
  assert.equal(stillRunning("stall-after-gate"), false, "the agent program was stopped");
}

/**
 * Permission questions: Full access never asks; on Ask first the agent's question
 * waits on the turn until the sender answers, each answer reaches the agent as
 * itself, "Always allow this session" stops that kind of question for the
 * thread's session, and a question expires when the app that asked it quits.
 */
async function permissions() {
  const address = await h.serve("permissions");
  const desk = await h.connect(address, { local: true });
  const project = await h.folder("csv-export");
  const sent = await desk.mutation(chat.threads.start, {
    text: "Push the branch",
    folder: { kind: "chosen", path: project },
  });
  const { threadId } = sent;
  const turns = h.watch(desk, ai.turns.list, { threadId });
  const questions = h.watch(desk, ai.turns.questions, {});
  const messages = h.watch(desk, chat.messages.list, { threadId });
  let messageId = sent.messageId;
  const next = async (text) => (messageId = await desk.mutation(chat.messages.post, { threadId, text }));
  const run = (model, access, window = desk) =>
    window.action(ai.run.turn, {
      threadId,
      messageId,
      folder: project,
      agentId: AGENT.id,
      model,
      ...(access && { access }),
    });
  const replyText = async (turnId) => {
    const turn = (await turns.until("turn row", (list) => list.some((t) => t._id === turnId))).find(
      (t) => t._id === turnId,
    );
    const reply = replyOf(turn)(
      await messages.until("finished reply", (list) => replyOf(turn)(list)?.status === "complete"),
    );
    return reply.parts[0].text;
  };
  /** The next question waiting in this thread, with its turn's row in the waiting state. */
  const waiting = async (label) => {
    const question = (await questions.until(label, (list) => list.some((q) => q.threadId === threadId))).find(
      (q) => q.threadId === threadId,
    );
    const isWaiting = (t) => t._id === question.turnId && t.state === "waiting";
    const turn = (await turns.until(`${label}: the turn waits`, (list) => list.some(isWaiting))).find(
      isWaiting,
    );
    return { question, turn };
  };

  // A new thread is on Full access: the agent's question is approved without a question shown.
  const shown = [];
  const stopWatching = desk.subscribe(ai.turns.questions, {}, (event) => shown.push(...(event.value ?? [])));
  const full = await run("ask-once");
  stopWatching();
  assert.deepEqual(shown, [], "no question is ever shown on Full access");
  assert.equal(full.state, "done");
  assert.equal(await replyText(full.turnId), "Checking the branch. Answer: approve");
  const [fullTurn] = turns.current().filter((t) => t._id === full.turnId);
  assert.equal(fullTurn.access, "full");
  assert.equal("question" in fullTurn, false);
  assert.deepEqual(questions.current(), []);

  // Ask first: each answer reaches the agent as that answer. "Always allow this session" is checked
  // below in its own thread: from it on, turns that carry this session on ask that kind no more.
  for (const answer of ["approve", "decline", "cancel"]) {
    await next(`Push it (${answer})`);
    const running = run("ask-once", "ask");
    const { question, turn } = await waiting(`question for ${answer}`);
    assert.equal(turn.access, "ask", "the turn records the access level it used");
    assert.deepEqual(
      { action: question.action, subject: question.subject, agent: question.agent },
      { action: "run", subject: "git push origin feat/csv-export", agent: AGENT.name },
    );
    assert.equal(
      await desk.action(ai.run.answer, { turnId: turn._id, questionId: question.id, answer }),
      null,
    );
    assert.equal((await running).state, "done");
    assert.equal(await replyText(turn._id), `Checking the branch. Answer: ${answer}`);
    await questions.until(`question for ${answer} gone`, (list) => list.length === 0);
  }

  // "Always allow this session" answers the same kind for the rest of the agent's session; another
  // kind is still asked. The next turn with the same agent on this device carries the session on, so
  // its allows hold. After another agent's turn the session is not carried on: it asks again.
  const sessionThread = await desk.mutation(chat.threads.start, {
    text: "Push and tag",
    folder: { kind: "chosen", path: project },
  });
  const ask = async (label, expected, answer) => {
    const [question] = await questions.until(label, (list) =>
      list.some((q) => q.threadId === sessionThread.threadId),
    );
    assert.equal(question.subject, expected, label);
    await desk.action(ai.run.answer, { turnId: question.turnId, questionId: question.id, answer });
    await questions.until(`${label} answered`, (list) => !list.some((q) => q.id === question.id));
  };
  const PUSH = "git push origin feat/csv-export";
  const TAGS = "git push --tags";
  const EDIT = "src/export.ts";
  const sessionTurns = [
    [
      "first turn",
      AGENT.id,
      [
        [PUSH, "approveSession"],
        [EDIT, "decline"],
      ],
      "Push: approveSession. Push again: approve. Edit: decline",
    ],
    ["next turn", AGENT.id, [[EDIT, "decline"]], "Push: approve. Push again: approve. Edit: decline"],
    [
      "another agent",
      "other-agent",
      [
        [PUSH, "approve"],
        [TAGS, "decline"],
        [EDIT, "decline"],
      ],
      "Push: approve. Push again: decline. Edit: decline",
    ],
    [
      "back again",
      AGENT.id,
      [
        [PUSH, "approve"],
        [TAGS, "approve"],
        [EDIT, "approve"],
      ],
      "Push: approve. Push again: approve. Edit: approve",
    ],
  ];
  let sessionMessage = sessionThread.messageId;
  for (const [label, agentId, asked, reply] of sessionTurns) {
    const running = desk.action(ai.run.turn, {
      threadId: sessionThread.threadId,
      messageId: sessionMessage,
      folder: project,
      agentId,
      model: "ask-session",
      access: "ask",
    });
    for (const [index, [subject, answer]] of asked.entries())
      await ask(`${label}: ${index}`, subject, answer);
    const ended = await running;
    const row = (await desk.query(ai.turns.list, { threadId: sessionThread.threadId })).find(
      (turn) => turn._id === ended.turnId,
    );
    const messages = await desk.query(chat.messages.list, { threadId: sessionThread.threadId });
    assert.equal(replyOf(row)(messages).parts[0].text, reply, label);
    sessionMessage = await desk.mutation(chat.messages.post, {
      threadId: sessionThread.threadId,
      text: "Again",
    });
  }

  // Stop while a question waits: the agent gets "cancel" and stops; the turn ends as stopped well
  // before the Force stop deadline, and the question is gone from the row and the card.
  await next("Push, then stop");
  const stopping = run("ask-once", "ask");
  const { turn: asking } = await waiting("question before Stop");
  await desk.action(ai.run.stop, { turnId: asking._id });
  assert.deepEqual(await stopping, { turnId: asking._id, state: "stopped" });
  const stopped = (await desk.query(ai.turns.list, { threadId })).find((t) => t._id === asking._id);
  assert.equal(stopped.state, "stopped");
  assert.equal("question" in stopped, false);
  assert.ok(Date.now() < stopped.stoppingAt + FORCE_STOP_MS, "ended by the graceful Stop, not Force stop");
  const stoppedReply = replyOf(stopped)(await desk.query(chat.messages.list, { threadId }));
  assert.equal(stoppedReply.status, "cancelled");
  assert.equal(stoppedReply.parts[0].text, "Checking the branch. Answer: cancel");
  await questions.until("no question after Stop", (list) => list.length === 0);

  // Only the app that asked can answer: another window of the same device sees the question but
  // neither holds it nor can clear it on the row. Quitting the app expires the question.
  const app = await h.connect(address, { local: true });
  await next("Push after a restart");
  void run("ask-once", "ask", app).catch(() => {});
  const { question } = await waiting("question before quitting");
  const asked = { turnId: question.turnId, questionId: question.id };
  assert.equal(await app.action(ai.run.pending, asked), true);
  assert.equal(await desk.action(ai.run.pending, asked), false);
  await assert.rejects(
    desk.mutation(ai.turns.answer, { ...asked, token: "ab".repeat(32) }),
    /Only the app that asked/,
  );
  await h.quit(app);
  const relaunched = await h.connect(address, { local: true });
  assert.equal(await relaunched.action(ai.run.pending, asked), false, "the card shows it expired at once");
  const expired = await relaunched.action(ai.run.answer, { ...asked, answer: "approve" });
  assert.ok(
    isFailure(expired) && expired.kind === "Expired",
    "a question from before the quit cannot be answered",
  );
}

async function steerTurn() {
  const address = await h.serve("steer");
  const desk = await h.connect(address, { local: true });
  const folder = await h.folder("steering");
  const sent = await desk.mutation(chat.threads.start, { text: "Start here", folder: { kind: "own" } });
  const turns = h.watch(desk, ai.turns.list, { threadId: sent.threadId });
  const messages = h.watch(desk, chat.messages.list, { threadId: sent.threadId });
  const running = desk.action(ai.run.turn, {
    threadId: sent.threadId,
    messageId: sent.messageId,
    folder,
    agentId: AGENT.id,
    model: "steer",
  });
  const [turn] = await turns.until("running turn", (list) => list.length === 1);
  await messages.until(
    "agent ready",
    (list) => replyOf(turn)(list)?.parts[0]?.text === "Ready for steering.",
  );
  const other = await desk.mutation(chat.threads.start, { text: "Stop this turn", folder: { kind: "own" } });
  const otherTurns = h.watch(desk, ai.turns.list, { threadId: other.threadId });
  const otherMessages = h.watch(desk, chat.messages.list, { threadId: other.threadId });
  const otherRunning = desk.action(ai.run.turn, {
    threadId: other.threadId,
    messageId: other.messageId,
    folder: await h.folder("steering-overlap"),
    agentId: AGENT.id,
    model: "stop",
  });
  void otherRunning.catch(() => {});
  const [otherTurn] = await otherTurns.until("second turn running", (list) => list.length === 1);
  await otherMessages.until(
    "second agent ready",
    (list) => replyOf(otherTurn)(list)?.parts[0]?.text === "Partial reply.",
  );

  const text = "Take the other route ✓";
  const followup = "Keep these notes too";
  await desk.action(ai.run.steer, { turnId: turn._id, text });
  await desk.action(ai.run.stop, { turnId: otherTurn._id });
  assert.equal((await otherRunning).state, "stopped");
  const otherTranscript = await desk.query(chat.messages.list, { threadId: other.threadId });
  assert.equal(replyOf(otherTurn)(otherTranscript).parts[0].text, "Partial reply.stop");
  // The agent's answer to the first steer is stored before the second is sent, so its offset is exact.
  const answered = `Ready for steering. Steered: ${text}`;
  await messages.until("first steer answered", (list) => replyOf(turn)(list)?.parts[0]?.text === answered);
  await desk.action(ai.run.steer, { turnId: turn._id, text: followup });
  assert.equal((await running).state, "done");
  const [done] = await desk.query(ai.turns.list, { threadId: sent.threadId });
  const transcript = await desk.query(chat.messages.list, { threadId: sent.threadId });
  assert.equal(
    replyOf(turn)(transcript).parts[0].text,
    `Ready for steering. Steered: ${text} Then: ${followup}`,
  );
  assert.deepEqual(done.steers, [text, followup]);
  // Each steer keeps where the reply's text stood when it was sent, so the reply draws it there.
  assert.deepEqual(done.steerOffsets, ["Ready for steering.".length, answered.length]);
  assert.equal(done.pendingSteerOffset, undefined);
  assert.deepEqual(await desk.query(ai.turns.replySteers, { replyId: turn.replyId }), [text, followup]);
  assert.equal(transcript.length, 2, "a steer does not create a chat message");
}

async function noSteerHandler() {
  const address = await h.serve("no-steer");
  const desk = await h.connect(address, { local: true });
  const folder = await h.folder("no-steer");
  const { threadId, messageId } = await desk.mutation(chat.threads.start, {
    text: "Start here",
    folder: { kind: "own" },
  });
  const turns = h.watch(desk, ai.turns.list, { threadId });
  const messages = h.watch(desk, chat.messages.list, { threadId });
  const running = desk.action(ai.run.turn, {
    threadId,
    messageId,
    folder,
    agentId: AGENT.id,
    model: "no-steer",
  });
  const [turn] = await turns.until("running turn", (list) => list.length === 1);
  await messages.until("ready", (list) => replyOf(turn)(list)?.parts[0].text === "Ready without steering.");
  assert.equal(
    (await desk.action(ai.run.steer, { turnId: turn._id, text: "Keep this draft" })).kind,
    "NoSteerHandler",
  );
  assert.deepEqual(await desk.query(ai.turns.replySteers, { replyId: turn.replyId }), []);
  assert.equal((await desk.query(chat.messages.list, { threadId })).length, 2);
  await desk.action(ai.run.stop, { turnId: turn._id });
  assert.equal((await running).state, "stopped");
}

async function stopTurns() {
  const address = await h.serve("stop");
  const desk = await h.connect(address, { local: true });
  for (const model of ["stop", "ignore-stop"]) {
    const folder = await h.folder(model);
    const { threadId, messageId } = await desk.mutation(chat.threads.start, {
      text: "Start here",
      folder: { kind: "own" },
    });
    const turns = h.watch(desk, ai.turns.list, { threadId });
    const messages = h.watch(desk, chat.messages.list, { threadId });
    const run = (messageId, model) =>
      desk.action(ai.run.turn, { threadId, messageId, folder, agentId: AGENT.id, model });
    const running = run(messageId, model);
    void running.catch(() => {});
    const [turn] = await turns.until("running turn", (list) => list.length === 1);
    await messages.until("partial reply", (list) =>
      replyOf(turn)(list)?.parts[0]?.text.startsWith("Partial reply"),
    );
    const args = { turnId: turn._id };
    await desk.action(ai.run.stop, args);
    if (model === "ignore-stop") {
      const pids = JSON.parse(await readFile(join(folder, "process-tree.json"), "utf8"));
      const alive = (pid) => {
        const ps = Bun.spawnSync(["ps", "-ww", "-o", "stat=", "-p", String(pid)]);
        const stat = ps.stdout.toString().trim();
        return stat !== "" && !stat.startsWith("Z");
      };
      assert.equal(new Set(pids).size, 3);
      assert.ok(pids.every(alive), "the agent, child and grandchild are still running after Stop");
      assert.equal((await desk.action(ai.run.forceStop, args)).kind, "TooEarly");
      const [stopping] = await turns.until("stop was requested", (list) => !!list[0]?.stoppingAt);
      await messages.until("agent got Stop", (list) =>
        replyOf(turn)(list)?.parts[0]?.text.endsWith("Stop received."),
      );
      await Bun.sleep(Math.max(0, stopping.stoppingAt + FORCE_STOP_MS - Date.now()));
      assert.equal(await desk.action(ai.run.forceStop, args), null);
      assert.ok(
        pids.every((pid) => !alive(pid)),
        `Force stop must end the entire group: ${pids}`,
      );
    }
    assert.deepEqual(await running, { turnId: turn._id, state: "stopped" });
    const [stopped] = await turns.until("stopped", (list) => list[0].state === "stopped");
    const reply = replyOf(stopped)(await desk.query(chat.messages.list, { threadId }));
    assert.equal(reply.status, "cancelled");
    assert.equal(
      reply.parts[0].text,
      model === "stop" ? "Partial reply.stop" : "Partial reply from a stuck agent. Stop received.",
    );
    const next = await desk.mutation(chat.messages.post, { threadId, text: "Continue" });
    assert.equal((await run(next, "fail")).state, "failed", "a new turn can start after stopping");
  }
}

async function queueTurns() {
  const address = await h.serve("queue");
  const desk = await h.connect(address, { local: true });
  const folder = await h.folder("queue");
  const { threadId, messageId } = await desk.mutation(chat.threads.start, {
    text: "First",
    folder: { kind: "own" },
  });
  const turns = h.watch(desk, ai.turns.list, { threadId });
  const messages = h.watch(desk, chat.messages.list, { threadId });
  const run = (messageId) =>
    desk.action(ai.run.turn, { threadId, messageId, folder, agentId: AGENT.id, model: "echo" });
  const running = run(messageId);
  void running.catch(() => {});
  await turns.until("first turn running", (list) => list.some((turn) => turn.state === "running"));
  const settings = { model: "echo", access: "ask", effort: "high", mode: "plan" };
  const queue = (text) => desk.mutation(ai.turns.enqueue, { threadId, text, agent: AGENT, ...settings });
  const checkSettings = ({ model, access, effort, mode }) =>
    assert.deepEqual({ model, access, effort, mode }, settings);
  const second = await queue("Second");
  const third = await queue("Third");
  const queued = await messages.until(
    "dashed rows",
    (list) => list.filter((row) => row.status === "queued").length === 2,
  );
  assert.deepEqual(
    queued.slice(-2).map((row) => row.parts[0].text),
    ["Second", "Third"],
  );
  assert.equal(await desk.query(ai.turns.next, { threadId }), null);
  await h.gate(folder, "go");
  assert.equal((await running).state, "done");
  const next = await desk.query(ai.turns.next, { threadId });
  assert.equal(next.messageId, second.messageId);
  checkSettings(next);
  assert.equal((await run(third.messageId)).kind, "Busy");
  const promoted = await desk.action(ai.run.turn, {
    threadId,
    messageId: second.messageId,
    folder,
    agentId: "gone",
    model: "fail",
    access: "full",
  });
  assert.equal(promoted.state, "done", "a queued turn keeps the provider and model it captured");
  checkSettings((await desk.query(ai.turns.list, { threadId })).find((turn) => turn._id === promoted.turnId));
  assert.equal((await desk.query(ai.turns.next, { threadId })).messageId, third.messageId);
  assert.equal((await run(third.messageId)).state, "done");
  const transcript = await messages.until(
    "queue sent",
    (list) => list.length === 6 && list.at(-1).status === "complete",
  );
  assert.deepEqual(
    transcript.map((row) => row.parts[0].text),
    [
      "First",
      "Reading your message. You wrote: First",
      "Second",
      "Reading your message. You wrote: Second",
      "Third",
      "Reading your message. You wrote: Third",
    ],
  );
}

/** A shared server: only the sender's own device may write to a turn, even with the turn's id. */
async function sharedServer() {
  const address = await h.serve("shared", { shared: true });
  await memberSignsInAndRuns(address);
  const laptop = await h.connect(address, { token: await h.ownerDevice(address, "Laptop"), local: true });
  const desktop = await h.connect(address, { token: await h.ownerDevice(address, "Desktop") });
  const member = await h.connect(address, { token: (await h.signInMember(address, "Noor")).key });
  const sent = await laptop.mutation(chat.threads.start, { text: "Plan the week", folder: { kind: "own" } });
  const folder = await laptop.action(chat.folders.resolve, { threadId: sent.threadId });
  const running = laptop.action(ai.run.turn, {
    threadId: sent.threadId,
    messageId: sent.messageId,
    folder,
    agentId: AGENT.id,
    model: "echo",
  });
  const [turn] = await h
    .watch(member, ai.turns.list, { threadId: sent.threadId })
    .until("owner's turn", (list) => list.length === 1);
  assert.equal(turn.access, "full", "every turn starts on Full access");
  for (const [who, refusal, queueRefusal] of [
    // Another member always hears that only the creator runs the agent, busy thread or not.
    [member, /Only the sender/, /Only the person who started this thread can run an agent/],
    [desktop, /another of your devices/, /another of your devices/],
  ]) {
    await assert.rejects(who.mutation(ai.turns.write, { turnId: turn._id, text: "Hijacked" }), refusal);
    await assert.rejects(who.mutation(ai.turns.steer, { turnId: turn._id, text: "Hijacked" }), refusal);
    await assert.rejects(who.mutation(ai.turns.requestStop, { turnId: turn._id }), refusal);
    await assert.rejects(
      who.mutation(ai.turns.enqueue, {
        threadId: sent.threadId,
        text: "Hijacked",
        agent: AGENT,
        model: "echo",
        access: "full",
      }),
      queueRefusal,
    );
    await assert.rejects(
      who.mutation(ai.turns.finish, { turnId: turn._id, state: "done", finishedAt: Date.now() }),
      refusal,
    );
  }
  await assert.rejects(
    member.mutation(ai.turns.begin, {
      threadId: sent.threadId,
      messageId: sent.messageId,
      agent: AGENT,
      model: "echo",
      access: "full",
      replyToken: "ab".repeat(32),
    }),
    /Only the person who sent/,
  );
  const queued = await laptop.mutation(ai.turns.enqueue, {
    threadId: sent.threadId,
    text: "Follow up",
    agent: AGENT,
    model: "echo",
    access: "ask",
  });
  await h.gate(folder, "go");
  assert.equal((await running).state, "done");
  assert.deepEqual(await member.query(ai.turns.ready, {}), []);
  assert.deepEqual(await desktop.query(ai.turns.ready, {}), []);
  assert.equal((await laptop.query(ai.turns.ready, {}))[0]._id, queued.turnId);
  await assert.rejects(
    member.mutation(ai.turns.enqueue, {
      threadId: sent.threadId,
      text: "Jump the queue",
      agent: AGENT,
      model: "echo",
      access: "full",
    }),
    /Only the person who started this thread/,
  );
  const reply = (await member.query(chat.messages.list, { threadId: sent.threadId })).find(
    (message) => message._id === turn.replyId,
  );
  assert.equal(reply.parts[0].text, "Reading your message. You wrote: Plan the week");

  // A question belongs to the sender's device: nobody else sees it in their questions or can answer it.
  // A thread of its own: the one above still holds its queued follow-up.
  const pushing = await laptop.mutation(chat.threads.start, { text: "Push it", folder: { kind: "own" } });
  const asking = laptop.action(ai.run.turn, {
    threadId: pushing.threadId,
    messageId: pushing.messageId,
    folder: await laptop.action(chat.folders.resolve, { threadId: pushing.threadId }),
    agentId: AGENT.id,
    model: "ask-once",
    access: "ask",
  });
  const [question] = await h
    .watch(laptop, ai.turns.questions, {})
    .until("laptop's question", (list) => list.length === 1);
  for (const [who, refusal] of [
    [member, /Only the sender/],
    [desktop, /another of your devices/],
  ]) {
    assert.deepEqual(await who.query(ai.turns.questions, {}), []);
    const args = { turnId: question.turnId, questionId: question.id, token: "ab".repeat(32) };
    await assert.rejects(who.mutation(ai.turns.answer, args), refusal);
    await assert.rejects(
      who.mutation(ai.turns.ask, {
        turnId: question.turnId,
        question: { id: "forged", kind: "edit", action: "edit", subject: "README.md" },
        token: "ab".repeat(32),
      }),
      refusal,
    );
  }
  await laptop.action(ai.run.answer, { turnId: question.turnId, questionId: question.id, answer: "decline" });
  assert.equal((await asking).state, "done");
}

/** Without an agent plugin, ai lists nothing and a turn has nothing to run. */
async function withoutAgents() {
  const bare = join(h.scratch, "without-agents");
  await mkdir(bare);
  for (const id of ["chat", "ai"]) await cp(join(h.plugins, id), join(bare, id), { recursive: true });
  const address = await h.serve("bare", { pluginsDir: bare });
  const desk = await h.connect(address, { local: true, pluginsDir: bare });
  assert.deepEqual(await desk.action(ai.agents.list, {}), []);
  const sent = await desk.mutation(chat.threads.start, { text: "Hello", folder: { kind: "own" } });
  const result = await desk.action(ai.run.turn, {
    threadId: sent.threadId,
    messageId: sent.messageId,
    folder: h.home,
    agentId: AGENT.id,
  });
  assert.deepEqual(result, { failed: true, kind: "NoAgent", data: { agentId: AGENT.id } });
  assert.deepEqual(await desk.query(ai.turns.list, { threadId: sent.threadId }), []);
}

async function memberSignsInAndRuns(address) {
  const { key, user } = await h.signInMember(address, "Morgan");
  let onClose;
  const closed = new Promise((resolve) => (onClose = resolve));
  const member = await h.connect(address, { token: key, local: true, onClose });
  const observer = await h.connect(address, { token: h.ownerToken });
  const { device } = await member.query(authCaller, {});
  const folder = await h.folder("member-turn");
  const first = await member.mutation(chat.threads.start, {
    text: "Plan my week",
    folder: { kind: "chosen", path: folder },
  });
  const { threadId } = first;
  const run = (messageId, model, access = "ask") =>
    member.action(ai.run.turn, { threadId, messageId, folder, agentId: AGENT.id, model, access });
  const post = (text) => member.mutation(chat.messages.post, { threadId, text });
  const questions = h.watch(member, ai.turns.questions, {});
  const turns = h.watch(observer, ai.turns.list, { threadId });
  const answer = (question, answer) =>
    member.action(ai.run.answer, { turnId: question.turnId, questionId: question.id, answer });

  const task = run(first.messageId, "ask-once");
  const [question] = await questions.until("signed-in member's first question", (rows) => rows.length === 1);
  await answer(question, "approveSession");
  assert.equal((await task).state, "done");
  const [finished] = await turns.until("completed member turn", (rows) => rows[0]?.state === "done");
  assert.equal(finished.sender.id, user.id);
  assert.equal(finished.sender.device, device.id);
  const transcript = await observer.query(chat.messages.list, { threadId });
  assert.ok(replyOf(finished)(transcript).parts.some((part) => part.text.includes("approveSession")));

  // The fake agent's session file is the session on this client. Losing it
  // must prompt again even though ai offered to carry the old session on.
  await unlink(join(h.home, `.${AGENT.id}`, "sessions", finished.sessionId));
  const retry = run(await post("Ask again"), "ask-once");
  const [fresh] = await questions.until("fresh session asks again", (rows) =>
    rows.some((row) => row.id !== question.id),
  );
  await answer(fresh, "decline");
  assert.equal((await retry).state, "done");
  // A turn with tool steps, so deleting the thread has steps to remove.
  await h.gate(folder, "go");
  assert.equal((await run(await post("Show the work"), "work")).state, "done");

  const working = run(await post("Keep working"), "ignore-stop", "full");
  const lost = working.then(
    () => assert.fail("Revoked device completed its work"),
    () => {},
  );
  await h.waitFor(folder, "process-tree.json");
  const pids = JSON.parse(await readFile(join(folder, "process-tree.json"), "utf8"));
  assert.equal(pids.length, 3);
  assert.equal((await h.revokeDevice(address, device.id)).revoked, device.id);
  assert.equal((await within(closed, "revoked member socket closes")).code, 4001);
  await within(lost, "revoked member local call cancelled");
  const alive = (pid) => {
    const state = spawnSync("ps", ["-ww", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    return state && !state.startsWith("Z");
  };
  await within(
    (async () => {
      const deadline = Date.now() + 5_000;
      while (pids.some(alive)) {
        assert.ok(Date.now() < deadline, "agent process survived revocation");
        await Bun.sleep(20);
      }
    })(),
    "revoked member's process group stopped",
  );
  await assert.rejects(h.connect(address, { token: key }), /WebSocket failed/);

  // The creator may delete from a different signed-in device without a local part.
  const later = await h.signInMember(address, "Reader");
  const reader = await h.connect(address, { token: later.key, local: true });
  await assert.rejects(reader.mutation(chat.threads.remove, { threadId }), /Only the person who started/);
  // Another member's window learns who runs the agent; their Send gets no folder, so no turn.
  assert.deepEqual(await reader.query(ai.choices.creator, { threadId }), { id: user.id, name: "Morgan" });
  assert.equal(await reader.action(chat.folders.resolve, { threadId }), null);
  // A valid key on the original account, issued after the first password change.
  const creatorKey = await fetch(new URL("/auth/sign-in", address.replace(/^ws:/, "http:")), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "basic-auth",
      fields: { usernameOrEmail: "Morgan", password: "member's own password" },
      deviceName: "Second device",
    }),
  }).then((response) => response.json());
  const creator = await h.connect(address, { token: creatorKey.key });
  assert.ok((await creator.query(ai.choices.get, { threadId })).agent);
  const turnIds = (await observer.query(ai.turns.list, { threadId })).map((turn) => turn._id);
  const before = await observer.query(probe.rows, { turnIds });
  assert.ok(
    before.steps > 0 && before.signs > 0,
    `steps and signs before the delete: ${JSON.stringify(before)}`,
  );
  await creator.mutation(chat.threads.remove, { threadId });
  assert.deepEqual(await observer.query(probe.rows, { turnIds }), { steps: 0, signs: 0 });
  assert.deepEqual(await reader.query(ai.turns.list, { threadId }), []);
  assert.equal(await reader.query(ai.choices.get, { threadId }), null);
  assert.deepEqual(await reader.query(chat.messages.list, { threadId }), []);
}

/** Serves a scratch build of ai with fixtures/ai-rows-probe added, instead of the plain build. */
async function installRowsProbe() {
  const source = join(h.scratch, "sources", "ai-probe");
  await copySource(join(workspace, "plugins/ai"), source, testModules);
  // The copy's relative `extends` would leave the checkout; point it at the app's config.
  await writeFile(
    join(source, "src/client/tsconfig.json"),
    JSON.stringify({ extends: testWindowConfig }),
  );
  await cp(
    new URL("./fixtures/ai-rows-probe/probe.ts", import.meta.url).pathname,
    join(source, "src/server/probe.ts"),
  );
  build(source);
  await cp(join(source, "dist"), join(h.plugins, "ai"), { recursive: true, force: true });
}
