import {
  fail,
  pluginOnly,
  v,
  type DatabaseReader,
  type Doc,
  type Id,
  type MutationContext,
} from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";
import { internal } from "./_generated/internal";
import {
  action,
  idIn,
  internalMutation,
  internalQuery,
  mutation,
  notFound,
  ownerOf,
  viewOf,
  type Model,
  type SignInView,
  type SubscriptionView,
} from "./_functions";
import { companyAddresses } from "./addresses";
import { companies } from "./companies";
import { randomToken } from "./pkce";
import { plansFit, storeRead } from "./reads";

/**
 * Managing a subscription once it exists: another provider account under it,
 * signing one account out, reading plan and models again, and removing it.
 * Like the rest of the plugin these answer for the calling member only, check
 * every id's table, and never put a login in an answer. The internal ones take
 * the member as `owner`, as `logins.ts` does.
 *
 * Several accounts: a team plan can have two logins of one company under one
 * subscription. The subscription is "OK" while at least one account is signed
 * in, since the proxy (TKM-263) can still use it; each account carries its own
 * status, and the subscription turns "Signed out" only when every account is.
 * A second account must be on the subscription's plan: one on another plan is
 * refused (add it as a subscription of its own). A plan that is not known, on
 * either side, fits; the first known read fills it in (reads.ts).
 */

type Failed = { failed: true; kind: string; data: { message: string } };
const SIGNED_OUT = "You signed this account out. Sign in again to use it.";

/**
 * Starts a sign-in that adds another provider account to subscription `id`.
 * The same sign-in as a new subscription (link, paste, `finishSignIn`); only
 * its end differs, in `attachAccount` below. Starting again for the same
 * subscription replaces the one still waiting.
 */
export const addAccount = pluginOnly(
  action({
    args: { id: v.string() },
    handler: async (ctx, { id }): Promise<SignInView | Failed> => {
      const target = idIn("subscriptions", id);
      if (!target) return notFound("subscription");
      const owner = ownerOf(ctx.auth);
      // The subscription's own company signs the account in: its link, and its check in `begin`.
      const company = await ctx.runQuery(internal.manage.companyOf, { owner, subscription: target });
      if (!company) return notFound("subscription");
      const verifier = randomToken();
      const state = randomToken();
      const link = companies[company].link(await companyAddresses(ctx), verifier, state);
      return ctx.runMutation(internal.signins.begin, {
        owner,
        company,
        verifier,
        state,
        link,
        addTo: target,
      });
    },
  }),
);

/**
 * Starts a sign-in that signs one account (`id`, of the accounts table) in
 * again in place: an account's own "Sign in" in the details. Finishing it as
 * any other account is refused with `OtherAccount` and it keeps waiting.
 */
export const signInAccount = pluginOnly(
  action({
    args: { id: v.string() },
    handler: async (ctx, { id }): Promise<SignInView | Failed> => {
      const target = idIn("accounts", id);
      if (!target) return notFound("account");
      const owner = ownerOf(ctx.auth);
      const company = await ctx.runQuery(internal.manage.companyOf, { owner, account: target });
      if (!company) return notFound("account");
      const verifier = randomToken();
      const state = randomToken();
      const link = companies[company].link(await companyAddresses(ctx), verifier, state);
      return ctx.runMutation(internal.signins.begin, {
        owner,
        company,
        verifier,
        state,
        link,
        repairAccount: target,
      });
    },
  }),
);

/**
 * The end of an `addAccount` sign-in, inside `signins:connect`'s transaction
 * (the sign-in row is already deleted there; a failure rolls that back too).
 * Refuses an account of another company, one already under another of the
 * member's subscriptions or signed in under this one, and one on another plan.
 * An account of this subscription that was signed out is signed in again in
 * place, so "Add account" with that account also repairs it.
 */
