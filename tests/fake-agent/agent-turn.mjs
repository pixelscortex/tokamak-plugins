import assert from "node:assert/strict";
import { watchQuery, within } from "./harness.mjs";

/** Send through chat, run the installed agent through ai, and read what the window sees. */
export function agentTurns({ h, client, agent, model, effort, timeout }) {
  const { ai, chat } = h.api;
  const start = (folder, text) =>
    client.mutation(chat.threads.start, { text, folder: { kind: "chosen", path: folder } });

  return {
    // Give recovery a stored session that the CLI will refuse to resume.
    async seedLostSession(folder, { prompt, text, sessionId }) {
      const { threadId, messageId } = await start(folder, prompt);
      const { turnId } = await client.mutation(ai.turns.begin, {
        threadId,
        messageId,
        agent,
        model,
        access: "full",
        // This seeded reply is finished here; no agent or window needs its capability.
        replyToken: "ab".repeat(32),
      });
      assert.ok(turnId, "stored the earlier turn");
      await client.mutation(ai.turns.write, { turnId, text });
      await client.mutation(ai.turns.finish, { turnId, state: "done", sessionId, finishedAt: Date.now() });
      return threadId;
    },

    async run(folder, text, { threadId, during, state = "done", answers = 0, ...settings } = {}) {
      let messageId;
      if (threadId) messageId = await client.mutation(chat.messages.post, { threadId, text });
      else ({ threadId, messageId } = await start(folder, text));
      const args = { threadId };
      const label = `${agent.name}: ${text.slice(0, 70)}`;
      const context = { client, ai, chat, args, label, isTurn: (row) => row.messageId === messageId };
      const running = within(
        client.action(ai.run.turn, {
          ...args,
          messageId,
          folder,
          agentId: agent.id,
          ...(model !== undefined && { model }),
          ...(effort !== undefined && { effort }),
          ...settings,
        }),
        label,
        timeout,
      );
      // An assertion during a turn can fail while the tape is still waiting for input.
      void running.catch(() => {});
      const cleanup = [];
      try {
        const controls = during && turnControls(context, running, cleanup, timeout);
        if (controls) await during(controls);
        const report = await storedReply(context, await running, state);
        assert.equal(controls?.answeredCount ?? 0, answers, `${label}: permission questions answered`);
        return { folder, threadId, ...report };
      } finally {
        for (const stop of cleanup.reverse()) stop();
      }
    },
  };
}

function turnControls({ client, ai, chat, args, label, isTurn }, running, cleanup, timeout) {
  const watch = (fn, inputs) => watchQuery(client, fn, inputs, cleanup);
  let replies, messages, questions;
  const answered = new Set();
  async function wait(watcher, what, match) {
    return match(
      await Promise.race([
        watcher.until(what, match, timeout),
        running.then((result) => {
          throw new Error(`${label} ended before ${what}: ${JSON.stringify(result)}`);
        }),
      ]),
    );
  }
  function replyUntil(what, predicate) {
    replies ??= watch(ai.turns.replies, args);
    return wait(replies, what, (rows) => rows.find((row) => isTurn(row) && predicate(row)));
  }
  async function messageUntil(what, predicate) {
    const { replyId } = await replyUntil("the reply to open", () => true);
    messages ??= watch(chat.messages.list, args);
    return wait(messages, what, (rows) => rows.find((row) => row._id === replyId && predicate(row)));
  }

  function sendAnswer({ turnId, id: questionId }, answer) {
    return client.action(ai.run.answer, { turnId, questionId, answer });
  }

  return {
    replyUntil,
    messageUntil,
    firstText: () => messageUntil("the partial reply", (message) => message.parts[0]?.text),
    get answeredCount() {
      return answered.size;
    },
    async question() {
      questions ??= watch(ai.turns.questions, {});
      const question = await wait(questions, "a permission question", (rows) =>
        rows.find((row) => row.threadId === args.threadId && !answered.has(row.id)),
      );
      const waiting = await replyUntil(
        "the turn to wait",
        (row) => row.state === "waiting" && row.question?.id === question.id,
      );
      assert.equal(waiting._id, question.turnId);
      return question;
    },
    sendAnswer,
    async answer(question, answer) {
      assert.equal(await sendAnswer(question, answer), null);
      answered.add(question.id);
    },
    async stop() {
      const { _id: turnId } = await replyUntil("the running turn", () => true);
      assert.equal(await client.action(ai.run.stop, { turnId }), null);
    },
    async steer(text) {
      const { _id: turnId } = await replyUntil("the running turn", () => true);
      assert.deepEqual(await client.action(ai.run.steer, { turnId, text }), { error: null });
    },
  };
}

async function storedReply({ client, ai, chat, args, label, isTurn }, result, state) {
  const row = (await client.query(ai.turns.list, args)).find(isTurn);
  assert.equal(result.state, state, `${label}: ${row?.error ?? JSON.stringify(result)}`);
  assert.ok(row, `${label} stored a turn`);
  assert.equal(row._id, result.turnId);
  assert.equal(row.state, state);
  assert.equal(row.question, undefined);
  const reply = (await client.query(ai.turns.replies, args)).find(isTurn);
  assert.equal(reply?._id, row._id, `${label} stored a reply`);
  assert.equal(reply.state, state);
  const message = (await client.query(chat.messages.list, args)).find(({ _id }) => _id === row.replyId);
  assert.equal(
    message?.status,
    state === "stopped" ? "cancelled" : state === "failed" ? "error" : "complete",
  );
  const turnArgs = { turnId: row._id };
  function checkTimes(report) {
    assert.ok(Number.isFinite(report.startedAt), `${label}: step has a start time`);
    if (report.state !== "running") {
      assert.ok(report.finishedAt >= report.startedAt, `${label}: finished step has valid timestamps`);
    }
  }
  for (const helper of reply.helpers) checkTimes(helper);
  return {
    row,
    reply,
    error: message.error,
    text: message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n"),
    thinking: () => client.query(ai.turns.thinking, turnArgs),
    async steps() {
      const { steps, omitted } = await client.query(ai.turns.steps, turnArgs);
      assert.equal(omitted, 0);
      for (const step of steps) checkTimes(step);
      return steps;
    },
    helper: (step) => client.query(ai.turns.helper, { stepId: step._id }),
  };
}
