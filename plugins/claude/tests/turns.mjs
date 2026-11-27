// Drives the installed Claude provider through a real Tokamak server. CI plays
// sanitized recordings; --live opts into the official CLI on this computer.
import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { permissionCases } from "./permissions.mjs";
import { claudeSnapshots } from "./snapshots.mjs";
import { overlappingHello, resistantTurns } from "./overlap.mjs";
import { turnWire } from "./turn-wire.mjs";
import { agentTurns } from "../../../tests/fake-agent/agent-turn.mjs";
import { fileURLToPath } from "node:url";
import { agentHarness, build, bunPath, connect } from "../../../tests/fake-agent/harness.mjs";
import {
  CLAUDE_PERSONAL_ENV,
  inheritPersonalEnv,
  installLaunchHook,
  LAUNCH_VALUE,
} from "../../../tests/fake-agent/launch-settings.mjs";
import { startRunner } from "../../../tests/fake-agent/local.mjs";
import { scanReplays } from "../../../tests/fake-agent/replay-privacy.mjs";

const [binary, mode] = process.argv.slice(2);
const live = mode === "--live";
assert.ok(mode === undefined || live, "Use --live to opt in to the installed Claude CLI");
assert.ok(!live || !process.env.CI, "Real Claude tests are local only");
if (!live) await scanReplays("claude");

const source = fileURLToPath(new URL("../", import.meta.url));
const h = await agentHarness({ binary, name: "claude-turns" });
const { ai, chat } = h.api;

const wire = turnWire();
const executable = () => join(h.scratch, "bin", "claude");
const cleanup = [];
const hello = "Remember the code word TIDAL. Reply only: Hello Tokamak.";
const recall = "What was the code word? Reply only with the code word.";
const counting =
  "Print the integers from 1 through 1000, with a separate line for each integer. Do not use tools.";
const longCommand =
  "Use Bash to run the exact command sleep 20. Then reply only TOO_LATE. Do not invoke any other tool.";
const todo =
  "Use TodoWrite to create a task called Write fixture, state in_progress. Use Write to create todo-smoke.txt with TOKAMAK_TEST as content. Use an Explore helper to check whether this file exists, without reading other files. Mark the task completed with TodoWrite, then say DONE.";