export async function attachAccount(
  ctx: MutationContext<Model>,
  args: {
    owner: string;
    signIn: Doc<Model, "signIns">;
    subscription: Id<"subscriptions">;
    access: string;
    refresh: string;
    expiresAt: number;
    found: {
      accountId: string;
      email?: string;
      organization?: string;
      workspace?: string;
      plan: string;
      planKnown: boolean;
      models: { id: string; name: string }[];
    };
  },
): Promise<SubscriptionView | Failed> {
  const { owner, found } = args;
  const same = await ctx.db
    .query("accounts")
    .withIndex("by_owner_account", (q) => q.eq("owner", owner).eq("accountId", found.accountId))
    .first();
  const refused = await refusal(ctx, args, same);
  if (refused) return refused;
  const identity = {
    ...(found.email !== undefined && { email: found.email }),
    ...(found.organization !== undefined && { organization: found.organization }),
    ...(found.workspace !== undefined && { workspace: found.workspace }),
  };
  let account: Id<"accounts">;
  if (same) {
    // Signed out under this subscription: signed in again in place, its old login gone.
    account = same._id;
    const { reason: _reason, _id, _creationTime, ...fields } = same;
    await ctx.db.replace(_id, { ...fields, ...identity, status: "ok" });
    for (const old of await loginsOf(ctx, _id)) await ctx.db.delete(old._id);
  } else {
    account = await ctx.db.insert("accounts", {
      owner,
      subscription: args.subscription,
      accountId: found.accountId,
      ...identity,
      status: "ok",
    });
  }
  await ctx.db.insert("logins", {
    owner,
    account,
    access: args.access,
    refresh: args.refresh,
    expiresAt: args.expiresAt,
  });
  // Its models join the subscription's; an unknown subscription plan takes this one's.
  await storeRead(ctx, account, found);
  return viewOf((await ctx.db.get(args.subscription))!, await accountsOf(ctx, args.subscription));
}

/** Why `attachAccount` will not take this account, or null when it will. */
async function refusal(
  ctx: MutationContext<Model>,
  { owner, signIn, subscription: id, found }: Parameters<typeof attachAccount>[1],
  same: Doc<Model, "accounts"> | null,
): Promise<Failed | null> {
  const subscription = await ctx.db.get(id);
  if (!subscription || subscription.owner !== owner)
    return fail("Gone", { message: "That subscription was removed meanwhile. Nothing was added." });
  if (subscription.company !== signIn.company)
    return fail("OtherCompany", { message: "That account is of another company. Nothing was added." });
  const who = found.email ?? "This account";
  if (same && same.subscription !== subscription._id) {
    const other = await ctx.db.get(same.subscription);
    return fail("AlreadyAdded", {
      message: `${who} is already added${other?.label ? ` as "${other.label}"` : " to another subscription"}.`,
    });
  }
  if (same?.status === "ok")
    return fail("AlreadyAdded", { message: `${who} is already in this subscription.` });
  if (!plansFit(subscription.plan, found))
    return fail("OtherPlan", {
      message: `${who} is on ${companies[subscription.company].name} ${found.plan}, not ${subscription.plan}. Add it as a subscription of its own.`,
    });
  return null;
}

const accountsOf = (ctx: { db: DatabaseReader<Model> }, subscription: Id<"subscriptions">) =>
  ctx.db
    .query("accounts")
    .withIndex("by_subscription", (q) => q.eq("subscription", subscription))
    .collect();
const loginsOf = (ctx: { db: DatabaseReader<Model> }, account: Id<"accounts">) =>
  ctx.db
    .query("logins")
    .withIndex("by_account", (q) => q.eq("account", account))
    .collect();

/**
 * Signs one provider account out: its login is deleted here, so nothing can
 * use or renew it again. The account stays, "Signed out", and a sign-in with
 * `repair` (or "Add account" with the same account) signs it in again in
 * place. With every account signed out the subscription shows "Signed out".
 */
export const signOutAccount = pluginOnly(
  mutation({
    args: { id: v.string() },
    handler: async (ctx, { id }) => {
      const ref = idIn("accounts", id);
      const account = ref && (await ctx.db.get(ref));
      if (!account || account.owner !== ownerOf(ctx.auth)) return notFound("account");
      for (const login of await loginsOf(ctx, account._id)) await ctx.db.delete(login._id);
      await ctx.db.patch(account._id, { status: "signed-out", reason: SIGNED_OUT });
      return null;
    },
  }),
);

/**
 * Removes a subscription with everything under it, in one transaction: its
 * accounts, their logins, and any sign-in still waiting to repair it or add
 * an account to it. A sign-in that finishes later finds it gone and adds
 * nothing. Anything that held it is the caller's to update.
 */
export const removeSubscription = pluginOnly(
  mutation({
    args: { id: v.string() },
    handler: async (ctx, { id }) => {
      const ref = idIn("subscriptions", id);
      const subscription = ref && (await ctx.db.get(ref));
      const owner = ownerOf(ctx.auth);
      if (!subscription || subscription.owner !== owner) return notFound("subscription");
      for (const account of await accountsOf(ctx, subscription._id)) {
        for (const login of await loginsOf(ctx, account._id)) await ctx.db.delete(login._id);
        await ctx.db.delete(account._id);
      }
      const signIns = await ctx.db
        .query("signIns")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .collect();
      for (const row of signIns)
        if (row.repair === subscription._id || row.addTo === subscription._id) await ctx.db.delete(row._id);
      await ctx.db.delete(subscription._id);
      return null;
    },
  }),
);

/**
 * The subscription's company and its accounts, oldest first; null when it is
 * gone or another member's. The company picks whose reads "Check again" makes.
 */
