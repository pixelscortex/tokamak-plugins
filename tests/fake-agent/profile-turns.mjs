import { testModules, tokamakDir } from "../support/paths.mjs";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createApi, isFailure } from "../../node_modules/@tokamak/sdk/src/index.ts";
import { startFakeCompanies } from "../../plugins/agent-proxy/tests/fake-companies/index.ts";
import { api } from "../../plugins/ai-profiles/src/server/_generated/api.ts";
import { agentTurns } from "./agent-turn.mjs";
import { build, bunPath, copySource, workspace } from "./harness.mjs";
import { installAgentFixture } from "./launch-settings.mjs";

const model = "claude-sonnet-4-6";

function success(result) {
  assert.ok(!isFailure(result), result?.data?.message ?? result?.kind);
  return result;
}

export async function checkProfileTurns(h) {
  const proxySource = join(workspace, "plugins/agent-proxy");
  const fixture = join(h.scratch, "sources", "agent-proxy");
  await copySource(proxySource, fixture, testModules);
  // Placement discovery reads the root config; its relative extends would point into scratch.
  await writeFile(
    join(fixture, "tsconfig.json"),
    JSON.stringify({ extends: join(proxySource, "tsconfig.json") }),
  );
  await writeFile(
    join(fixture, "src/server/probe.ts"),
    `import { query } from "./_functions";
export const keyCount = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("turnKeys").collect()).length,
});
export const setCount = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("sets").collect()).length,
});`,
  );
  build(fixture);
  await cp(join(fixture, "dist"), join(h.plugins, "agent-proxy"), { recursive: true });
  const profilesSource = join(workspace, "plugins/ai-profiles");
  build(profilesSource);
  await cp(join(profilesSource, "dist"), join(h.plugins, "ai-profiles"), { recursive: true });
  const { probe } = createApi("agent-proxy", ["probe:keyCount", "probe:setCount"]);
  const manifestPath = join(h.plugins, "agent-proxy/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.plugin.permissions.push("net:127.0.0.1");
  await writeFile(manifestPath, JSON.stringify(manifest));

  await installAgentFixture(
    h,
    "recording-claude",
    `
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { action, provide } from "@tokamak/sdk";
import { agent, type Info, type Run } from "plugin:ai/contracts";
const info = action({
  on: "caller",
  handler: async (): Promise<Info> => ({
    installed: true, signedIn: true, install: "", signIn: "",
    models: [{ id: "claude-sonnet-4-6", name: "Sonnet", efforts: ["low", "high"] }], speeds: [], modes: [],
  }),
});
const start = action({
  on: "caller",
  handler: async (_ctx, run: Run) => {
    let stopped = false;
    run.onStop(() => { stopped = true; });
    await writeFile(join(run.folder, "received.json"), JSON.stringify(run.launchSettings ?? null));
    if (run.prompt === "wait" || run.prompt === "stop") {
      run.text("Ready");
      while (!stopped && (await readFile(join(run.folder, "go")).catch(() => null)) === null)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (run.prompt === "fail") throw new Error("Recording agent failed.");
    return stopped ? { sessionId: "test", stopped: true as const } : { sessionId: "test" };
  },
});
export default provide(agent, { id: "claude", name: "Recording Claude", info, start });
`,
  );

  const codexSource = join(workspace, "plugins/codex");
  build(codexSource);
  await cp(join(codexSource, "dist"), join(h.plugins, "codex"), { recursive: true });
  // The normal suite uses a deterministic app-server. The optional proof runs
  // the installed binary in the same test, with a fresh home and no off-host network.
  const offlineCodex = process.env.TOKAMAK_TEST_OFFLINE_CODEX;
  const installedCodex = offlineCodex === "1" ? Bun.which("codex") : offlineCodex;
  assert.ok(offlineCodex !== "1" || installedCodex, "Offline Codex CLI was not found on PATH");
  assert.ok(!installedCodex || isAbsolute(installedCodex));
  const blocked = installedCodex ? await (await import(join(tokamakDir, "plugins/agent-proxy/tests/cli-sandbox.ts"))).blockingProxy() : null;
  const codex = installedCodex
    ? `exec ${JSON.stringify(installedCodex)} -c 'cli_auth_credentials_store="file"' "$@"`
    : `exec ${JSON.stringify(bunPath())} ${JSON.stringify(join(workspace, "tests/fake-agent/profile-codex.mjs"))} "$@"`;
  const codexHome = join(h.home, ".codex");
  await mkdir(codexHome);
  await writeFile(
    join(h.bin, "codex"),
    `#!/bin/sh
set -eu
case "${"$"}{CODEX_HOME:-$HOME/.codex}" in
  "${codexHome}") ;;
  "${join(h.scratch, "profile-turns")}/ai/launch-homes/"*) ;;
  *) exit 9 ;;
esac
: "\${CODEX_HOME:=${codexHome}}"
export CODEX_HOME
${
  blocked
    ? `export XDG_CONFIG_HOME="$HOME" XDG_DATA_HOME="$HOME" XDG_STATE_HOME="$HOME" XDG_CACHE_HOME="$HOME"
export HTTP_PROXY="${blocked.url}" HTTPS_PROXY="${blocked.url}" ALL_PROXY="${blocked.url}" NO_PROXY="127.0.0.1,localhost"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"`
    : ""
}
${codex}
`,
    { mode: 0o700 },
  );

  const fake = await startFakeCompanies({ delayMs: 1 });
  try {
    const address = await h.serve("profile-turns", {
      env: { TOKAMAK_AGENT_PROXY_ADDRESSES: JSON.stringify(fake.addresses) },
    });
    const client = await h.connect(address);
    const { chat, ai } = h.api;
    const turns = agentTurns({ h, client, agent: { id: "claude", name: "Recording Claude" }, model });
    const profiles = api.profiles;
    const picks = api["thread-profiles"];
    const picked = (thread) => client.query(picks.selection, { thread });
    const pick = async (profile, thread) =>
      success(await client.mutation(picks.pick, { profile, ...(thread && { thread }) }));
    const receive = async (folder) => JSON.parse(await readFile(join(folder, "received.json"), "utf8"));
    const proxy = async (settings) => {
      const { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key } = settings.env;
      assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/plugins\/agent-proxy\//);
      assert.equal(key.length, 43);
      return fetch(base + "/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hello" }] }),
      });
    };
    const ended = async (settings) => {
      const response = await proxy(settings);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.message, "Turn key has ended.");
    };
    const upstream = async (settings, account) => {
      const response = await proxy(settings);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /event: message_stop/);
      assert.equal(
        fake.requests.filter(({ path }) => path.startsWith("/anthropic/v1/messages")).at(-1).account,
        account,
      );
    };

    const normal = await turns.run(await h.folder("profile-personal"), "normal");
    assert.equal(await receive(normal.folder), null);

    async function subscribe(account, as = client, company = "anthropic") {
      fake.addAccount(company, account);
      const pending = success(
        await as.action(api.subscriptions.startSignIn, {
          company,
          method: "subscription",
        }),
      );
      fake.nextSignIn(account);
      const page = await fetch(pending.link, { redirect: "manual" });
      return success(
        await as.action(api.subscriptions.finishSignIn, {
          id: pending.id,
          pasted: page.headers.get("location"),
        }),
      );
    }
    const alpha = success(await client.mutation(profiles.create, { name: "Alpha", code: "ALPH" }));
    const beta = success(await client.mutation(profiles.create, { name: "Beta", code: "BETA" }));
    const alice = await subscribe("alice");
    const bob = await subscribe("bob");
    for (const [profile, subscription] of [
      [alpha, alice],
      [beta, bob],
    ]) {
      success(await client.mutation(profiles.add, { profile: profile.id, subscription: subscription.id }));
    }

    const blocked = await turns.run(await h.folder("profile-unpicked"), "blocked", { state: "failed" });
    assert.equal(blocked.error, "Pick a profile to send.");
    assert.equal(await Bun.file(join(blocked.folder, "received.json")).exists(), false);

    async function thread(name, profile) {
      await pick(profile.id);
      const folder = await h.folder(name);
      const started = await client.mutation(chat.threads.start, {
        text: "setup",
        folder: { kind: "chosen", path: folder },
      });
      assert.equal((await picked(started.threadId)).code, profile.code);
      return { threadId: started.threadId, folder };
    }
    const a = await thread("profile-alpha", alpha);
    const b = await thread("profile-beta", beta);
    const beforeRefusals = await client.query(probe.keyCount, {});
    const unsupported = await turns.run(a.folder, "wrong agent", {
      threadId: a.threadId,
      agentId: "fake-agent",
      model: "echo",
      state: "failed",
    });
    assert.equal(unsupported.error, "Pick an available agent or another profile.");
    const wrongModel = await turns.run(a.folder, "wrong model", {
      threadId: a.threadId,
      model: "not-in-the-profile",
      state: "failed",
    });
    assert.equal(wrongModel.error, "Pick a model offered by this profile.");
    assert.equal(await Bun.file(join(a.folder, "received.json")).exists(), false);
    assert.equal(await client.query(probe.keyCount, {}), beforeRefusals);
    const catalog = await client.action(ai.agents.list, { threadId: a.threadId });
    assert.deepEqual(
      catalog.map(({ id }) => id),
      ["claude"],
    );
    assert.ok(catalog[0].info.models.some(({ id }) => id === model));
    assert.ok((await client.action(ai.agents.list, {})).some(({ id }) => id === "fake-agent"));

    const codexModel = "gpt-5";
    const codexOnly = success(await client.mutation(profiles.create, { name: "Codex only", code: "GPT" }));
    const chatgpt = await subscribe("alpha-chatgpt", client, "openai");
    const elsewhere = await subscribe("elsewhere-chatgpt", client, "openai");
    for (const [profile, subscription] of [
      [alpha, chatgpt],
      [codexOnly, elsewhere],
    ])
      success(await client.mutation(profiles.add, { profile: profile.id, subscription: subscription.id }));
    const codexOnlyThread = await thread("openai-only", codexOnly);
    const offered = async (threadId) =>
      (await client.action(ai.agents.list, { threadId }))
        .map(({ id, info }) => [id, info.models.map(({ id }) => id)])
        .sort();
    assert.deepEqual(await offered(a.threadId), [
      ["claude", [model]],
      ["codex", [codexModel]],
    ]);
    assert.deepEqual(await offered(b.threadId), [["claude", [model]]]);
    assert.deepEqual(await offered(codexOnlyThread.threadId), [["codex", [codexModel]]]);

    const codexThread = await thread("codex-profile-alpha", alpha);
    const codexTurns = agentTurns({ h, client, agent: { id: "codex", name: "Codex" }, model: codexModel });
    if (installedCodex) {
      fake.script("alpha-chatgpt", [
        {
          kind: "codex-command",
          // Emit the result only; never write or report the key itself.
          command:
            "if /usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/grep -qx CODEX_TOKAMAK_TURN_KEY; " +
            "then printf present; else printf absent; fi > turn-key-visibility.txt",
        },
      ]);
    }
    const firstCodex = await codexTurns.run(codexThread.folder, "hello from the profile", {
      threadId: codexThread.threadId,
    });
    assert.equal(firstCodex.text, "Fake reply.");
    if (installedCodex)
      assert.equal(await readFile(join(codexThread.folder, "turn-key-visibility.txt"), "utf8"), "absent");

    await turns.run(a.folder, "check", { threadId: a.threadId });
    await ended(await receive(a.folder));

    let announceA, announceB;
    const readyA = new Promise((resolve) => (announceA = resolve));
    const readyB = new Promise((resolve) => (announceB = resolve));
    async function hold(thread, announce) {
      return turns.run(thread.folder, "wait", {
        threadId: thread.threadId,
        async during(control) {
          await control.firstText();
          announce(await receive(thread.folder));
        },
      });
    }
    const both = [hold(a, announceA), hold(b, announceB)];
    const [settingsA, settingsB] = await Promise.race([Promise.all([readyA, readyB]), Promise.race(both)]);
    assert.notEqual(settingsA.env.ANTHROPIC_AUTH_TOKEN, settingsB.env.ANTHROPIC_AUTH_TOKEN);
    await upstream(settingsA, "alice");
    await upstream(settingsB, "bob");

    const concurrentCodex = await codexTurns.run(codexThread.folder, "still using the profile", {
      threadId: codexThread.threadId,
    });
    assert.equal(concurrentCodex.text, "Fake reply.");
    assert.equal(concurrentCodex.row.sessionId, firstCodex.row.sessionId);
    const codexRequests = fake.requests.filter(({ path }) => path === "/openai/backend-api/codex/responses");
    assert.deepEqual(
      codexRequests.map(({ account }) => account),
      Array(installedCodex ? 3 : 2).fill("alpha-chatgpt"),
    );
    for (const { body, headers } of codexRequests) {
      assert.equal(body.model, codexModel);
      assert.equal(headers.authorization, "Bearer fake-alpha-chatgpt-access");
      assert.equal(headers["chatgpt-account-id"], "alpha-chatgpt");
    }
    await upstream(settingsA, "alice");
    await pick(beta.id, codexThread.threadId);
    const unavailable = await codexTurns.run(codexThread.folder, "not on this profile", {
      threadId: codexThread.threadId,
      state: "failed",
    });
    assert.equal(unavailable.error, "Pick an available agent or another profile.");

    await client.mutation(chat.threads.remove, { threadId: codexThread.threadId });
    await client.mutation(chat.threads.remove, { threadId: codexOnlyThread.threadId });
    await client.mutation(profiles.discard, { profile: codexOnly.id });

    success(await client.mutation(profiles.add, { profile: alpha.id, subscription: bob.id, at: 0 }));
    success(await client.mutation(api.subscriptions.setEnabled, { id: alice.id, enabled: false }));
    await upstream(settingsA, "alice");
    await upstream(settingsB, "bob");
    await Promise.all([h.gate(a.folder, "go"), h.gate(b.folder, "go")]);
    await Promise.all(both);
    await Promise.all([ended(settingsA), ended(settingsB)]);

    await h.closeGate(a.folder, "go");
    let stoppedKey;
    await turns.run(a.folder, "stop", {
      threadId: a.threadId,
      state: "stopped",
      async during(control) {
        await control.firstText();
        stoppedKey = await receive(a.folder);
        await upstream(stoppedKey, "bob");
        await control.stop();
      },
    });
    await ended(stoppedKey);
    await pick(alpha.id, b.threadId);
    assert.equal((await picked(b.threadId)).code, "ALPH");
    await turns.run(b.folder, "fail", { threadId: b.threadId, state: "failed" });
    await ended(await receive(b.folder));

    await client.mutation(chat.threads.remove, { threadId: a.threadId });
    assert.equal(await picked(a.threadId), null);
    const uses = await client.query(api.manage.usedBy, { id: alice.id });
    assert.equal(uses.find(({ id }) => id === alpha.id).threads, 1);
    await h.closeGate(b.folder, "go");
    let deletedKey;
    await turns.run(b.folder, "wait", {
      threadId: b.threadId,
      async during(control) {
        await control.firstText();
        deletedKey = await receive(b.folder);
        await upstream(deletedKey, "bob");
        success(await client.mutation(profiles.discard, { profile: alpha.id }));
        assert.equal(await picked(b.threadId), null);
        assert.equal(await client.query(picks.selection, {}), null);
        await upstream(deletedKey, "bob");
        await h.gate(b.folder, "go");
      },
    });
    await ended(deletedKey);
    const afterDeletion = await turns.run(b.folder, "new turn", { threadId: b.threadId, state: "failed" });
    assert.equal(afterDeletion.error, "Pick a profile to send.");

    // A forged turn call and both cross-member pick paths must leave the proxy untouched.
    const shared = await h.serve("profile-members", {
      shared: true,
      windowRouted: true,
      env: { TOKAMAK_AGENT_PROXY_ADDRESSES: JSON.stringify(fake.addresses) },
    });
    const owner = await h.connect(shared, { token: h.ownerToken });
    const member = await h.connect(shared, {
      token: (await h.signInMember(shared, "Noor")).key,
      local: true,
    });
    const ownProfile = success(await owner.mutation(profiles.create, { name: "Owner", code: "OWN" }));
    const ownersSubscription = await subscribe("owner-only", owner);
    success(
      await owner.mutation(profiles.add, { profile: ownProfile.id, subscription: ownersSubscription.id }),
    );
    success(await owner.mutation(picks.pick, { profile: ownProfile.id }));
    const otherProfile = success(await member.mutation(profiles.create, { name: "Member", code: "MEM" }));
    const folder = await h.folder("profile-owner");
    const sent = await owner.mutation(chat.threads.start, {
      text: "Mine",
      folder: { kind: "chosen", path: folder },
    });
    assert.equal((await owner.query(picks.selection, { thread: sent.threadId })).id, ownProfile.id);
    assert.equal(await member.query(picks.selection, { thread: sent.threadId }), null);
    for (const args of [{ profile: ownProfile.id }, { profile: otherProfile.id, thread: sent.threadId }]) {
      assert.equal((await member.mutation(picks.pick, args)).kind, "NotFound");
    }
    await assert.rejects(
      member.action(ai.run.turn, {
        threadId: sent.threadId,
        messageId: sent.messageId,
        folder,
        agentId: "claude",
        model,
      }),
      /That message is not in this thread|Only the person who sent a message/,
    );
    assert.equal(await owner.query(probe.keyCount, {}), 0);

    // Restart without the installed plugin. The scoped picker is ordinary again,
    // and a send needs neither a profile nor proxy settings.
    assert.equal(await client.query(probe.setCount, {}), 1);
    await h.quit(client);
    await h.runner(address).stop();
    await rename(join(h.plugins, "ai-profiles"), join(h.scratch, "uninstalled-ai-profiles"));
    const without = await h.serve("profile-turns");
    const ordinary = await h.connect(without);
    const ordinaryTurns = agentTurns({
      h,
      client: ordinary,
      agent: { id: "claude", name: "Recording Claude" },
      model,
    });
    assert.equal(await ordinary.query(probe.setCount, {}), 1);
    const ordinaryTurn = await ordinaryTurns.run(b.folder, "normal", { threadId: b.threadId });
    assert.equal(await receive(ordinaryTurn.folder), null);
    const ordinaryCatalog = await ordinary.action(ai.agents.list, { threadId: ordinaryTurn.threadId });
    assert.deepEqual(ordinaryCatalog, await ordinary.action(ai.agents.list, {}));
    assert.ok(ordinaryCatalog.some(({ id }) => id === "fake-agent"));

    process.stdout.write(
      `PASS ${installedCodex ? "installed offline" : "fixture"} Codex: two profile turns through the Responses proxy, resume, concurrent Claude, and turn key absent from command environment\n`,
    );
    process.stdout.write(
      "PASS profile turns: personal login, required pick, catalog, concurrent account isolation, snapshot, stop/failure cleanup, deletion, member ownership and uninstall\n",
    );
  } finally {
    blocked?.stop();
    await fake.stop();
  }
}
