/// <reference types="node" />
/// <reference path="./svg.d.ts" />
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { agentInfoCache } from "@tokamak/sdk/agent-turn";
import { withAgentLaunch } from "@tokamak/sdk/agent-launch";
import { action, provide, type CallerActionContext } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { killAfter, minimumVersion, open, parse, signedIn, speeds, streamArgs, usableVersion } from "./wire";
import { turn } from "./turn";
// The agent's mark, vendored from LobeHub icons (MIT; see icons/LICENSE.md).
import icon from "./icons/claude.svg" with { type: "text" };

const updateRequired = `Claude needs Claude Code ${minimumVersion} or later.`;
const setup = { install: "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude auth login" };
const noCatalog = { models: [], modes: [], speeds: [] } as const;

async function claudeInfo(
  ctx: CallerActionContext,
  setupDeadline?: number,
  env?: Readonly<Record<string, string>>,
): Promise<ai.Info> {
  const remaining = () => (setupDeadline === undefined ? undefined : setupDeadline - Date.now());
  const version = await usableVersion(ctx, remaining(), env);
  if (version === undefined || (setupDeadline !== undefined && version === "old"))
    throw new Error("Could not check the Claude Code version");
  if (version !== "ready") {
    return {
      installed: false,
      signedIn: false,
      ...setup,
      ...(version === "old" && { install: "claude update", updateRequired }),
      ...noCatalog,
    };
  }
  // Launch auth is checked at start, without asking the CLI to inspect an account.
  if (env) return { installed: true, signedIn: true, ...setup, ...noCatalog };
  const ready = await signedIn(ctx, remaining());
  if (ready === undefined) throw new Error("Could not check Claude Code sign-in");
  return {
    installed: true,
    signedIn: ready,
    ...setup,
    ...noCatalog,
    ...(ready && setupDeadline === undefined && (await choices(ctx))),
  };
}

const discovery = agentInfoCache(claudeInfo, async () => {
  const path = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude"),
    ".credentials.json",
  );
  const stamp = await stat(path).catch(() => undefined);
  return stamp ? `${path}:${stamp.ino}:${stamp.mtimeMs}:${stamp.size}` : path;
});
const info = action({
  on: "caller",
  handler: (
    ctx,
    { setupDeadline, launchSettings }: { setupDeadline?: number; launchSettings?: ai.LaunchSettings },
  ) =>
    launchSettings
      ? withAgentLaunch(launchSettings, "claude", ({ env }) => claudeInfo(ctx, undefined, env))
      : setupDeadline === undefined
        ? discovery.read(ctx)
        : claudeInfo(ctx, setupDeadline),
});

/**
 * A model's name as people know it, never an alias's label. The default
 * follows the account's setting, so it says which model that is now and that
 * it is the default ("Default (recommended)", "Use the default model
 * (currently Opus 5.5)" → "Opus 5.5 (default)"); an alias names its model
 * ("Opus", "Opus 5.5 · Best for…" → "Opus 5.5"). Other names are kept
 * ("Claude Fable 5.2"; the window drops "Claude"). Every model stays offered:
 * the default and the alias it currently points at are different choices.
 */
export function modelName(model: { displayName: string; description?: unknown }): string {
  const description = typeof model.description === "string" ? model.description : "";
  const current = /\(currently ([^)]+)\)/.exec(description)?.[1]?.trim();
  if (current) return `${current} (default)`;
  const head = description.split(" · ")[0]?.trim();
  if (
    head &&
    head !== model.displayName &&
    head.toLowerCase().startsWith(`${model.displayName.toLowerCase()} `)
  )
    return head;
  return model.displayName.replace(/\s*\(recommended\)$/i, "");
}

async function choices(ctx: CallerActionContext): Promise<Pick<ai.Info, "models" | "speeds">> {
  // No user message is sent: initialize reveals model aliases and supported
  // effort levels without purchasing a turn. Avoid loading MCP servers just
  // to open the picker; keep Claude's account and gateway settings.
  const wire = open(ctx, [
    ...streamArgs(),
    "--strict-mcp-config",
    "--model",
    "opus",
    "--settings",
    JSON.stringify({ fastMode: true }),
  ]);
  const cancelKill = killAfter(wire.proc, 5_000);
  try {
    const id = wire.control("initialize");
    for await (const line of wire.proc.stdout) {
      const message = parse(line);
      if (message?.type !== "control_response" || !message.response || message.response.request_id !== id)
        continue;
      const response = message.response.response;
      const models = response?.models;
      if (Array.isArray(models) && models.length) {
        const offered = models
          .filter((model) => typeof model?.value === "string" && typeof model.displayName === "string")
          .map((model) => ({
            id: model.value,
            name: modelName(model),
            efforts: Array.isArray(model.supportedEffortLevels)
              ? model.supportedEffortLevels.filter((level) => typeof level === "string")
              : [],
          }));
        // Opus can use fast mode, but account or provider policy can disable it.
        const fast = response?.fast_mode_state;
        return {
          models: offered,
          speeds: fast === "on" || fast === "cooldown" ? [speeds.standard, speeds.fast] : [],
        };
      }
      break;
    }
  } finally {
    cancelKill();
    await wire.close();
  }
  // A model discovery failure should not stop a signed-in user from using
  // the Claude default. Selecting it lets the CLI consult the user's settings.
  return { models: [{ id: "default", name: "Default", efforts: [] }], speeds: [] };
}

const start = action({
  on: "caller",
  handler: async (ctx, run: ai.Run) => {
    const startTurn = async (env?: Readonly<Record<string, string>>) => {
      const version = await usableVersion(ctx, undefined, env);
      if (version === undefined) throw new Error("Could not check the Claude Code version");
      if (version !== "ready")
        throw new Error(version === "old" ? updateRequired : "Claude isn't installed.");
      if (env && !env.ANTHROPIC_API_KEY?.trim() && !env.ANTHROPIC_AUTH_TOKEN?.trim())
        throw new Error("Claude launch settings must provide ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.");
      return turn(ctx, run, env);
    };
    try {
      return run.launchSettings
        ? await withAgentLaunch(run.launchSettings, "claude", ({ env }) => startTurn(env))
        : await startTurn();
    } catch (error) {
      if (!run.launchSettings) discovery.invalidate();
      throw error;
    }
  },
});

export default provide(ai.agent, { id: "claude", name: "Claude", icon, info, start });
