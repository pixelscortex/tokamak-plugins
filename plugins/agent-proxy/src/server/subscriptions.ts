import { fail, pluginOnly, v } from "@tokamak/sdk";
import { internal } from "./_generated/internal";
import {
  action,
  idIn,
  mutation,
  notFound,
  ownerOf,
  query,
  signInViewOf,
  viewOf,
  type SignInView,
  type SubscriptionView,
} from "./_functions";

/**
 * What other plugins may read and change of a person's subscriptions. All
 * plugin-only, all for the caller: another member of the same server never
 * sees them. Every id is checked to be of the right table before it is read.
 */

/**
 * The caller's subscriptions, oldest first, and their sign-ins that have not
 * ended. A sign-in older than 15 minutes is marked `expired`: it can no longer
 * finish, and the next change to sign-ins deletes it (a query cannot).
 */
export const listSubscriptions = pluginOnly(
  query({
    handler: async (ctx): Promise<{ subscriptions: SubscriptionView[]; signIns: SignInView[] }> => {
      const owner = ownerOf(ctx.auth);
      const now = Date.now();
      const subscriptions = await ctx.db
        .query("subscriptions")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .collect();
      const accounts = await ctx.db
        .query("accounts")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .collect();
      const signIns = await ctx.db
        .query("signIns")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .collect();
      return {
        subscriptions: subscriptions
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((subscription) =>
            viewOf(
              subscription,
              accounts.filter((account) => account.subscription === subscription._id),
            ),
          ),
        signIns: signIns.sort((a, b) => a.startedAt - b.startedAt).map((row) => signInViewOf(row, now)),
      };
    },
  }),
);

const MAX_LABEL = 64;

/** The person's own name for a subscription, such as "Personal"; empty clears it. */
export const setLabel = pluginOnly(
  mutation({
    args: { id: v.string(), label: v.string() },
    handler: async (ctx, { id, label }) => {
      const ref = idIn("subscriptions", id);
      const subscription = ref && (await ctx.db.get(ref));
      if (!subscription || subscription.owner !== ownerOf(ctx.auth)) return notFound("subscription");
      const text = label.trim().replace(/\s+/g, " ");
      if (text.length > MAX_LABEL)
        return fail("TooLong", { message: `A label is at most ${MAX_LABEL} characters.` });
      await ctx.db.patch(subscription._id, { label: text });
      return null;
    },
  }),
);

/**
 * Switched off, a subscription keeps its login, and the proxy will
 * skip it until it is switched on again.
 */
export const setEnabled = pluginOnly(
  mutation({
    args: { id: v.string(), enabled: v.boolean() },
    handler: async (ctx, { id, enabled }) => {
      const ref = idIn("subscriptions", id);
      const subscription = ref && (await ctx.db.get(ref));
      if (!subscription || subscription.owner !== ownerOf(ctx.auth)) return notFound("subscription");
      await ctx.db.patch(subscription._id, { enabled });
      return null;
    },
  }),
);

/**
 * Renews every one of the caller's logins that runs out soon, without the
 * person. A plugin's server code has no timer that may use the network (the
 * `maintenance` entry is a mutation), so a screen that shows subscriptions
 * asks for this while it is open, and the proxy will renew each login before
 * it uses it. `waiting` counts logins that could not be renewed now and wait
 * for their next try; a login its company will not renew turns "Signed out".
 */
export const renewLogins = pluginOnly(
  action({
    handler: async (ctx): Promise<{ renewed: number; signedOut: number; waiting: number }> => {
      const owner = ownerOf(ctx.auth);
      const due = await ctx.runQuery(internal.logins.due, { owner });
      let renewed = 0;
      let signedOut = 0;
      let waiting = 0;
      for (const { account } of due) {
        const login = await ctx.runAction(internal.logins.fresh, { owner, account });
        if (login?.renewed) renewed++;
        else if (!(await ctx.runQuery(internal.logins.read, { owner, account }))) signedOut++;
        else waiting++;
      }
      return { renewed, signedOut, waiting };
    },
  }),
);
