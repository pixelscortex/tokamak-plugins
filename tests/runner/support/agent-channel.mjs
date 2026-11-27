import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentTurns } from "../../fake-agent/agent-turn.mjs";
import { within } from "../../fake-agent/harness.mjs";
import { editBundle, until } from "../../support/routing.mjs";

const unknown = "@unknown-report";
const skew = "@skewed-version";
const tail = "tail already in flight";
const burst = "burst" + "x".repeat(1024);
const streamed = "stream:" + "x".repeat(1024);
const tooLong = "message is too long to send to the agent";

/** Keep production providers and inject deterministic turns for interleavings a CLI tape cannot control. */
export async function channelFixtures(plugins, scratch) {
  const old = join(plugins, "old-agent");
  await cp(join(plugins, "codex"), old, { recursive: true });
  const file = join(old, "manifest.json");
  const manifest = await Bun.file(file).json();
  manifest.plugin.id = "old-agent";
  manifest.contractProviders[0].declarationHash = "0".repeat(64);
  await writeFile(file, JSON.stringify(manifest));
  await editBundle(old, 'throw new Error("Version-skew test must not evaluate this provider");');

  await editBundle(
    join(plugins, "ai"),
    `import { readFile as channelRead, writeFile as channelWrite } from "node:fs/promises";
let pressureWrites = Promise.resolve();
const steerCommitAttempts = new Map();
async function recordSteerWithFailures(write, text, delivery) {
  if (delivery === "delivered" && (text === "next" || text === "finish")) {
    const attempt = (steerCommitAttempts.get(text) ?? 0) + 1;
    steerCommitAttempts.set(text, attempt);
    await channelWrite(${JSON.stringify(join(scratch, "steer-commits"))}, text + ":" + attempt + "\\n", { flag: "a" });
    if (text === "finish" || attempt === 1) throw new Error("injected steer commit failure");
  }
  return write();
}
function writeUnderPressure(write, slow) {
  const result = pressureWrites.then(async () => {
    if (slow) await new Promise((resolve) => setTimeout(resolve, 125));
    return write();
  });
  pressureWrites = result.catch(() => {});
  return result;
}
async function channelGate(path) {
  while (!(await channelRead(path).then(() => true, () => false))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}`,
    (code) => {
      const open = "async (method, value) => {";
      assert.ok(code.includes(open), "ai channel receiver seam");
      const force = 'channel.send("forceStop",';
      assert.ok(code.includes(force), "ai Force stop seam");
      const version = "version: AGENT_TURN_PROTOCOL";
      assert.ok(code.includes(version), "ai channel version seam");
      const writer = "await ctx.runMutation(api.turns.write, args)";
      assert.ok(code.includes(writer), "ai report writer seam");
      const steer = "ctx.runMutation(api.turns.steer, { turnId, text, ...delivery && { delivery } })";
      assert.ok(code.includes(steer), "ai steer mutation seam");
      return code
        .replace(
          version + " }, async",
          `version: request.prompt === "${skew}" ? 1 : AGENT_TURN_PROTOCOL }, async`,
        )
        .replace(
          open,
          `${open}
        if (method === "report") {
          const events = value.events;
          if (request.prompt === "${unknown}") value.events = [...events, {kind:"futureEvent"}];
          if (events.some((event) => event.value === "foreign report"))
            await channelWrite(${JSON.stringify(join(scratch, "peer-destinations"))}, JSON.stringify([turnId, value.turnId]) + "\\n", { flag: "a" });
          if (events.some((event) => event.value === "${tail}")) {
            await channelWrite(request.folder + "/report-ready", "");
            await channelGate(request.folder + "/report-release");
          }
        }
        `,
        )
        .replace(
          force,
          `(request.prompt === "@force-report"
          ? channelWrite(request.folder + "/force-sent", "") : Promise.resolve()).then(() => channel.send("forceStop",`,
        )
        .replace("{ ...address }).catch(() => {}),", "{ ...address })).catch(() => {}),")
        .replace(steer, `recordSteerWithFailures(() => ${steer}, text, delivery)`)
        .replace(
          writer,
          `await (args.thinking?.startsWith("burst") || args.thinking === "slow writer"
            ? writeUnderPressure(() => ctx.runMutation(api.turns.write, args), args.thinking === "slow writer")
            : ctx.runMutation(api.turns.write, args))`,
        );
    },
  );

  for (const id of ["claude", "codex"]) {
    await editBundle(
      join(plugins, id),
      `import { readFile as turnRead, writeFile as turnWrite } from "node:fs/promises";
async function turnGate(path) {
  while (!(await turnRead(path).then(() => true, () => false))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const fixtureRegistration = Object.keys(contractProviders)[0];
const fixtureProvider = contractProviders[fixtureRegistration];
const realAgent = fixtureProvider.implementation;
let fixtureDiscovery;
let releaseBurst;
contractProviders[fixtureRegistration] = { ...fixtureProvider, implementation: {
  ...realAgent,
  info: { ...realAgent.info, invokeLocal: (...args) => fixtureDiscovery ??= realAgent.info.invokeLocal(...args) },
  start: { ...realAgent.start, async invokeLocal(run, bridge, auth) {
    const sessionId = ${JSON.stringify(id + "-fixture")};
    const last = () => ({ sessionId });
    const stopped = () => ({ sessionId, stopped: true });
    const folder = run.folder;
    if (run.prompt.startsWith("@burst")) {
      run.text(run.prompt);
      await turnWrite(folder + "/ready-" + run.prompt.slice(7), "");
      await (releaseBurst ??= turnGate(${JSON.stringify(join(scratch, "release-burst"))}));
      for (let index = 0; index < 6; index++) {
        run.thinking(${JSON.stringify(burst)});
        if (index === 2) await new Promise((resolve) => setImmediate(resolve));
      }
      if (await run.ask({kind:"test",action:"read",subject:"burst"}) !== "approve")
        throw new Error("Full access did not approve the replay question");
      run.text(":done");
      return last();
    }
    if (run.prompt.startsWith("@history ")) {
      run.text(JSON.stringify({ promptLength: run.prompt.length, history: run.history.map(({text}) => text) }));
      return last();
    }
    if (run.prompt === "@stream") {
      run.thinking("slow writer");
      for (let index = 0; index < 128; index++) {
        run.text(${JSON.stringify(streamed)});
        run.plan(index + "x".repeat(48 * 1024));
        run.usage({ inputTokens: index, outputTokens: 1 });
      }
      await turnGate(folder + "/go");
      return last();
    }
    if (run.prompt === "@flood") {
      // Catch a synchronous limit error, as an author might. The turn still fails.
      try {
        for (let i = 0; i < 4; i++)
          run.helper({ id: "helper-" + i, name: "helper", title: "large output", text: "x".repeat(240 * 1024), state: "done" });
      } catch {}
      return last();
    }
    if (run.prompt === "@steer-order") {
      run.onSteer(async (text) => {
        await turnWrite(folder + "/steer-" + text, "");
        if (text === "fail") throw new Error("steer rejected by replay");
        run.text("reaction:" + text);
        await turnGate(folder + "/go");
      });
      run.text("ready;");
      await turnGate(folder + "/go-end");
      return last();
    }
    if (run.prompt.startsWith("@foreign ")) {
      const address = JSON.parse(run.prompt.slice("@foreign ".length));
      await bridge.channel.send("report", { ...address, events: [{kind:"text",value:"foreign report"}] });
      run.text("origin reply");
      return last();
    }
    if (run.prompt === "@hold") {
      run.text("held");
      await turnGate(folder + "/go");
      run.text("-finished");
      return last();
    }
    if (run.prompt === "@stop-before-handler") {
      run.text("before handler");
      await turnGate(folder + "/go");
      await new Promise((resolve) => run.onStop(resolve));
      return stopped();
    }
    if (run.prompt === "@force-report") {
      run.text("ready: ");
      run.tool({ id:"step", kind:"read", title:"step", state:"running" });
      await turnGate(folder + "/go");
      run.text(${JSON.stringify(tail)});
      run.tool({ id:"step", kind:"read", title:"step", state:"done" });
      await new Promise(() => {});
    }
    if (run.prompt === "@busy") {
      const program = bridge.proc(["/bin/sh","-c",'echo "$$"; exec /bin/sleep 120'], { cwd: folder });
      for await (const line of program.stdout) {
        await turnWrite(folder + "/busy-pid", line);
        break;
      }
      run.text("ready to spin");
      await turnGate(folder + "/go");
      await turnWrite(folder + "/spinning", "");
      while (true) {}
    }
    if (run.prompt === ${JSON.stringify(unknown)}) {
      run.text("trigger unknown report");
      return last();
    }
    return realAgent.start.invokeLocal(run, bridge, auth);
  }},
} };
`,
    );
  }
}

