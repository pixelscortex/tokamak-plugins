// A small Codex app-server stand-in that makes the actual Responses HTTP request.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.170.0\n");
  process.exit(0);
}
assert.equal(args[0], "app-server");
const config = args.filter((_, index) => args[index - 1] === "-c");
const provider = config.find((value) => value.startsWith("model_providers.tokamak_profile="));
let model;
let turn = 0;
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
let threadId;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => write({ id, result });
  const event = (method, params) => write({ method, params: { threadId, ...params } });
  if (method === "initialize") reply({});
  else if (method === "initialized") continue;
  else if (method === "account/read") reply({ account: null, requiresOpenaiAuth: true });
  else if (method === "thread/inject_items") reply({});
  else if (method === "thread/start" || method === "thread/resume") {
    assert.ok(config.includes('model_provider="tokamak_profile"'));
    assert.match(provider, /wire_api="responses", requires_openai_auth=false, supports_websockets=false/);
    assert.ok(config.includes('cli_auth_credentials_store="file"'));
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.match(process.env.CODEX_HOME, /[/]ai[/]launch-homes[/]/);
    threadId = method === "thread/resume" ? params.threadId : crypto.randomUUID();
    model = params.model;
    reply({ thread: { id: threadId }, model, reasoningEffort: null });
  } else if (method === "turn/start") {
    const turnId = String(++turn);
    reply({ turn: { id: turnId, status: "inProgress" } });
    const [, address] = /base_url="([^"]+)"/.exec(provider);
    assert.match(address, /^http:\/\/127\.0\.0\.1:\d+\/plugins\/agent-proxy\/[^/]+\/openai$/);
    const [, key] = /env_key="([^"]+)"/.exec(provider);
    const exclude = config.find((value) => value.startsWith("shell_environment_policy.exclude="));
    assert.equal(exclude, `shell_environment_policy.exclude=${JSON.stringify([key])}`);
    // The stand-in models this config when spawning a command. The installed
    // offline proof exercises the real CLI's command runner.
    const env = { ...process.env };
    for (const name of JSON.parse(exclude.split("=", 2)[1])) delete env[name];
    const commandEnv = execFileSync("/usr/bin/env", { env, encoding: "utf8" });
    assert.equal(
      commandEnv.split("\n").some((entry) => entry.startsWith(key + "=")),
      false,
    );
    const response = await fetch(address + "/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env[key]}`, "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, input: params.input[0].text }),
    });
    assert.equal(response.status, 200);
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const eventData = JSON.parse(data.slice(6));
        if (eventData.type === "response.output_text.delta")
          event("item/agentMessage/delta", { turnId, itemId: "message", delta: eventData.delta });
        else if (eventData.type === "response.completed") completed = true;
      }
    }
    assert.ok(completed);
    event("turn/completed", { turn: { id: turnId, status: "completed" } });
  } else throw new Error(`Unexpected Codex app-server call: ${method}`);
}