export const accounts = internalQuery({
  args: { owner: v.string(), subscription: v.id("subscriptions") },
  handler: async (ctx, { owner, subscription }) => {
    const row = await ctx.db.get(subscription);
    if (!row || row.owner !== owner) return null;
    return {
      company: row.company,
      accounts: (await accountsOf(ctx, subscription))
        .sort((a, b) => a._creationTime - b._creationTime)
        .map((account) => ({ id: account._id, status: account.status })),
    };
  },
});

/**
 * The company of the member's subscription, or of the subscription an account
 * is under: whose sign-in "Add account" and an account's "Sign in" start.
 * Null when it is gone or another member's.
 */
export const companyOf = internalQuery({
  args: {
    owner: v.string(),
    subscription: v.optional(v.id("subscriptions")),
    account: v.optional(v.id("accounts")),
  },
  handler: async (ctx, { owner, subscription, account }) => {
    let target = subscription;
    if (account) {
      const row = await ctx.db.get(account);
      if (!row || row.owner !== owner) return null;
      target = row.subscription;
    }
    const row = target && (await ctx.db.get(target));
    return row && row.owner === owner ? row.company : null;
  },
});

const model = v.object({ id: v.string(), name: v.string() });

/**
 * Keeps what "Check again" read, by the one rule for reads (reads.ts): each
 * account's models when its read returned some, the subscription's models as
 * the union of all its accounts', and the first plan the company named. An
 * account the company did not answer for keeps its email and organisation.
 */
export const checked = internalMutation({
  args: {
    owner: v.string(),
    subscription: v.id("subscriptions"),
    read: v.array(
      v.object({
        account: v.id("accounts"),
        planKnown: v.boolean(),
        plan: v.string(),
        email: v.optional(v.string()),
        organization: v.optional(v.string()),
        workspace: v.optional(v.string()),
        models: v.array(model),
      }),
    ),
  },
  handler: async (ctx, { owner, subscription: id, read }) => {
    const subscription = await ctx.db.get(id);
    if (!subscription || subscription.owner !== owner) return notFound("subscription");
    let planTaken = false;
    for (const answer of read) {
      const account = await ctx.db.get(answer.account);
      if (!account || account.subscription !== id) continue;
      await ctx.db.patch(account._id, {
        ...(answer.email !== undefined && { email: answer.email }),
        ...(answer.organization !== undefined && { organization: answer.organization }),
        ...(answer.workspace !== undefined && { workspace: answer.workspace }),
      });
      await storeRead(ctx, account._id, { ...answer, planKnown: answer.planKnown && !planTaken });
      planTaken ||= answer.planKnown;
    }
    return viewOf((await ctx.db.get(id))!, await accountsOf(ctx, id));
  },
});

/**
 * Reads the plan, each account's email and organisation, and the models
 * again, with a fresh login of each signed-in account (renewed first when it
 * runs out soon, by the usual rules in `logins.ts`), through the subscription's
 * own company module (`companies.ts`). When the company answers none
 * of it, nothing changes and the answer says so; when no account has a login,
 * it says to sign in.
 */
export const checkAgain = pluginOnly(
  action({
    args: { id: v.string() },
    handler: async (ctx, { id }): Promise<SubscriptionView | Failed> => {
      const subscription = idIn("subscriptions", id);
      if (!subscription) return notFound("subscription");
      const owner = ownerOf(ctx.auth);
      const listed = await ctx.runQuery(internal.manage.accounts, { owner, subscription });
      if (!listed) return notFound("subscription");
      // The subscription's own company reads it: never one company's login at another's address.
      const company = companies[listed.company];
      const addresses = await companyAddresses(ctx);
      const read = [];
      for (const account of listed.accounts) {
        if (account.status !== "ok") continue;
        const login = await ctx.runAction(internal.logins.fresh, { owner, account: account.id });
        if (!login) continue;
        const about = await company.details(addresses, {
          login: { access: login.access },
          identity: login.workspace !== undefined ? { workspace: login.workspace } : {},
        });
        const { email, organization, workspace } = about.identity;
        read.push({
          account: account.id,
          planKnown: about.planKnown,
          plan: about.plan,
          ...(email !== undefined && { email }),
          ...(organization !== undefined && { organization }),
          ...(workspace !== undefined && { workspace }),
          models: about.models,
        });
      }
      if (!read.length)
        return fail("SignedOut", { message: "No account of this subscription is signed in. Sign in first." });
      if (!read.some((answer) => answer.planKnown || answer.models.length))
        return fail("Unreachable", {
          message: `${company.name} did not answer. Nothing changed; try again.`,
        });
      return ctx.runMutation(internal.manage.checked, { owner, subscription, read });
    },
  }),
);
