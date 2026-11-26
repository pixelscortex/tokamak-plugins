import {
  createFunctions,
  createHook,
  fail,
  type ArgsOf,
  type Id,
  type ModelFromSchema,
  type MutationContext,
  type QueryContext,
  v,
} from "@tokamak/sdk";
import type { SubscriptionView } from "plugin:agent-proxy/server";
import { api as chat } from "plugin:chat/server";
import { tables } from "plugin:chat/tables";
import { enabledOf, own, subscriptionsOf } from "./profiles";
import schema from "./schema";

const { mutation, query } = createFunctions(schema);
const hook = createHook(schema);
type Model = ModelFromSchema<typeof schema>;
type Reader = QueryContext<Model> | MutationContext<Model>;
type Thread = Id<"chat.threads">;
const threadRef = v.ref(tables.threads);

const lastOf = (ctx: Reader) =>
  ctx.db
    .query("lastProfiles")
    .withIndex("by_owner", (q) => q.eq("owner", ctx.auth.user.id))
    .first();

const assignedTo = (ctx: Reader, thread: Thread) =>
  ctx.db
    .query("threadProfiles")
    .withIndex("by_thread", (q) => q.eq("thread", thread))
    .first();

/** Only the person who owns the profile can see the thread's pick. */
export const selection = query({
  args: { thread: v.optional(threadRef) },
  handler: async (ctx, { thread }) => {
    const picked = thread === undefined ? await lastOf(ctx) : await assignedTo(ctx, thread);
    if (picked?.owner !== ctx.auth.user.id) return null;
    const row = await own(ctx, picked.profile);
    if (!row) return null;
    const subscriptions = enabledOf(row, await subscriptionsOf(ctx));
    const offering = (company: SubscriptionView["company"]) => {
      const matching = subscriptions.filter((subscription) => subscription.company === company);
      if (matching.length === 0) return null;
      const models = new Map<string, SubscriptionView["models"][number]>();
      for (const subscription of matching) {
        for (const model of subscription.models) {
          if (!models.has(model.id)) models.set(model.id, model);
        }
      }
      return [...models.values()];
    };
    return {
      id: row._id as string,
      code: row.code,
      agents: { claude: offering("anthropic"), codex: offering("openai") },
    };
  },
});

export const pick = mutation({
  args: { thread: v.optional(threadRef), profile: v.string() },
  handler: async (ctx, { thread, profile }) => {
    const row = await own(ctx, profile);
    if (!row) return fail("NotFound", { message: "That profile is gone." });
    if (thread !== undefined) {
      const creator = await ctx
        .use(chat)
        .threadCreator({ threadId: thread as string as ArgsOf<typeof chat.threadCreator>["threadId"] });
      if (creator?.id !== ctx.auth.user.id) return fail("NotFound", { message: "That thread is gone." });
      const old = await assignedTo(ctx, thread);
      if (old) await ctx.db.patch(old._id, { profile: row._id });
      else await ctx.db.insert("threadProfiles", { thread, profile: row._id, owner: row.owner });
    }
    const last = await lastOf(ctx);
    if (last) await ctx.db.patch(last._id, { profile: row._id });
    else await ctx.db.insert("lastProfiles", { owner: row.owner, profile: row._id });
    return null;
  },
});

// Before chat announces the first Send, its thread already has the draft's pick.
export const inheritProfile = hook(chat.startThread, {
  async after(ctx, started) {
    const last = await lastOf(ctx);
    if (last && (await own(ctx, last.profile))) {
      await ctx.db.insert("threadProfiles", {
        thread: started.threadId as string as Thread,
        profile: last.profile,
        owner: last.owner,
      });
    }
    return started;
  },
});
