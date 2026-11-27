// End to end for what belongs to a thread in ai (TKM-224): the agent, model,
// level, speed, mode and permission level, and the conversation an agent is
// given. Two fake agents (e2e/fake-agent/agents): "Fake agent" offers modes
// (like Codex's plan mode) but no levels or speeds, "Other agent" offers
// levels and speeds but no modes. The `context` replay says back what the
// agent was given: whether it carries on a session, the settings and, for a
// fresh session, the thread's earlier messages.
import assert from "node:assert/strict";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFailure } from "../../node_modules/@tokamak/sdk/src/index.ts";
import { agentHarness, installFakeAgent } from "../fake-agent/harness.mjs";

const h = await agentHarness({ binary: process.argv[2], name: "ai-threads" });
const { ai, chat } = h.api;
const FAKE = { id: "fake-agent", name: "Fake agent" };
const OTHER = { id: "other-agent", name: "Other agent" };

try {
  await installAndSignIn();
  await sessionsAndHistory();
  await longThreads();
  await choicesBelongToTheThread();
  console.log(
    "ai threads: pickers offered per agent, install and sign-in seen at once, session carried on this device, " +
      "full history for a fresh session and a switched agent, long threads noted, choices per thread",
  );
} finally {
  await h.close();
}

/** Runs one turn with the `context` replay; resolves its turn row and its reply's text. */
async function contextTurn(window, { threadId, messageId, folder, agent, ...more }) {
  const result = await window.action(ai.run.turn, {
    threadId,
    messageId,
    folder,
    agentId: agent.id,
    model: "context",
    ...more,
  });
  assert.equal(result.state, "done", JSON.stringify(result));
  const row = (await window.query(ai.turns.list, { threadId })).find((entry) => entry._id === result.turnId);
  const messages = await window.query(chat.messages.list, { threadId });
  return { row, reply: messages.find((message) => message._id === row.replyId).parts[0].text };
}

/** The agent row's list is asked again each time: an install or a sign-in shows without a restart. */
async function installAndSignIn() {
  const address = await h.serve("install");
  const desk = await h.connect(address, { local: true });
  const listed = async (id) => (await desk.action(ai.agents.list, {})).find((agent) => agent.id === id);

  // What each agent offers decides which pickers show: a speed is not a mode.
  const fake = (await listed(FAKE.id)).info;
  assert.deepEqual({ speeds: fake.speeds, modes: fake.modes }, { speeds: [], modes: ["default", "plan"] });
  assert.ok(
    fake.models.every((model) => model.efforts.length === 0),
    "Fake agent offers no levels",
  );
  const other = (await listed(OTHER.id)).info;
  assert.deepEqual({ speeds: other.speeds, modes: other.modes }, { speeds: ["standard", "fast"], modes: [] });
  assert.deepEqual(other.models.find((model) => model.id === "context")?.efforts, ["low", "high"]);

  const sent = await desk.mutation(chat.threads.start, { text: "Hello", folder: { kind: "own" } });
  const folder = await desk.action(chat.folders.resolve, { threadId: sent.threadId });
  const run = () =>
    desk.action(ai.run.turn, {
      threadId: sent.threadId,
      messageId: sent.messageId,
      folder,
      agentId: OTHER.id,
      model: "context",
    });

  // Signed out, then signed in again: the next ask sees each.
  await mkdir(join(h.home, ".other-agent"), { recursive: true });
  await writeFile(join(h.home, ".other-agent", "signed-out"), "");
  const out = (await listed(OTHER.id)).info;
  assert.deepEqual(
    { installed: out.installed, signedIn: out.signedIn },
    { installed: true, signedIn: false },
  );
  assert.deepEqual(await run(), { failed: true, kind: "SignedOut", data: { agent: OTHER.name } });
  await unlink(join(h.home, ".other-agent", "signed-out"));
  assert.equal((await listed(OTHER.id)).info.signedIn, true);

  // Not installed (its program is not on PATH), then installed.
  await unlink(join(h.bin, "other-agent"));
  assert.equal((await listed(OTHER.id)).info.installed, false);
  assert.deepEqual(await run(), { failed: true, kind: "NotInstalled", data: { agent: OTHER.name } });
  await installFakeAgent(h.bin, ["other-agent"]);
  assert.equal((await listed(OTHER.id)).info.installed, true);
  assert.deepEqual(
    await desk.query(ai.turns.list, { threadId: sent.threadId }),
    [],
    "no turn began meanwhile",
  );
}

/**
 * The thread in the database is the truth: the agent carries on its own
 * session on this computer while it has it; otherwise, and after switching
 * agent, a fresh session gets the full text of every earlier message.
 */
