import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function permissionCases(options) {
  await permissions(options);
  await permissionScope(options);
  await options.overlap("stop-asking", () => stopAsking(options));
  options.passed("stop while waiting for permission");
  if (!options.live) await stopAfterWithdrawal(options);
}

function checkCommand(live, question, title, file) {
  assert.equal(question.action, "run");
  if (live) assert.ok(question.subject.includes(file), `Command targets ${file}`);
  else assert.equal(question.subject, title);
}

async function stopAsking({ run, live, caseFolder }) {
  const waiting = await run(
    "stop-asking",
    "Use Bash once to run touch stop-asking-fixture.txt. Then say DONE.",
    {
      state: "stopped",
      access: "ask",
      async during(turn) {
        const question = await turn.question();
        checkCommand(live, question, "touch stop-asking-fixture.txt", "stop-asking-fixture.txt");
        if (live)
          assert.ok(
            !(await Bun.file(join(await caseFolder("stop-asking"), "stop-asking-fixture.txt")).exists()),
          );
        await turn.stop();
      },
    },
  );
  if (live) assert.doesNotMatch(waiting.text, /\bDONE\b/);
  else {
    assert.equal(waiting.text, "");
    const interrupted = (await waiting.steps()).find(
      ({ title }) => title === "touch stop-asking-fixture.txt",
    );
    assert.equal(interrupted?.state, "done", "Stop closes the interrupted step with the turn");
  }
  assert.ok(waiting.reply.usage);
  if (live) assert.ok(!(await Bun.file(join(waiting.folder, "stop-asking-fixture.txt")).exists()));
}

async function stopAfterWithdrawal({ h, run, caseFolder }) {
  const prompt = "Ask before creating a fixture file.";
  const withdrawn = await run("withdraw-question", prompt, {
    access: "ask",
    state: "stopped",
    async during(turn) {
      const question = await turn.question();
      assert.equal(question.subject, "touch fixture.txt");
      await h.gate(await caseFolder("withdraw-question"), "withdraw-question");
      // This text comes after control_cancel_request. The next wire message
      // must be Stop's interrupt; Stop clears the question held by the local part.
      await turn.firstText();
      await turn.stop();
      assert.equal((await turn.sendAnswer(question, "approve")).kind, "Expired");
    },
  });
  assert.equal(withdrawn.text, "The tool request was withdrawn.");

  assert.equal(withdrawn.row.sessionId, "00000000-0000-4000-8000-000000000000", "the CLI accepted Stop");
}

async function permissions(options) {
  for (const replay of permissionReplays(options.live)) await permissionReplay(options, replay);
}

function permissionReplays(live) {
  const cases = [
    [
      "permit",
      "approve",
      "Use Bash exactly once to run the command touch permit-probe.txt. Then give its output.",
      "done",
    ],
    [
      "refuse",
      "decline",
      "Use Bash exactly once to run the command touch refuse-probe.txt. If it is denied, reply only DENIED. Do not try other tools.",
      "failed",
    ],
    [
      "remember",
      "approveSession",
      "Use Bash to run the exact command touch remember-probe.txt twice as two separate consecutive tool calls, never in parallel and never chained. Both calls must be issued before answering. Then reply DONE.",
      "done",
    ],
    [
      "cancel",
      "cancel",
      "Use Bash to run touch cancel-probe.txt. Then print 1000 numbers; do not finish early.",
      "failed",
    ],
  ];
  if (!live) cases.push(["cancel-continues", "cancel", "Ask before creating a fixture file.", "failed"]);
  return cases;
}

async function permissionReplay(
  { run, turns, overlap, live, caseFolder, passed },
  [name, answer, prompt, outcome],
) {
  const file = name === "cancel-continues" ? "fixture.txt" : `${name}-probe.txt`;
  const title = `touch ${file}`;
  const fixture = Bun.file(join(await caseFolder(name), file));
  const exercise = () =>
    run(name, prompt, {
      access: "ask",
      answers: 1,
      state: name === "cancel" ? "stopped" : "done",
      async during(turn) {
        const question = await turn.question();
        checkCommand(live, question, title, file);
        if (live) assert.ok(!(await fixture.exists()), "the command has not run before permission");
        if (!live) {
          const hash = createHash("sha256")
            .update(JSON.stringify(["Bash", title]))
            .digest("hex");
          assert.equal(question.kind, `Bash:${hash}`);
        }
        await turn.answer(question, answer);
        if (name === "permit" && !live) {
          const result = await turn.sendAnswer(question, "decline");
          assert.equal(result.kind, "Expired");
        }
      },
    });
  let result;
  if (name === "permit" && !live) {
    const other = await overlap("overlap", async () => {
      result = await exercise();
    });
    assert.notEqual(other.row.sessionId, result.row.sessionId);
  } else {
    result = await exercise();
  }
  if (name === "remember" && !live) {
    const continued = await turns.run(result.folder, "Try the same command again.", {
      threadId: result.threadId,
      access: "ask",
    });
    assert.equal(continued.row.sessionId, result.row.sessionId);
    assert.equal(continued.text, result.text);
    assert.deepEqual(
      (await continued.steps()).map(({ state }) => state),
      ["done", "done"],
    );
  }
  await checkPermissionReports({ result, name, answer, outcome, live, file, title, fixture });
  passed(`permission: ${answer}`);
}

async function checkPermissionReports({ result, name, answer, outcome, live, file, title, fixture }) {
  const steps = (await result.steps()).filter(
    (step) => step.kind === "command" && (live ? step.title.includes(file) : step.title === title),
  );
  assert.deepEqual(
    steps.map((step) => step.state),
    answer === "approveSession" ? ["done", "done"] : [outcome],
  );
  if (name === "cancel") {
    if (live) assert.doesNotMatch(result.text, /^1000$/m);
    else assert.equal(result.text, "");
    assert.ok(result.row.sessionId);
    assert.ok(result.reply.usage, "the CLI's interrupted result was stored");
  }
  if (name === "cancel-continues") assert.equal(result.text, "I continued without using the tool.");
  if (live) {
    const allowed = answer === "approve" || answer === "approveSession";
    assert.equal(await fixture.exists(), allowed, `${answer} file effect`);
    if (allowed) assert.equal(await fixture.text(), "");
  }
}

async function permissionScope({ run, live, passed }) {
  const result = await run(
    "scope",
    "Use Write three times: write FIRST to scope.txt, then SECOND to scope.txt, then THIRD to separate.txt. Do not use other tools. Reply DONE.",
    {
      access: "ask",
      answers: 2,
      async during(turn) {
        for (const file of ["scope.txt", "separate.txt"]) {
          const question = await turn.question();
          assert.equal(question.action, "edit");
          assert.equal(question.subject.split(/[\\/]/).at(-1), file);
          await turn.answer(question, "approveSession");
        }
      },
    },
  );
  assert.equal(
    (await result.steps()).filter((step) => step.kind === "edit" && step.state === "done").length,
    3,
  );
  if (live) {
    assert.equal((await readFile(join(result.folder, "scope.txt"), "utf8")).trim().toUpperCase(), "SECOND");
    assert.equal((await readFile(join(result.folder, "separate.txt"), "utf8")).trim().toUpperCase(), "THIRD");
  }
  passed("permission stays scoped to the approved path");
}
