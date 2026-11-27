import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentTurns } from "../../../tests/fake-agent/agent-turn.mjs";
import { editBundle, inspectHosts, reload } from "../../../tests/support/routing.mjs";
import { build, workspace } from "../../../tests/fake-agent/harness.mjs";

export async function claudeSnapshots(h, hello) {
  const source = join(workspace, "plugins/code");
  build(source);
  await cp(join(source, "dist"), join(h.plugins, "code"), { recursive: true });
  build(join(workspace, "plugins/codex"));
  await cp(join(workspace, "plugins/codex/dist"), join(h.plugins, "codex"), { recursive: true });
  const address = await h.serve("snapshots");
  const client = await h.connect(address, { local: true });
  const folder = await h.folder("claude-hello-snapshots");
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: folder,
      encoding: "utf8",
      env: { HOME: h.home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git("init", "--quiet");
  await writeFile(join(folder, ".gitignore"), "go\nclaude.pid\n");
  await writeFile(join(folder, "work.txt"), "before\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Initial");

  const turns = agentTurns({
    h,
    client,
    agent: { id: "claude", name: "Claude" },
    model: "sonnet",
    effort: "low",
  });
  const runner = h.runner(address);
  let codeReloaded;
  assert.ok(runner, "Claude snapshot replay requires the Runner");
  const remembered = await grantSession(turns, await h.folder("claude-remember-snapshots"));
  const reloadDuringTurn = await reloadProviders(h, runner, client);
  const completed = await turns.run(folder, hello, {
    async during(turn) {
      await turn.firstText();
      await writeFile(join(folder, "work.txt"), "after\n");
      codeReloaded = await reloadDuringTurn(folder);
      await h.gate(folder, "go");
    },
  });
  assert.equal(completed.text, "Hello Tokamak.");
  const ref = `refs/tokamak/threads/${completed.threadId.split(":")[1]}/turns/${completed.row._id.split(":")[1]}`;
  assert.equal(git("show", `${ref}/before:work.txt`), "before");
  assert.equal(git("show", `${ref}/after:work.txt`), "after");
  assert.equal(git("rev-parse", `${ref}/after^`), git("rev-parse", `${ref}/before`));
  codeReloaded();
  const resumed = await turns.run(remembered.folder, "Try the same command again.", {
    threadId: remembered.threadId,
    access: "ask",
  });
  assert.equal(resumed.row.sessionId, remembered.row.sessionId);
  assert.equal(resumed.text, remembered.text);
  assert.deepEqual(
    (await resumed.steps()).map(({ state }) => state),
    ["done", "done"],
  );
  console.log("Claude snapshots: Code and Codex reloads kept the running turn, ai PID and session grant");
}

async function grantSession(turns, folder) {
  return turns.run(
    folder,
    "Use Bash to run the exact command touch remember-probe.txt twice as two separate consecutive tool calls, never in parallel and never chained. Both calls must be issued before answering. Then reply DONE.",
    {
      access: "ask",
      answers: 1,
      async during(turn) {
        const question = await turn.question();
        assert.equal(question.subject, "touch remember-probe.txt");
        await turn.answer(question, "approveSession");
      },
    },
  );
}

async function reloadProviders(h, runner, client) {
  const hosts = await inspectHosts(runner);
  const host = (id) => hosts().find((process) => process.id === id)?.pid;
  const listAgents = () => client.action(h.api.ai.agents.list, {});
  await listAgents(); // Warm Codex, even though this fixture doesn't have its CLI.
  const ai = host("ai");
  const claude = host("claude");
  const codex = host("codex");
  assert.ok(ai && claude && codex);
  return async (folder) => {
    const pid = Number(await readFile(join(folder, "claude.pid"), "utf8"));
    assert.ok(pid > 1);
    const code = host("code");
    assert.ok(code, "the before snapshot ran in Code's process");
    for (const id of ["code", "codex"]) {
      await editBundle(join(h.plugins, id), "/* reloaded during Claude turn */");
      await reload(runner, join(h.scratch, "snapshots"), id);
      assert.equal(host("ai"), ai);
      assert.equal(host("claude"), claude);
      process.kill(pid, 0); // Same Claude CLI is still waiting at the replay gate.
    }
    await listAgents();
    assert.ok(hosts().some(({ id, pid }) => id === "codex" && pid !== codex));
    return () => assert.ok(hosts().some(({ id, pid }) => id === "code" && pid !== code));
  };
}