export function checkSkew(agents) {
  const old = agents.find(({ id }) => id === "old-agent");
  assert.equal(old?.info.installed, false);
  assert.equal(
    old.info.updateRequired,
    "old-agent was built for a different version of ai's agent contract; rebuild or update it.",
  );
  for (const id of ["claude", "codex"]) {
    const info = agents.find((agent) => agent.id === id)?.info;
    assert.equal(info?.installed, true, `${id}: ${JSON.stringify(info)}`);
  }
}

export async function exerciseChannels({
  client,
  open,
  ai,
  chat,
  scratch,
  folder,
  processInfo,
  claudeTurns,
}) {
  await checkForceAndSteer({
    client,
    ai,
    folder,
    scratch,
    processInfo,
    claudeTurns,
    async whileWaiting() {
      await checkVersionAndSize({ client, ai, chat, folder, claudeTurns });
      await checkReportPressure({ folder, claudeTurns });
    },
  });
  console.log(
    "Channel replay checked version skew, payload size, cross-invocation routing, early Stop, and scoped Force stop.",
  );
  // Each window has its own workspace socket, but all turns share one ai
  // host and its queues. Don't exercise unrelated server socket limits here.
  const windows = await Promise.all(Array.from({ length: 8 }, () => open()));
  await checkCapacity({ windows, ai, chat, scratch });
}

