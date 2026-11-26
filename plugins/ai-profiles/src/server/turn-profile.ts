import { createHook, isFailure, type Id } from "@tokamak/sdk";
import { api as proxy } from "plugin:agent-proxy/server";
import { api as ai } from "plugin:ai/server";
import { api } from "./_generated/api";
import { internal } from "./_generated/internal";
import { syncSubscription } from "./profiles";
import schema from "./schema";

const hook = createHook(schema);
const companyOf = { claude: "anthropic", codex: "openai" } as const;
const profileAgent = (id: string | undefined): id is keyof typeof companyOf =>
  id === "claude" || id === "codex";

const CODEX_TURN_KEY = "CODEX_TOKAMAK_TURN_KEY";

const PICK_PROFILE = "Pick a profile to send.";
const NOT_AVAILABLE = "Pick an available agent or another profile.";
export const syncEnabled = hook(proxy.setEnabled, {
  async after(ctx, result, { id }) {
    if (!isFailure(result)) await syncSubscription(ctx, id);
    return result;
  },
});

export const narrowAgents = hook(ai.listAgents, {
  async after(ctx, agents, { draft }) {
    const thread = ctx.call.threadId as Id<"chat.threads"> | undefined;
    if (isFailure(agents) || (!thread && !draft)) return agents;
    const selected = await ctx.runQuery(api["thread-profiles"].selection, thread ? { thread } : {});
    if (!selected) return agents;
    return agents.flatMap((agent) => {
      const models = profileAgent(agent.id) ? selected.agents[agent.id] : null;
      if (!models) return [];
      return [
        {
          ...agent,
          info: {
            ...agent.info,
            signedIn: agent.info.installed,
            models: models.map((model) => ({
              ...model,
              efforts: agent.info.models.find((option) => option.id === model.id)?.efforts ?? [],
            })),
          },
        },
      ];
    });
  },
});

export const launchProfile = hook(ai.turn.points.launch, {
  async before(ctx, launch) {
    const thread = ctx.call.threadId as Id<"chat.threads"> | undefined;
    const selected =
      thread && launch.request ? await ctx.runQuery(api["thread-profiles"].selection, { thread }) : null;
    if (!selected) {
      const profiles = await ctx.runQuery(api.profiles.list, {});
      if (profiles.length === 0) return launch;
      if (!thread || !launch.request)
        return { ...launch, blocked: "Could not find the thread for this turn." };
      return { ...launch, blocked: PICK_PROFILE };
    }
    const request = launch.request;
    if (!request || !profileAgent(request.agentId)) return { ...launch, blocked: NOT_AVAILABLE };
    const { agentId, model, launchId } = request;
    const models = selected.agents[agentId];
    if (!models) return { ...launch, blocked: NOT_AVAILABLE };
    if (model !== undefined && !models.some((offered) => offered.id === model))
      return { ...launch, blocked: "Pick a model offered by this profile." };
    try {
      const set = await ctx.runMutation(internal.profiles.ensureSet, { profile: selected.id });
      if (set === null) return { ...launch, blocked: PICK_PROFILE };
      const reply = await ctx.runAction(
        proxy.turnKey,
        {
          set,
          lease: launchId,
          company: companyOf[agentId],
        },
        { on: "server" },
      );
      if (isFailure(reply)) {
        const blocked =
          reply.kind === "MissingServerOrigin"
            ? "The server has no address for profile turns."
            : "Could not start the turn through this profile.";
        return { ...launch, blocked };
      }
      if (agentId === "codex") {
        return {
          ...launch,
          identity: selected.id,
          provider: { baseUrl: reply.address, keyEnv: CODEX_TURN_KEY, key: reply.key },
        };
      }
      return {
        ...launch,
        identity: selected.id,
        env: { ...launch.env, ANTHROPIC_BASE_URL: reply.address, ANTHROPIC_AUTH_TOKEN: reply.key },
      };
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause &&
        "kind" in cause &&
        cause.kind === "runnerCapabilityUnavailable"
      )
        return { ...launch, blocked: "Connect a machine to use this profile." };
      throw cause;
    }
  },
});

export const endProfile = hook(ai.turn.points.ended, {
  async before(ctx, ended) {
    const args = { lease: ended.launchId };
    const revoke = async () => {
      const result = await ctx.runMutation(proxy.endTurnKey, args);
      if (isFailure(result)) throw new Error("Could not revoke the turn key.");
    };
    await revoke()
      .catch(revoke)
      .catch(() => {
        // oxlint-disable-next-line no-console -- Record a cleanup failure in the worker log without credentials.
        console.warn("AI Profiles could not revoke a turn key after two attempts; the key will expire.");
      });
    return ended;
  },
});