async function sessionsAndHistory() {
  const address = await h.serve("sessions");
  const desk = await h.connect(address, { local: true });
  const folder = await h.folder("sessions-app");
  const sent = await desk.mutation(chat.threads.start, {
    text: "Plan the CSV export",
    folder: { kind: "chosen", path: folder },
  });
  const threadId = sent.threadId;
  const turn = async (messageId, agent, more = {}) =>
    contextTurn(desk, { threadId, messageId, folder, agent, ...more });
  const post = (text) => desk.mutation(chat.messages.post, { threadId, text });

  // The first turn starts fresh, with no earlier messages.
  const first = await turn(sent.messageId, OTHER, { effort: "high", speed: "fast" });
  assert.equal(
    first.reply,
    "Fresh session\nmodel context, level high, speed fast, mode -, access full\nMessage: Plan the CSV export",
  );
  assert.match(first.row.sessionId, /^other-agent-/);

  // The second, on this computer with the same agent, carries on that session and is given no history.
  const second = await turn(await post("Now write it"), OTHER);
  assert.equal(
    second.reply,
    `Carrying on ${first.row.sessionId}\nmodel context, level low, speed standard, mode -, access full\nMessage: Now write it`,
  );
  assert.equal(second.row.sessionId, first.row.sessionId);

  // The session is gone from this computer: a fresh session gets every earlier message in full.
  await unlink(join(h.home, ".other-agent", "sessions", first.row.sessionId));
  const third = await turn(await post("Add a test"), OTHER);
  const before = [
    "user Sam: Plan the CSV export",
    `agent Other agent: ${first.reply}`,
    "user Sam: Now write it",
    `agent Other agent: ${second.reply}`,
  ];
  assert.equal(
    third.reply,
    [
      "Fresh session",
      "model context, level low, speed standard, mode -, access full",
      ...before,
      "Message: Add a test",
    ].join("\n"),
  );
  assert.notEqual(third.row.sessionId, first.row.sessionId);

  // Switching agent: the other agent's session is not carried over; the new agent gets the same full text.
  const switched = await turn(await post("Review it"), FAKE, { mode: "plan" });
  assert.equal(
    switched.reply,
    [
      "Fresh session",
      "model context, level -, speed -, mode plan, access full",
      ...before,
      "user Sam: Add a test",
      `agent Other agent: ${third.reply}`,
      "Message: Review it",
    ].join("\n"),
  );
  assert.deepEqual(switched.row.agent, FAKE);

  // Back to Other agent: its last session is not the thread's last turn, so it starts fresh again.
  const back = await turn(await post("And the docs"), OTHER);
  assert.match(back.reply, /^Fresh session\n/);
  assert.match(back.reply, /\nagent Fake agent: Fresh session\n/);

  // A turn that thinks and runs a command: a fresh session after it is given its answer only,
  // never its thinking or its steps.
  const busy = await desk.action(ai.run.turn, {
    threadId,
    messageId: await post("Run the tests"),
    folder,
    agentId: FAKE.id,
    model: "thinks-and-runs",
  });
  assert.equal(busy.state, "done");
  const [busyTurn] = (await desk.query(ai.turns.replies, { threadId })).filter(
    (row) => row._id === busy.turnId,
  );
  assert.equal(busyTurn.hasThinking, true);
  assert.equal(busyTurn.actions, 1, "the reports were stored");
  const after = await turn(await post("What changed?"), OTHER);
  assert.match(after.reply, /\nagent Fake agent: All tests pass\.\n/);
  assert.doesNotMatch(after.reply, /Private thinking|pnpm test|22 passed/);
}

/**
 * Chat returns only the newest messages of a long thread, and a short line in
 * place of a message too large to show: a fresh session gets what fits, after
 * a note saying how many earlier messages are left out, and never that line.
 */
async function longThreads() {
  const address = await h.serve("long");
  const desk = await h.connect(address, { local: true });
  const folder = await h.folder("long-app");
  const start = (text) =>
    desk.mutation(chat.threads.start, { text, folder: { kind: "chosen", path: folder } });
  const post = (threadId, text) => desk.mutation(chat.messages.post, { threadId, text });

  // One message too large to show (over 768 KB): left out and counted, never passed as its stand-in line.
  const huge = await start("First");
  await post(huge.threadId, "x".repeat(800_000));
  const after = await post(huge.threadId, "After the big one");
  const one = await contextTurn(desk, { threadId: huge.threadId, messageId: after, folder, agent: OTHER });
  assert.equal(
    one.reply,
    [
      "Fresh session",
      "model context, level low, speed standard, mode -, access full",
      "note Tokamak: 1 earlier message of this thread is left out.",
      "user Sam: First",
      "Message: After the big one",
    ].join("\n"),
  );

  // The window shows 200 messages; the fresh agent still gets the first one.
  const many = await start("Oldest history marker");
  for (let i = 0; i < 205; i++) await post(many.threadId, `Earlier line ${i}`);
  const final = await post(many.threadId, "Read the full history");
  const full = await contextTurn(desk, { threadId: many.threadId, messageId: final, folder, agent: OTHER });
  assert.match(full.reply, /user Sam: Oldest history marker/);
  assert.match(full.reply, /user Sam: Earlier line 204/);
  assert.doesNotMatch(full.reply, /earlier messages? of this thread .* left out/);

  // More than fits: the oldest messages are left out and counted.
  const long = await start("First");
  await post(long.threadId, "a".repeat(500_000));
  await post(long.threadId, "b".repeat(500_000));
  const last = await post(long.threadId, "Last");
  const two = await contextTurn(desk, { threadId: long.threadId, messageId: last, folder, agent: OTHER });
  assert.equal(
    two.reply,
    [
      "Fresh session",
      "model context, level low, speed standard, mode -, access full",
      "note Tokamak: 2 earlier messages of this thread are left out.",
      `user Sam: ${"b".repeat(20)}… (500000 characters)`,
      "Message: Last",
    ].join("\n"),
  );
}