async function checkVersionAndSize({ client, ai, chat, folder, claudeTurns }) {
  const skewed = await claudeTurns.run(await folder("skew"), skew, { state: "failed" });
  assert.match(skewed.row.error, /ai uses version 1; the plugin host uses version 2/);
  const invalid = await claudeTurns.run(await folder("unknown"), unknown, { state: "failed" });
  assert.match(invalid.row.error, /Unknown agent turn report event: futureEvent/);
  assert.equal(invalid.text, "", "the valid prefix of an invalid batch was not saved");
  const project = await folder("large-prompt");
  const { threadId } = await client.mutation(chat.threads.start, {
    text: "h".repeat(740 * 1024),
    folder: { kind: "chosen", path: project },
  });
  await client.mutation(chat.messages.post, { threadId, text: "newest history" });
  const fittingPrompt = "@history " + "😀".repeat(80_000);
  const fitted = await claudeTurns.run(project, fittingPrompt, { threadId });
  assert.deepEqual(JSON.parse(fitted.text), {
    promptLength: fittingPrompt.length,
    history: ["1 earlier message of this thread is left out.", "newest history"],
  });

  const prompt = "p".repeat(1009 * 1024);
  const messageId = await client.mutation(chat.messages.post, { threadId, text: prompt });
  await assert.rejects(
    client.action(ai.run.turn, { threadId, messageId, folder: project, agentId: "claude" }),
    new RegExp(tooLong),
  );
  assert.ok(!(await client.query(ai.turns.list, { threadId })).some((turn) => turn.messageId === messageId));

  const settings = { threadId, agent: { id: "claude", name: "Claude" }, model: "sonnet", access: "full" };
  const queued = await client.mutation(ai.turns.enqueue, { ...settings, text: prompt });
  const next = await client.mutation(ai.turns.enqueue, { ...settings, text: "@hold" });
  const start = (queued) =>
    client.action(ai.run.turn, { threadId, messageId: queued.messageId, folder: project, agentId: "claude" });
  assert.deepEqual(await start(queued), { turnId: queued.turnId, state: "failed" });
  const message = (await client.query(chat.messages.list, { threadId })).find(
    ({ _id }) => _id === queued.messageId,
  );
  assert.equal(message.status, "error");
  assert.match(message.error, new RegExp(tooLong));
  assert.equal((await start(queued)).kind, "Answered");
  await writeFile(join(project, "go"), "");
  assert.deepEqual(await start(next), { turnId: next.turnId, state: "done" });
}

