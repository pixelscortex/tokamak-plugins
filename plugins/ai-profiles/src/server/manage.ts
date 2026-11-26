import { action, fail, isFailure, mutation, query, v } from "@tokamak/sdk";
import { api as proxy } from "plugin:agent-proxy/server";
import { profilesUsing, subscriptionRemoved, type ProfileUse } from "./profile-uses";

/**
 * The subscription details screen and the card's actions: add another
 * provider account, sign one out, check again, remove. Like
 * `subscriptions.ts`, these pass the window's calls on to `agent-proxy`,
 * which answers for the calling member only and never with a login. Which
 * profiles use a subscription is this plugin's own: `profile-uses.ts`.
 */

type Kind = "subscriptions" | "accounts";
type Failed = { failed: true; kind: string; data: { message: string } };
const isIdOf = (table: Kind, value: string) =>
  new RegExp(`^(?:agent-proxy/)?${table}:[A-Za-z0-9_-]+$`).test(value);
const gone = (what: "subscription" | "account") => fail("NotFound", { message: `That ${what} is gone.` });

/** Starts a sign-in whose account joins subscription `id`; finish it with `subscriptions:finishSignIn`. */
export const addAccount = action({
  args: { id: v.string() },
  handler: async (ctx, args) =>
    isIdOf("subscriptions", args.id) ? ctx.use(proxy).addAccount(args) : gone("subscription"),
});

/** Starts a sign-in for one signed-out account (`id` of an account); any other account is refused. */
export const signInAccount = action({
  args: { id: v.string() },
  handler: async (ctx, args) =>
    isIdOf("accounts", args.id) ? ctx.use(proxy).signInAccount(args) : gone("account"),
});

/** Signs one provider account out; its login is deleted on the server. */
export const signOut = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) =>
    isIdOf("accounts", args.id) ? ctx.use(proxy).signOutAccount(args) : gone("account"),
});

/** Reads the plan, the accounts' details and the models again. */
export const checkAgain = action({
  args: { id: v.string() },
  handler: async (ctx, args) =>
    isIdOf("subscriptions", args.id) ? ctx.use(proxy).checkAgain(args) : gone("subscription"),
});

/** The profiles that hold subscription `id`: the details' "Used by" and the remove dialog. */
export const usedBy = query({
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<ProfileUse[]> =>
    isIdOf("subscriptions", id) ? profilesUsing(ctx, id) : [],
});

/**
 * Removes the subscription, its accounts and logins (agent-proxy), then takes
 * it out of the profiles that held it, in the same transaction. The seam must
 * throw on failure: a throw rolls back the removal in agent-proxy too, while a
 * returned failure might not. One returned anyway is passed on, not dropped.
 */
export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    if (!isIdOf("subscriptions", id)) return gone("subscription");
    const removed = await ctx.use(proxy).removeSubscription({ id });
    if (isFailure(removed)) return removed;
    // Typed as the failure it should never be, so one returned anyway is passed on with its message.
    const done = (await subscriptionRemoved(ctx, id)) as Failed | void;
    if (done && isFailure(done)) return done;
    return null;
  },
});