/**
 * The choices belong to the thread: a turn saves what it used when its sender
 * started the thread, a picker changes them, only the thread's creator may,
 * and a session is carried on only on the device that ran it.
 */
async function choicesBelongToTheThread() {
  const address = await h.serve("shared", { shared: true });
  const laptop = await h.connect(address, { token: await h.ownerDevice(address, "Laptop"), local: true });
  const desktop = await h.connect(address, { token: await h.ownerDevice(address, "Desktop"), local: true });
  const member = await h.connect(address, {
    token: (await h.signInMember(address, "Noor")).key,
    local: true,
  });
  const folder = await h.folder("shared-app");
  const sent = await laptop.mutation(chat.threads.start, {
    text: "Start here",
    folder: { kind: "chosen", path: folder },
  });
  const threadId = sent.threadId;
  assert.equal(
    await laptop.query(ai.choices.get, { threadId }),
    null,
    "nothing stored before the first turn",
  );

  // The first turn's choices become the thread's; a level or speed the agent does not offer falls back to its first.
  const first = await contextTurn(laptop, {
    threadId,
    messageId: sent.messageId,
    folder,
    agent: OTHER,
    effort: "extreme",
    speed: "warp",
    mode: "plan",
    access: "ask",
  });
  const saved = { agent: OTHER, model: "context", effort: "low", speed: "standard", access: "ask" };
  assert.deepEqual(await member.query(ai.choices.get, { threadId }), saved, "Other agent offers no modes");

  // A picker changes them; only the thread's creator may.
  const changed = { agent: OTHER, model: "context", effort: "high", speed: "fast", access: "full" };
  await assert.rejects(
    member.mutation(ai.choices.set, { threadId, ...changed }),
    /Only the person who started/,
  );
  await laptop.mutation(ai.choices.set, { threadId, ...changed });
  assert.deepEqual(await member.query(ai.choices.get, { threadId }), changed);

  // The same person's other computer has its own local part: the laptop's session is not carried on there.
  const fromDesktop = await desktop.mutation(chat.messages.post, { threadId, text: "From the desktop" });
  const { effort, speed, access } = changed;
  const other = await contextTurn(desktop, {
    threadId,
    messageId: fromDesktop,
    folder,
    agent: OTHER,
    effort,
    speed,
    access,
  });
  assert.match(
    other.reply,
    /^Fresh session\nmodel context, level high, speed fast, mode -, access full\nuser Sam: Start here\n/,
  );
  assert.notEqual(other.row.sessionId, first.row.sessionId);

  // A member may post text, but cannot start an agent with the creator's Full access.
  const asked = await member.mutation(chat.messages.post, { threadId, text: "Noor asks" });
  await assert.rejects(
    contextTurn(member, { threadId, messageId: asked, folder, agent: FAKE, access: "full" }),
    /Only the person who started this thread can run an agent/,
  );
  await assert.rejects(
    member.mutation(ai.turns.enqueue, { threadId, text: "Queue work", ...changed }),
    /Only the person who started this thread can run an agent/,
  );
  assert.deepEqual(await member.query(ai.choices.get, { threadId }), changed);

  // Each turn row shows what it used.
  const turns = await member.query(ai.turns.list, { threadId });
  assert.deepEqual(
    turns.map(({ agent, model, effort, speed, mode, access }) => ({
      agent: agent.id,
      model,
      effort,
      speed,
      mode,
      access,
    })),
    [
      { agent: OTHER.id, model: "context", effort: "low", speed: "standard", mode: undefined, access: "ask" },
      { agent: OTHER.id, model: "context", effort: "high", speed: "fast", mode: undefined, access: "full" },
    ],
  );
  const again = await laptop.action(ai.run.turn, {
    threadId,
    messageId: sent.messageId,
    folder,
    agentId: OTHER.id,
  });
  assert.ok(isFailure(again) && again.kind === "Answered", "a message gets one turn");
}