async function checkReportPressure({ folder, claudeTurns }) {
  const stream = await folder("fast-stream");
  const ready = Promise.withResolvers();
  const streamedTurn = claudeTurns.run(stream, "@stream", {
    async during(control) {
      await control.firstText();
      ready.resolve();
    },
  });
  void streamedTurn.catch(ready.reject);
  try {
    await ready.promise;
    const failed = await claudeTurns.run(await folder("flood"), "@flood", { state: "failed" });
    assert.match(failed.row.error, /The agent produced output faster than it could be saved/);
  } finally {
    await writeFile(join(stream, "go"), "");
  }
  const saved = await streamedTurn;
  assert.equal(saved.text, streamed.repeat(128));
  assert.equal(saved.reply.plan, "127" + "x".repeat(48 * 1024));
  assert.deepEqual(saved.reply.usage, { inputTokens: 127, outputTokens: 1 });
}

async function checkForceAndSteer({ client, ai, folder, scratch, processInfo, claudeTurns, whileWaiting }) {
  const steerProject = await folder("steer-order");
  const steered = await claudeTurns.run(steerProject, "@steer-order", {
    async during(control) {
      await control.firstText();
      const { _id: turnId, replyId } = await control.replyUntil("steer turn", () => true);
      const steers = () => client.query(ai.turns.replySteers, { replyId });
      assert.match(
        (await client.action(ai.run.steer, { turnId, text: "fail" })).error,
        /steer rejected by replay/,
      );
      assert.deepEqual(await steers(), []);
      const sent = control.steer("next");
      void sent.catch(() => {});
      await control.messageUntil("steer reaction", (row) => row.parts[0]?.text.includes("reaction:next"));
      assert.deepEqual(await steers(), ["next"], "steer precedes the reaction, even before acknowledgement");
      await writeFile(join(steerProject, "go"), "");
      await sent;
      assert.equal(await readFile(join(scratch, "steer-commits"), "utf8"), "next:1\nnext:2\n");
      await control.steer("finish");
      assert.deepEqual(
        await steers(),
        ["next", "finish"],
        "a failed commit still shows the acknowledged steer",
      );
      await writeFile(join(steerProject, "go-end"), "");
    },
  });
  assert.deepEqual(
    await client.query(ai.turns.replySteers, { replyId: steered.row.replyId }),
    ["next", "finish"],
    "finish promotes the acknowledged steer exactly once",
  );

  const early = await folder("early-stop");
  await claudeTurns.run(early, "@stop-before-handler", {
    state: "stopped",
    async during(control) {
      await control.firstText();
      await control.stop();
      await Bun.sleep(75);
      await writeFile(join(early, "go"), "");
    },
  });

  const siblingProject = await folder("force-sibling");
  const siblingReady = Promise.withResolvers();
  const sibling = claudeTurns.run(siblingProject, "@hold", {
    async during(control) {
      await control.firstText();
      siblingReady.resolve(await control.replyUntil("sibling", () => true));
    },
  });
  void sibling.catch(siblingReady.reject);
  const target = await siblingReady.promise;
  const origin = await claudeTurns.run(
    await folder("foreign-report"),
    "@foreign " +
      JSON.stringify({
        threadId: target.threadId,
        turnId: target._id,
      }),
  );
  const destinations = (await readFile(join(scratch, "peer-destinations"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    destinations,
    [[origin.row._id, target._id]],
    "Runner only delivered to the sender's channel",
  );
  assert.equal(origin.text, "origin reply");

  const forceProject = await folder("force-report");
  const busyProject = await folder("busy");
  const forceReady = Promise.withResolvers();
  const busyReady = Promise.withResolvers();
  const stopping = (project, prompt, ready) => {
    const result = claudeTurns.run(project, prompt, {
      state: "stopped",
      async during(control) {
        await control.firstText();
        const row = await control.replyUntil("turn running", () => true);
        await control.stop();
        ready.resolve({ turnId: row._id });
      },
    });
    void result.catch(ready.reject);
    return result;
  };
  const forced = stopping(forceProject, "@force-report", forceReady);
  const busy = stopping(busyProject, "@busy", busyReady);
  const [forceArgs, busyArgs] = await Promise.all([forceReady.promise, busyReady.promise]);
  await Promise.all([
    whileWaiting(),
    until(
      "Force stop deadline",
      async () => {
        const [tailDelay, busyDelay] = await Promise.all(
          [forceArgs, busyArgs].map((args) => client.query(ai.turns.forceStopDelay, args)),
        );
        return tailDelay === 0 && busyDelay === 0;
      },
      12_000,
    ),
  ]);
  await writeFile(join(forceProject, "go"), "");
  await until("tail report in flight", () => Bun.file(join(forceProject, "report-ready")).exists());
  const force = client.action(ai.run.forceStop, forceArgs);
  void force.catch(() => {});
  await until("Force stop sent", () => Bun.file(join(forceProject, "force-sent")).exists());
  await writeFile(join(forceProject, "report-release"), "");
  assert.equal(await force, null);
  const saved = await forced;
  assert.equal(saved.text, "ready: " + tail);
  assert.equal((await saved.steps())[0].state, "done");
  const [still] = await client.query(ai.turns.list, { threadId: target.threadId });
  assert.equal(still.state, "running");
  await writeFile(join(siblingProject, "go"), "");
  assert.equal((await sibling).text, "held-finished");

  const pid = Number(await readFile(join(busyProject, "busy-pid"), "utf8"));
  assert.ok(processInfo(pid));
  await writeFile(join(busyProject, "go"), "");
  await until("agent starts spinning", () => Bun.file(join(busyProject, "spinning")).exists());
  const began = performance.now();
  assert.equal(await client.action(ai.run.forceStop, busyArgs), null);
  await busy;
  await until(
    "native Force stop reaps the spinning invocation's program",
    () => processInfo(pid) === undefined,
    2_000,
  );
  assert.ok(performance.now() - began < 4_500, "Force stop completed before the five second watchdog");
  // Discovery routes a real invocation through Claude's host; it can only
  // respond after the watchdog has reset the stuck realm.
  await until("Claude answers again after the watchdog", async () =>
    (await client.action(ai.agents.list, {})).some(({ id, info }) => id === "claude" && info.signedIn),
  );
}

async function checkCapacity({ windows, ai, chat, scratch }) {
  const turns = (agentId, client = windows[0]) =>
    agentTurns({
      h: { api: { ai, chat } },
      client,
      agent: { id: agentId, name: agentId },
      model: agentId === "claude" ? "sonnet" : "gpt-6.2-sol",
      effort: agentId === "claude" ? "low" : "medium",
      timeout: 50_000,
    });
  const launch = (agentId, index, window) => {
    const name = agentId + "-" + index;
    const result = turns(agentId, window).run(scratch, "@burst-" + name);
    const ready = Promise.race([
      until("admitted " + name, () => Bun.file(join(scratch, "ready-" + name)).exists(), 30_000),
      result.then(() => assert.fail(name + " completed before the gate")),
    ]);
    return { result, ready };
  };
  const blocked = (agentId, limit) =>
    turns(agentId)
      .run(scratch, "@burst-over-limit", {
        state: "failed",
      })
      .then(({ row }) =>
        assert.equal(
          row.error,
          limit === 32
            ? "Too many Claude turns are running (32). Wait for one to finish."
            : `Too many turns are running on this machine (${limit}). Wait for one to finish.`,
        ),
      );
  const admitted = [];
  try {
    for (const [agentIndex, id] of ["claude", "codex"].entries()) {
      for (let offset = 0; offset < 32; offset += 8) {
        const window = windows[agentIndex * 4 + offset / 8];
        const wave = Array.from({ length: 8 }, (_, index) => launch(id, offset + index, window));
        admitted.push(...wave);
        await within(Promise.all(wave.map(({ ready }) => ready)), id + " admitted another eight turns");
      }
      if (id === "claude") await blocked(id, 32);
    }
    await blocked("codex", 64);
    console.log("64 concurrent starts admitted; per-agent (32) and Runner-wide (64) overflow rejected.");
  } finally {
    await writeFile(join(scratch, "release-burst"), "");
  }
  const completed = await Promise.all(admitted.map(({ result }) => result));
  for (const [index, reply] of completed.entries()) {
    const id = index < 32 ? "claude" : "codex";
    assert.equal(reply.text, `@burst-${id}-${index % 32}:done`);
    assert.equal(await reply.thinking(), burst.repeat(6));
  }
  assert.equal(
    (await turns("claude").run(scratch, "@burst-claude-32")).text,
    "@burst-claude-32:done",
    "slot was freed",
  );
  console.log(
    "All 64 reporting turns saved their replies with serialized writes; a freed slot admitted a new turn.",
  );
}
