import { action, fail, mutation, query, v } from "@tokamak/sdk";
import { api as proxy } from "plugin:agent-proxy/server";

/**
 * The Profiles screen's subscriptions. `agent-proxy` owns them and their
 * logins; these pass the window's calls on to its plugin-only functions,
 * which answer for the calling member only and never with a login. This
 * plugin stores nothing about subscriptions itself.
 *
 * Ids arrive as strings from the window. Each is checked to be an id of the
 * right agent-proxy table before it is passed on (agent-proxy checks again),
 * and a wrong one gets the same plain "gone" answer, never an error.
 */

type Kind = "subscriptions" | "signIns";
const isIdOf = (table: Kind, value: string) =>
  new RegExp(`^(?:agent-proxy/)?${table}:[A-Za-z0-9_-]+$`).test(value);
const gone = (what: "subscription" | "sign-in") => fail("NotFound", { message: `That ${what} is gone.` });

/** The person's subscriptions and their sign-ins that have not ended. */
export const list = query({
  handler: (ctx) => ctx.use(proxy).listSubscriptions({}),
});

/** Starts a sign-in and returns the company's page; `repair` signs a subscription in again. */
export const startSignIn = action({
  args: {
    company: v.union(v.literal("anthropic"), v.literal("openai")),
    method: v.literal("subscription"),
    repair: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    args.repair !== undefined && !isIdOf("subscriptions", args.repair)
      ? gone("subscription")
      : ctx.use(proxy).startSignIn(args),
});

/** Finishes a sign-in with the address, or the code, the company's page ended on. */
export const finishSignIn = action({
  args: { id: v.string(), pasted: v.string() },
  handler: async (ctx, args) =>
    isIdOf("signIns", args.id) ? ctx.use(proxy).finishSignIn(args) : gone("sign-in"),
});

/** Stops waiting for a sign-in; nothing is left behind. */
export const cancelSignIn = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) =>
    isIdOf("signIns", args.id) ? ctx.use(proxy).cancelSignIn(args) : gone("sign-in"),
});

export const setLabel = mutation({
  args: { id: v.string(), label: v.string() },
  handler: async (ctx, args) =>
    isIdOf("subscriptions", args.id) ? ctx.use(proxy).setLabel(args) : gone("subscription"),
});

export const setEnabled = mutation({
  args: { id: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) =>
    isIdOf("subscriptions", args.id) ? ctx.use(proxy).setEnabled(args) : gone("subscription"),
});

/** Renews logins that run out soon; the screen asks while it is open. */
export const renew = action({
  handler: (ctx) => ctx.use(proxy).renewLogins({}),
});
