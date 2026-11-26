import type { CallerActionContext } from "@tokamak/sdk";
import { agentCommand } from "@tokamak/sdk/agent-turn";
import type { Info } from "plugin:ai/contracts";
import { AppServer, isRecord } from "./rpc";

const MINIMUM_VERSION = "0.170.0";
const INSTALL = "npm install -g @openai/codex";
const SIGN_IN = "codex login";
const UNAVAILABLE: Info = {
  installed: false,
  signedIn: false,
  install: INSTALL,
  signIn: SIGN_IN,
  models: [],
  modes: [],
  speeds: [],
};

export async function codexInfo(
  ctx: CallerActionContext,
  setupDeadline?: number,
  env?: Readonly<Record<string, string>>,
): Promise<Info> {
  const remaining = (fallback: number) =>
    setupDeadline === undefined ? fallback : Math.max(0, setupDeadline - Date.now());
  const version = await support(ctx, remaining(5_000), env);
  if (version === undefined || (setupDeadline !== undefined && version === "old"))
    throw new Error("Could not check the Codex version");
  if (version !== "ready")
    return env && version === "old"
      ? { ...UNAVAILABLE, updateRequired: `Codex needs Codex CLI ${MINIMUM_VERSION} or later.` }
      : UNAVAILABLE;
  // Launch settings may use a custom provider. The real turn checks its auth.
  if (env) return { ...UNAVAILABLE, installed: true, signedIn: true };
  if (remaining(Infinity) === 0) throw new Error("Could not check Codex sign-in");
  const app = new AppServer(ctx);
  const available = { ...UNAVAILABLE, installed: true };
  try {
    await app.initialize(remaining(30_000));
    const { account, requiresOpenaiAuth } = await app.call<{
      account: unknown;
      requiresOpenaiAuth: unknown;
    }>("account/read", { refreshToken: false }, remaining(30_000));
    if (account === null && requiresOpenaiAuth === true) return available;
    if (!isRecord(account) && !(account === null && requiresOpenaiAuth === false))
      throw new Error("Could not check Codex sign-in");
    if (setupDeadline !== undefined) return { ...available, signedIn: true };
    const [{ models, speeds }, modes] = await Promise.all([listModels(app), listModes(app)]);
    return { ...available, signedIn: true, models, modes, speeds };
  } finally {
    app.stop();
  }
}

type Model = {
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  serviceTiers?: { id: string }[];
};

async function listModels(app: AppServer) {
  const models: Model[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: { data: Model[]; nextCursor: string | null } = await app.call("model/list", {
      includeHidden: false,
      cursor,
    });
    models.push(...page.data.filter((model) => !model.hidden));
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Codex returned a repeated model cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  const tiers = new Set(models.flatMap((model) => model.serviceTiers?.map(({ id }) => id) ?? []));
  // With no catalog tiers there is no speed choice to show.
  tiers.delete("default");
  const speeds = tiers.size > 0 ? ["default", ...tiers] : [];
  return {
    speeds,
    models: models
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map((model) => ({
        id: model.model,
        name: model.displayName,
        efforts: model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort),
      })),
  };
}

async function listModes(app: AppServer) {
  const { data } = await app.call<{ data: { mode: string | null }[] }>("collaborationMode/list", {});
  // No selection already means Default. Keep it first when explicitly selected.
  return ["default", "plan"].filter((mode) => data.some((preset) => preset.mode === mode));
}

async function support(ctx: CallerActionContext, timeout: number, env?: Readonly<Record<string, string>>) {
  const answer = await agentCommand(ctx, ["codex", "--version"], timeout, env);
  if (answer === "missing") return answer;
  if (answer?.code !== 0) return;
  const version = answer.stdout.match(/^codex-cli (\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/m);
  if (!version) return;
  const minimum = MINIMUM_VERSION.split(".").map(Number);
  const installed = version.slice(1).map(Number);
  const firstDifference = installed.findIndex((part, i) => part !== minimum[i]);
  return firstDifference === -1 || installed[firstDifference]! > minimum[firstDifference]! ? "ready" : "old";
}
