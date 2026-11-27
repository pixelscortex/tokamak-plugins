// Stand-in executable on the harness PATH. The production provider still
// launches "claude" exactly as it does when the real executable is installed.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_PERSONAL_ENV, LAUNCH_VALUE } from "../../../tests/fake-agent/launch-settings.mjs";

const args = process.argv.slice(2);
const status = await readFile(
  join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, ".claude"), ".credentials.json"),
  "utf8",
).catch(() => "");
// Simulate a Keychain-only logout without touching the watched credential file.
const keychainSignedOut = await Bun.file(join(process.env.HOME, "claude-replay-signed-out")).exists();
const failedStart = join(process.env.HOME, "claude-replay-start-failed");
function checkLaunchEnvironment() {
  assert.equal(process.env.TOKAMAK_LAUNCH_TEST, LAUNCH_VALUE);
  assert.match(basename(process.env.CLAUDE_CONFIG_DIR), /^[a-f0-9]{64}$/);
  assert.equal(status, "", "the isolated CLI did not see the personal credentials file");
  for (const name of CLAUDE_PERSONAL_ENV) {
    if (name === "ANTHROPIC_API_KEY") assert.match(process.env[name] ?? "", /^(?:fake-turn-key-[12])?$/);
    else assert.equal(process.env[name], undefined, name);
  }
}

if (args[0] === "--version") {
  assert.deepEqual(args, ["--version"]);
  if (process.env.TOKAMAK_LAUNCH_TEST) checkLaunchEnvironment();
  console.log(
    status === "old" || process.env.TOKAMAK_REPLAY_OLD
      ? "Claude Code v2.1.329 (test build)"
      : "2.1.330 (Claude Code)",
  );
} else if (args[0] === "auth") {
  assert.equal(args[1], "status");
  const probe = await readFile(failedStart, "utf8").catch(() => "");
  if (probe === "timeout") await Bun.sleep(15_000);
  if (probe === "invalid") {
    console.log("Could not read account status");
    process.exit(1);
  }
  const loggedIn = status !== "signed-out" && !keychainSignedOut;
  const expirations = {
    "expired-iso": "2000-01-01T00:00:00Z",
    "expired-ms": 946684800000,
    "expired-seconds": 946684800,
  };
  const loginExpiresAt = expirations[status] ?? null;
  console.log(
    JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? "claude.ai" : "none",
      apiProvider: "firstParty",
      loginExpiresAt,
    }),
  );
  process.exitCode = loggedIn ? 0 : 1;
} else {
  if (keychainSignedOut) process.exit(1);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  assert.ok(args.includes("-p"));
  assert.equal(flag("--input-format"), "stream-json");
  assert.equal(flag("--output-format"), "stream-json");
  // Model discovery does not select a thread folder. The Runner can start
  // from any directory, including one whose name starts with "claude-".
  let replay = args.includes("--strict-mcp-config") ? "claude-info" : basename(process.cwd());
  if (replay === "claude-hello-launch") {
    checkLaunchEnvironment();
    assert.match(process.env.ANTHROPIC_API_KEY, /^fake-turn-key-[12]$/);
    assert.equal(args.includes("--bare"), false);
    assert.equal(args.includes("--strict-mcp-config"), false);
    assert.equal(flag("--setting-sources"), "project,local");
    assert.equal(args[0], "--disable-slash-commands");
    assert.match(await readFile("CLAUDE.md", "utf8"), /Project instructions/);
    assert.deepEqual(JSON.parse(await readFile(".claude/settings.json", "utf8")), { hooks: {} });
    assert.deepEqual(JSON.parse(await readFile(".mcp.json", "utf8")), { mcpServers: {} });
    if (flag("--resume"))
      assert.equal(await Bun.file(join(process.env.CLAUDE_CONFIG_DIR, "cli-state")).exists(), true);
    await writeFile(join(process.env.CLAUDE_CONFIG_DIR, "cli-state"), "");
    await writeFile("isolated-home", process.env.CLAUDE_CONFIG_DIR);
  }
  if (replay.startsWith("claude-rate-limit-")) {
    for await (const line of console) {
      assert.equal(JSON.parse(line).request.subtype, "initialize");
      break;
    }
    await writeFile(failedStart, replay.slice("claude-rate-limit-".length));
    console.log(
      JSON.stringify({ type: "result", subtype: "error", is_error: true, errors: ["Rate limit reached"] }),
    );
    process.exit(1);
  }
  if (replay === "claude-info" && (await Bun.file(failedStart).exists()))
    await writeFile(join(process.env.HOME, "claude-replay-unexpected-models"), "");
  if (replay.startsWith("claude-resistant-")) replay = "claude-resistant";
  if (replay.startsWith("claude-hello-")) replay = "claude-hello";
  if (replay === "claude-remember-snapshots") replay = "claude-remember";
  if (replay === "claude-hello" && flag("--resume")) {
    assert.equal(flag("--resume"), "ed0f9193-a023-4ab1-a74c-a8bba2877dc3");
    replay = "claude-resume";
  }
  if (replay === "claude-remember" && flag("--resume")) {
    assert.equal(flag("--resume"), "be26420d-2d98-4819-8c04-82b6f107764d");
    replay = "claude-remember-resume";
  }
  if (replay === "claude-hello") await writeFile("claude.pid", String(process.pid));
  if (replay === "claude-lost" && !flag("--resume")) replay = "claude-history";
  if (replay === "claude-info") assert.equal(JSON.parse(flag("--settings")).fastMode, true);
  if (replay !== "claude-info") {
    assert.ok(args.includes("--include-partial-messages"));
    assert.ok(args.includes("--replay-user-messages"));
    assert.equal(flag("--thinking-display"), "summarized");
    assert.equal(flag("--permission-prompt-tool"), "stdio");
    const ask = [
      "claude-permit",
      "claude-refuse",
      "claude-cancel",
      "claude-cancel-continues",
      "claude-remember",
      "claude-remember-resume",
      "claude-plan",
      "claude-scope",
      "claude-stop-asking",
      "claude-withdraw-question",
    ].includes(replay);
    assert.equal(flag("--permission-mode"), ask ? "manual" : "bypassPermissions");
  }
  const runner = fileURLToPath(new URL("../../../tests/fake-agent/program.mjs", import.meta.url));
  const child = Bun.spawn([process.execPath, runner, "--replay", replay], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}
