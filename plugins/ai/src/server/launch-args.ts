const claudeOwned = new Set([
  // Stream protocol and turn choices (claude's wire.ts and turn.ts).
  "-p",
  "--print",
  "--input-format",
  "--output-format",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--permission-prompt-tool",
  "--permission-mode",
  "--thinking-display",
  "--settings",
  "--model",
  "--effort",
  "--setting-sources",
  "--allow-dangerously-skip-permissions",
  "--dangerously-skip-permissions",
  // Session selection and settings isolation.
  "-r",
  "--resume",
  "-c",
  "--continue",
  "--session-id",
  "--fork-session",
  "--from-pr",
  "--no-session-persistence",
  "--bare",
]);

const codexOwnedFlags = new Set([
  "-m",
  "--model",
  "-a",
  "--ask-for-approval",
  "-s",
  "--sandbox",
  "--full-auto",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
]);

const codexOwned = new Set([
  // App-server thread/turn choices plus the forced credential store.
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
  "sandbox_workspace_write",
  "model",
  "model_reasoning_effort",
  "service_tier",
  "cli_auth_credentials_store",
  "model_provider",
  "model_providers",
  "profile",
  "profiles",
  "openai_base_url",
  "chatgpt_base_url",
  "shell_environment_policy",
]);

const earlyExit = new Set(["--", "--help", "-h", "--version", "-V"]);

function claudeOption(flag: string) {
  if (claudeOwned.has(flag)) return flag;
  // The CLI may accept attached short options.
  return /^-[pcr](?=[^-])/.exec(flag)?.[0];
}

function codexConfigKey(config: string) {
  const equals = config.indexOf("=");
  const path = config.slice(0, equals).trim();
  if (equals < 0 || !path || path.startsWith("-")) return "-c without a key=value";
  if (path.includes("\\")) return "-c with an escaped key";
  const parts = path.split(".").map((part) => part.trim().replace(/^["']|["']$/g, ""));
  const normalized = parts.join(".");
  for (const owned of codexOwned) {
    if (normalized === owned || normalized.startsWith(owned + ".")) return `-c ${owned}`;
  }
}

function attachedCodexConfig(arg: string) {
  if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  if (arg.startsWith("-c")) return arg.slice(2).replace(/^=/, "");
}

/** Return a canonical label, so an error never echoes a supplied argument value. */
export function ownedAgentLaunchArg(agent: string, args: readonly string[]): string | undefined {
  if (agent !== "claude" && agent !== "codex") return;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.split("=", 1)[0]!;
    if (earlyExit.has(flag)) return flag;
    if (agent === "claude") {
      const owned = claudeOption(flag);
      if (owned) return owned;
      continue;
    }
    if (codexOwnedFlags.has(flag)) return flag;
    const separateValue = arg === "-c" || arg === "--config";
    const config = separateValue ? (args[++i] ?? "") : attachedCodexConfig(arg);
    if (config === undefined) continue;
    const owned = codexConfigKey(config);
    if (owned) return owned;
  }
}