try {
  await h.assertLocalRuntime();
  build(source);
  await cp(join(source, "dist"), join(h.plugins, "claude"), { recursive: true });
  if (!live) {
    await inheritPersonalEnv(h, "claude", CLAUDE_PERSONAL_ENV);
    await installReplay();
  }
  const launch = live ? undefined : await installLaunchHook(h);
  const runner = live && binary.split(/[\\/]/).pop()?.startsWith("tokamak-runner");
  const address = runner ? undefined : await h.serve("local", { windowRouted: !live });
  const client = live
    ? await realClient(address)
    : await h.connect(address, {
        local: true,
        observe: wire.observe,
        env: { CLAUDE_CONFIG_DIR: join(h.home, ".claude") },
      });
  const info = () => aboutClaude(client);
  assert.equal((await info())?.signedIn, true, "Claude is listed as signed in");
  const turns = agentTurns({
    h,
    client,
    agent: { id: "claude", name: "Claude" },
    model: "sonnet",
    effort: "low",
    timeout: live ? 120_000 : undefined,
  });
  const run = async (name, prompt, options) => turns.run(await caseFolder(name), prompt, options);
  if (live) {
    const signedOut = await realClient(address, await h.folder("signed-out-profile"));
    assert.deepEqual(readyState(await aboutClaude(signedOut)), [true, false]);
  } else {
    await discovery(client);
    const personal = join(h.home, ".claude");
    const personalLogin = join(personal, ".credentials.json");
    await writeFile(personalLogin, "signed-out");
    const hookEnv = { TOKAMAK_LAUNCH_TEST: LAUNCH_VALUE, CLAUDE_CONFIG_DIR: personal };
    await launch.set(hookEnv);
    try {
      const folder = await caseFolder("hello-launch");
      await mkdir(join(folder, ".claude"));
      await writeFile(join(folder, "CLAUDE.md"), "# Project instructions");
      await writeFile(join(folder, ".claude", "settings.json"), '{"hooks":{}}');
      await writeFile(join(folder, ".mcp.json"), '{"mcpServers":{}}');
      await h.gate(folder, "go");

      const noAuth = await turns.run(folder, hello, { state: "failed" });
      assert.match(noAuth.error, /must provide ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
      assert.equal(await Bun.file(join(folder, "isolated-home")).exists(), false);

      const auth = { ...hookEnv, ANTHROPIC_API_KEY: "fake-turn-key-1" };
      await launch.set({ ...auth, TOKAMAK_REPLAY_OLD: "old-cli-fixture" });
      const { threadId, messageId } = await client.mutation(h.api.chat.threads.start, {
        text: hello,
        folder: { kind: "chosen", path: folder },
      });
      const outdated = await client.action(h.api.ai.run.turn, {
        windowId: "claude-launch-setup",
        threadId,
        messageId,
        folder,
        agentId: "claude",
      });
      assert.equal(outdated.kind, "NotInstalled");
      assert.equal(outdated.data.updateRequired, "Claude needs Claude Code 2.1.330 or later.");
      assert.equal(await Bun.file(join(folder, "isolated-home")).exists(), false);
      await launch.set(auth, ["--permission-mode=default"]);
      const owned = await turns.run(folder, hello, { state: "failed" });
      assert.match(owned.error, /launch-first.*--permission-mode.*Tokamak/);
      assert.equal(await Bun.file(join(folder, "isolated-home")).exists(), false);

      await launch.set(auth, ["--disable-slash-commands"]);
      const isolated = await turns.run(folder, hello);
      assert.equal(isolated.text, "Hello Tokamak.");
      assert.ok(isolated.row.sessionId);
      const home = await readFile(join(folder, "isolated-home"), "utf8");
      assert.match(home, /[/]ai[/]launch-homes[/]/);
      assert.equal((await stat(home)).mode & 0o777, 0o700);
      assert.equal(await Bun.file(join(home, "cli-state")).exists(), true);

      await launch.set({ ...auth, ANTHROPIC_API_KEY: "fake-turn-key-2" }, ["--disable-slash-commands"]);
      const resumed = await turns.run(folder, recall, { threadId: isolated.threadId });
      assert.equal(resumed.text.trim(), "TIDAL");
      assert.equal(resumed.row.sessionId, isolated.row.sessionId);
      assert.equal(await readFile(join(folder, "isolated-home"), "utf8"), home);

      assert.equal(
        await client.action(h.api.chat.threads.removeLocal, { threadId: isolated.threadId }),
        null,
      );
      await assert.rejects(stat(home), { code: "ENOENT" });
      assert.equal(await readFile(personalLogin, "utf8"), "signed-out");
      assert.ok(!JSON.stringify(isolated).includes(LAUNCH_VALUE));
      passed(
        "launch preserves Claude project inputs, strips inherited env, resumes across keys, and cleans up",
      );
    } finally {
      await launch.clear();
      await writeFile(personalLogin, "signed-in");
    }
    const keychain = join(h.home, "claude-replay-signed-out");
    await writeFile(keychain, "");
    try {
      const failed = await run("signed-out", hello, { state: "failed" });
      assert.equal(
        failed.row.error,
        "Claude is signed out. Sign in, then come back. Run `claude auth login`.",
      );
      assert.deepEqual(readyState(await info()), [true, false]);
    } finally {
      await unlink(keychain);
    }
    assert.deepEqual(readyState(await info()), [true, true]);
    for (const probe of ["healthy", "invalid", "timeout"]) {
      const started = performance.now();
      try {
        const failed = await run(`rate-limit-${probe}`, hello, { state: "failed" });
        assert.equal(failed.row.error, "Rate limit reached", `${probe} setup probe`);
        assert.equal(await Bun.file(join(h.home, "claude-replay-unexpected-models")).exists(), false);
        if (probe === "timeout")
          assert.ok(performance.now() - started < 4_500, "A timed-out setup probe must not hold the turn");
      } finally {
        await unlink(join(h.home, "claude-replay-start-failed")).catch(() => {});
      }
      assert.deepEqual(readyState(await info()), [true, true]);
    }
  }
  passed("signed-in and signed-out discovery");
  await resume(turns, run);
  passed("reply and resumed session");
  await recover(turns);
  passed("lost session recovery with history");
  const overlap = live ? (_name, exercise) => exercise() : overlappingHello(h, run, hello);
  await overlap("stop-streaming", () => stopStreaming(run));
  passed("stop while streaming");
  await stopRunningTool(run);
  passed("stop while a command runs");
  await steerTurns(run);
  await permissionCases({ h, run, turns, overlap, live, caseFolder, passed });
  if (!live) await resistantTurns({ h, client, hello, overlap, wire });
  await reports(run);
  if (!live) {
    await claudeSnapshots(h, hello);
  }
  console.log(
    `Claude ${live ? "live" : "replay"}: discovery, streaming, storage, resume, steer, stop, permission answers and all report kinds`,
  );
} finally {
  for (const stop of cleanup.reverse()) await stop();
  await h.close();
}

async function aboutClaude(client) {
  return (await client.action(ai.agents.list, {})).find(({ id }) => id === "claude")?.info;
}

function caseFolder(name) {
  return h.folder(`claude-${name}`);
}

async function realClient(address, profile = process.env.CLAUDE_CONFIG_DIR) {
  // These are the client's relevant environment entries. Claude gets any
  // gateway settings from its own profile, not ANTHROPIC_* exports here.
  const env = { HOME: homedir(), ...(profile && { CLAUDE_CONFIG_DIR: profile }) };
  for (const key of [
    "PATH",
    "USER",
    "LANG",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!address) {
    const dir = await h.folder("live-runners");
    const instance = await startRunner({
      binary,
      plugins: h.plugins,
      directory: join(dir, crypto.randomUUID()),
      env,
    });
    cleanup.push(instance.stop);
    return connect(instance.endpoint.ws, {
      cleanup,
      launch: instance.launch,
      token: instance.endpoint.token,
    });
  }
  return h.connect(address, { local: true, env });
}

async function installReplay() {
  const impl = join(source, "tests/replay.mjs");
  await writeFile(executable(), `#!/bin/sh\nexec "${bunPath()}" "${impl}" "$@"\n`);
  await chmod(executable(), 0o755);
}

async function discovery(client) {
  const info = () => aboutClaude(client);
  const ready = await info();
  assert.equal(ready.installed, true);
  assert.ok(ready.models.find((model) => model.id === "sonnet")?.efforts.includes("high"));
  // Every model Claude offers stays a choice, named by the model it runs: the default (which
  // follows the account) says it is the default, and the alias it points at keeps its own entry.
  assert.deepEqual(
    ready.models.map(({ id, name }) => ({ id, name })),
    [
      { id: "default", name: "Opus 5.5 (default)" },
      { id: "opus", name: "Opus 5.5" },
      { id: "sonnet", name: "Sonnet 5.5" },
      { id: "haiku", name: "Haiku 5.5" },
    ],
  );
  assert.deepEqual(ready.speeds, []);
  const profile = join(h.home, ".claude");
  await mkdir(profile);
  const marker = join(profile, ".credentials.json");
  await writeFile(marker, "signed-out");
  assert.deepEqual(readyState(await info()), [true, false]);
  for (const fixture of ["expired-iso", "expired-ms", "expired-seconds"]) {
    await writeFile(marker, fixture);
    assert.deepEqual(readyState(await info()), [true, false], `Past loginExpiresAt: ${fixture}`);
  }
  await writeFile(marker, "old");
  const old = await info();
  assert.deepEqual(readyState(old), [false, false]);
  assert.equal(old.install, "claude update");
  assert.equal(old.updateRequired, "Claude needs Claude Code 2.1.330 or later.");
  const { threadId, messageId } = await client.mutation(chat.threads.start, {
    text: "Check whether Claude needs an update",
    folder: { kind: "chosen", path: h.home },
  });
  const rejected = await client.action(ai.run.turn, {
    threadId,
    messageId,
    folder: h.home,
    agentId: "claude",
  });
  assert.equal(rejected.kind, "NotInstalled");
  assert.equal(rejected.data.updateRequired, old.updateRequired);
  await rename(executable(), executable() + "-held");
  assert.deepEqual(readyState(await info()), [false, false]);
  await rename(executable() + "-held", executable());
  await writeFile(marker, "");
  assert.deepEqual(readyState(await info()), [true, true]);
}

function readyState(info) {
  return [info.installed, info.signedIn];
}

async function resume(turns, run) {
  const first = await run(
    "hello",
    hello,
    live
      ? {}
      : {
          async during(turn) {
            const part = await turn.firstText();
            assert.equal(part.status, "streaming");
            assert.equal(part.parts[0].text, "Hello Tokamak");
            const lastWrite = wire.hold(".");
            try {
              await h.gate(await caseFolder("hello"), "go");
              await lastWrite.pending();
              const saved = await turn.messageUntil(
                "the final text saved while its acknowledgement is held",
                (message) => message.parts[0]?.text === "Hello Tokamak.",
              );
              assert.equal(saved.status, "streaming");
              assert.equal(lastWrite.finishSent(), false);
            } finally {
              lastWrite.release();
            }
          },
        },
  );
  assert.ok(first.row.sessionId);
  if (live) assert.match(first.text, /Hello Tokamak\./);
  else {
    assert.equal(first.text, "Hello Tokamak.");
    assert.equal(first.row.sessionId, "ed0f9193-a023-4ab1-a74c-a8bba2877dc3");
  }

  const resumed = await turns.run(first.folder, recall, { threadId: first.threadId });
  assert.equal(resumed.row.sessionId, first.row.sessionId);
  assert.equal(resumed.text.trim(), "TIDAL");
  if (!live)
    assert.deepEqual(resumed.reply.usage, {
      inputTokens: 27451,
      cachedInputTokens: 25510,
      outputTokens: 7,
      costUsd: 0.0103275,
    });
}

async function recover(turns) {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const folder = await caseFolder("lost");
  const threadId = await turns.seedLostSession(folder, {
    sessionId,
    prompt: "Remember the code word TIDAL.",
    text: "I will remember.",
  });
  const recovered = await turns.run(folder, recall, { threadId });
  assert.equal(recovered.text.trim(), "TIDAL");
  assert.ok(recovered.row.sessionId);
  assert.notEqual(recovered.row.sessionId, sessionId);
}

function runningCommand(turn) {
  return turn.replyUntil("the running command", (reply) => reply.current?.kind === "command");
}

async function stopStreaming(run) {
  const stopped = await run("stop", counting, {
    state: "stopped",
    async during(turn) {
      await turn.firstText();
      await turn.stop();
    },
  });
  if (live) assert.ok(stopped.text.trim() && !/\b1000\b/.test(stopped.text));
  else assert.equal(stopped.text, "1\n2\n3\n4");
  const usage = stopped.reply.usage;
  assert.ok(usage && usage.outputTokens < 500, "The interrupted result was saved");
}

async function stopRunningTool(run) {
  const stopped = await run("stop-tools", longCommand, {
    state: "stopped",
    async during(turn) {
      const { current } = await runningCommand(turn);
      if (!live) assert.equal(current.title, "sleep 20");
      await turn.stop();
    },
  });
  assert.ok(
    (await stopped.steps()).some(
      ({ kind, title, state }) => kind === "command" && (live || title === "sleep 20") && state === "done",
    ),
  );
  assert.doesNotMatch(stopped.text, /TOO_LATE/);
  assert.ok(stopped.row.sessionId && stopped.reply.usage);
}

async function steerTurns(run) {
  const steer = "Correction: stop listing numbers and say STEERED. Do not use tools.";
  const steered = await run("steer", counting.replace("1000", "300"), {
    async during(turn) {
      await turn.firstText();
      await turn.steer(steer);
    },
  });
  assert.match(steered.text.trim(), /\S\n\nSTEERED$/);
  assert.equal(steered.row.state, "done");
  assert.equal(steered.row.error, undefined);
  assert.deepEqual(steered.reply.steers, [steer]);
  if (live) {
    assert.ok(steered.text.length < 200, "The steer cuts off the count well before 300");
  } else {
    assert.equal(steered.text, "1\n2\n3\n4\n5\n6\n7\n8\n\nSTEERED");
    assert.deepEqual(steered.reply.usage, {
      inputTokens: 55554,
      cachedInputTokens: 24302,
      outputTokens: 6,
      costUsd: 0.16711320000000002,
    });
    const raced = await run("steer-race", counting.replace("1000", "300"), {
      async during(turn) {
        await turn.firstText();
        await turn.steer(steer);
      },
    });
    assert.equal(raced.text, Array.from({ length: 300 }, (_, i) => i + 1).join("\n") + "\n\nSTEERED");
    assert.deepEqual(raced.reply.steers, [steer]);
    assert.deepEqual(raced.reply.usage, {
      inputTokens: 110447,
      cachedInputTokens: 24302,
      outputTokens: 607,
      costUsd: 0.16711320000000002,
    });

    const second = "One more correction: only say LAST.";
    const twice = await run("steer-twice", counting.replace("1000", "300"), {
      async during(turn) {
        await turn.firstText();
        await turn.steer(steer);
        await turn.steer(second);
      },
    });
    assert.equal(twice.text, steered.text + "\n\nLAST");
    assert.deepEqual(twice.reply.steers, [steer, second]);
    assert.deepEqual(
      (await twice.steps()).map(({ title, state }) => ({ title, state })),
      [{ title: "sleep 20", state: "done" }],
    );
  }
  passed("steer while streaming");
  const stopped = await run("steer-stop", counting.replace("1000", "300"), {
    state: "stopped",
    async during(turn) {
      await turn.firstText();
      await turn.steer(steer);
      await turn.stop();
    },
  });
  assert.deepEqual(stopped.reply.steers, [steer]);
  if (live) assert.ok(stopped.text.trim() && !/\b(?:300|STEERED)\b/.test(stopped.text));
  else assert.equal(stopped.text, "1\n2\n3\n4\n5\n6\n7\n8");
  passed("stop right after steer");
  const correction = "Correction: only say STEERED. Do not use tools.";
  const merged = await run(
    "steer-tools",
    "Use Bash to run the exact command sleep 3. Then reply only ORIGINAL. Do not invoke any other tool.",
    {
      async during(turn) {
        await runningCommand(turn);
        await turn.steer(correction);
      },
    },
  );
  assert.equal(merged.text.trim(), "STEERED");
  assert.deepEqual(merged.reply.steers, [correction]);
  assert.ok(
    (await merged.steps()).some(
      ({ kind, title, state }) => kind === "command" && (live || title === "sleep 3") && state === "done",
    ),
  );
  passed("steer while a command runs");
}

function passed(name) {
  if (live) console.log(`Claude PASS: ${name}`);
}

async function reports(run) {
  const progress = await run("todo-list", todo, { effort: "high" });
  assert.equal(progress.reply.hasThinking, true);
  const thinking = await progress.thinking();
  if (live) assert.ok(thinking.trim());
  else assert.match(thinking, /^TodoWrite doesn't appear[\s\S]+\n\nTodoWrite isn't available/);
  const steps = await progress.steps();
  assert.ok(steps.some((step) => step.kind === "edit" && step.state === "done"));
  if (!live) assert.ok(!steps.some((step) => step.kind === "command"), "Child steps stay out of the reply");
  assert.deepEqual(progress.reply.tasks, [{ text: "Write fixture", state: "done" }]);
  const helper = progress.reply.helpers.find(({ name }) => name === "Explore");
  assert.equal(helper?.state, "done");
  assert.equal(helper.hasText, true);
  const helperText = await progress.helper(helper);
  if (live) {
    assert.ok(helperText.trim(), "the helper's report can be opened");
    assert.equal(await readFile(join(progress.folder, "todo-smoke.txt"), "utf8"), "TOKAMAK_TEST");
    assert.ok(progress.reply.usage.outputTokens > 0);
  } else {
    assert.match(helperText, /exists/i);
    assert.deepEqual(progress.reply.usage, {
      inputTokens: 201944,
      cachedInputTokens: 192317,
      outputTokens: 1083,
      costUsd: 0.0738192,
    });
    assert.match(progress.text, /^DONE/);
  }
  if (!live) {
    const writes = wire.writes(progress.row._id);
    console.log(`Claude to-do writes: ${writes}`);
    assert.ok(writes === 2 || writes === 3);
  }
  passed("thinking, file edit, tasks, helper and usage reports");
  const plan = await run(
    "plan",
    live
      ? "Use EnterPlanMode, write the trivial plan Say hello to Claude’s designated plan file, then present it with ExitPlanMode. Do not edit project files."
      : "Use ExitPlanMode tool to propose the trivial plan: Say hello.",
    {
      access: "ask",
      answers: 1,
      async during(turn) {
        const question = await turn.question();
        assert.equal(question.subject, "the proposed plan");
        await turn.answer(question, "approve");
      },
    },
  );
  assert.match(plan.reply.plan, live ? /say hello/i : /Plan: Say hello/);
  passed("plan permission and report");
}
