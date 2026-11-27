import { testTemp } from "../support/paths.mjs";
// First visible text after Send, using the same Runner and plugin builds in both lanes.
// Run with the Runner beside its matching plugin host.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { connect, watchQuery } from "../fake-agent/harness.mjs";
import { startRunner } from "../fake-agent/start-runner.ts";
import { createApi } from "../../node_modules/@tokamak/sdk/src/index.ts";
import { prepareReplayAgents } from "./support/agents.mjs";
import { cleanScratch } from "./support/scratch.mjs";

const [path, mode] = process.argv.slice(2);
assert.ok(path && (mode === undefined || mode === "--real"), "Pass a Runner path and optionally --real");
const real = mode === "--real";
assert.ok(!real || !process.env.CI, "Real Codex tests are local only");
const binary = resolve(path);
const count = real ? 5 : 20;
const trace = process.env.TOKAMAK_FIRST_TEXT_TRACE === "1";
let mark = () => {};
function observedLaunch(launch) {
  if (!trace) return launch;
  return (artifact, receive, closed, workspace) =>
    launch(
      artifact,
      (frame) => {
        if (frame.type === "op") {
          const { name, payload } = frame;
          if (name === "local.contracts") mark(`discover ${payload.name}`);
          else if (name === "local.contract.call" || name === "local.contract.describe")
            mark(`${payload.plugin}.${payload.method ?? "describe"}`);
          else if (name === "auth.current") mark(`${frame.plugin ?? artifact.id} auth.current`);
          else if (name === "plugin.call") mark(payload.name);
        }
        receive(frame);
      },
      closed,
      workspace,
    );
}
const scratch = await mkdtemp(join(testTemp, "first-text-"));
const ai = createApi("ai");
const chat = createApi("chat");

async function sample(client, folder) {
  const cleanup = [];
  const { threadId, messageId } = await client.mutation(chat.threads.start, {
    text: real ? "Reply only: Hello from Codex. Do not use tools." : "Reply only: Hello from Codex.",
    folder: { kind: "chosen", path: folder },
  });
  const messages = watchQuery(client, chat.messages.list, { threadId }, cleanup);
  try {
    // Subscribe before Send. Time ends when the real Chat subscription delivers text.
    await messages.until("subscription ready", (rows) => rows.some(({ _id }) => _id === messageId));
    const started = performance.now();
    const events = [];
    if (trace) mark = (event) => events.push([Math.round(performance.now() - started), event]);
    const text = messages
      .until(
        "first visible reply text",
        (rows) => rows.some(({ _id, parts }) => _id !== messageId && parts.some((part) => part.text)),
        120_000,
      )
      .then(() => {
        mark("first text");
        if (trace) console.error(JSON.stringify(events));
        mark = () => {};
        return performance.now() - started;
      });
    const finished = client
      .action(ai.run.turn, {
        threadId,
        messageId,
        folder,
        agentId: "codex",
        ...(!real && { effort: "medium" }),
      })
      .then((result) => assert.equal(result.state, "done", JSON.stringify(result)));
    const [elapsed] = await Promise.all([text, finished]);
    return elapsed;
  } finally {
    for (const stop of cleanup) stop();
  }
}

function summarize(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    medianMs: sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samplesMs: samples,
  };
}

try {
  const { plugins, env } = await prepareReplayAgents(scratch, {
    code: true,
    artifacts: process.env.TOKAMAK_AGENT_FIXTURES ?? join(dirname(binary), "fixtures"),
  });
  const cold = [];
  const warm = [];
  for (let i = 0; i < count; i++) {
    const folder = join(scratch, String(i), "hello");
    await mkdir(folder, { recursive: true });
    function git(...args) {
      const result = Bun.spawnSync(["git", "-C", folder, ...args], { stderr: "inherit" });
      assert.equal(result.exitCode, 0, `git ${args.join(" ")}`);
      return result.stdout.toString().trim();
    }
    git("init", "-q");
    await Bun.write(join(folder, "README.md"), "A sample project.\n");
    git("add", "README.md");
    git("-c", "user.name=Tokamak", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture");
    const runner = await startRunner({
      binary,
      plugins,
      directory: join(scratch, "runner-" + i),
      env: {
        ...env,
        ...(real && {
          HOME: homedir(),
          PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
          CODEX_HOME: process.env.CODEX_HOME,
        }),
      },
    });
    const cleanup = [];
    try {
      const client = await connect(runner.endpoint.ws, {
        launch: observedLaunch(runner.launch),
        token: runner.endpoint.token,
        cleanup,
      });
      cold.push(await sample(client, folder));
      warm.push(await sample(client, folder));
      assert.equal(git("for-each-ref", "--format=%(refname)", "refs/tokamak").split("\n").length, 4);
      console.error(`Sample ${i + 1}/${count} completed`);
    } finally {
      for (const close of cleanup.reverse()) await close();
      await runner.stop();
    }
  }
  console.log(
    JSON.stringify(
      { agent: real ? "codex" : "codex replay", cold: summarize(cold), warm: summarize(warm) },
      null,
      2,
    ),
  );
} finally {
  if (!process.env.TOKAMAK_TEST_TEMP) await cleanScratch(scratch);
}
