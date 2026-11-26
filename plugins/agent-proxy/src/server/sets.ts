import { fail, pluginOnly, v, type Id, type QueryContext } from "@tokamak/sdk";
import { internal } from "./_generated/internal";
import {
  action,
  idIn,
  internalMutation,
  internalQuery,
  mutation,
  notFound,
  ownerOf,
  type Model,
} from "./_functions";
import { challenge, randomToken } from "./pkce";
import { company } from "./schema";
import type { Company } from "./addresses";

const setId = v.string();
const ownerId = v.string();
const hashValue = v.string();
const TURN_KEY_TTL_MS = 8 * 60 * 60_000;
const TURN_KEY_IDLE_MS = 15 * 60_000;
const TURN_KEY_TOUCH_MS = 60_000;

export function turnKeyHash(key: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(key) ? challenge(key) : null;
}

/** Keep the set's id when its owner changes the ordered list. */
export const registerSet = pluginOnly(
  mutation({
    args: { set: v.optional(setId), subscriptions: v.array(v.string()) },
    handler: async (ctx, { set, subscriptions }) => {
      const owner = ownerOf(ctx.auth);
      const ordered = new Set<Id<"subscriptions">>();
      for (const id of subscriptions) {
        const ref = idIn("subscriptions", id);
        const subscription = ref && (await ctx.db.get(ref));
        if (!subscription || subscription.owner !== owner) return notFound("subscription");
        ordered.add(subscription._id);
      }
      const fields = { owner, subscriptions: [...ordered] };
      if (set === undefined) {
        const id = await ctx.db.insert("sets", fields);
        return { set: id.slice(id.indexOf("/") + 1) };
      }
      const ref = idIn("sets", set);
      const row = ref && (await ctx.db.get(ref));
      if (!row || row.owner !== owner) return notFound("set");
      await ctx.db.replace(row._id, fields);
      return { set: row._id.slice(row._id.indexOf("/") + 1) };
    },
  }),
);

/** Removing a set prevents new keys. Leased keys keep their launch snapshot. */
export const removeSet = pluginOnly(
  mutation({
    args: { set: setId },
    handler: async (ctx, { set }) => {
      const ref = idIn("sets", set);
      const row = ref && (await ctx.db.get(ref));
      if (!row || row.owner !== ownerOf(ctx.auth)) return notFound("set");
      await ctx.db.delete(row._id);
      return null;
    },
  }),
);

/** The raw credential only crosses the boundary back to the calling plugin. */
export const turnKey = pluginOnly(
  action({
    args: { set: setId, lease: v.optional(v.string()), company: v.optional(company) },
    handler: async (ctx, { set, lease, company = "anthropic" }) => {
      const owner = ownerOf(ctx.auth);
      const origin = await ctx.server.url();
      if (!origin)
        return fail("MissingServerOrigin", { message: "Set TOKAMAK_PUBLIC_URL to hand out turn keys." });
      const key = randomToken();
      const saved = await ctx.runMutation(internal.sets.issue, {
        owner,
        set,
        company,
        hash: challenge(key),
        ...(lease !== undefined && { lease }),
      });
      if (!saved) return notFound("set");
      const suffix = company === "openai" ? "/openai" : "";
      return { address: new URL(`/plugins/agent-proxy/${saved}${suffix}`, origin).href, key };
    },
  }),
);

export const endTurnKey = pluginOnly(
  mutation({
    args: { key: v.optional(v.string()), lease: v.optional(v.string()) },
    handler: async (ctx, { key, lease }) => {
      const owner = ownerOf(ctx.auth);
      if (lease !== undefined) {
        const rows = await ctx.db
          .query("turnKeys")
          .withIndex("by_owner_lease", (q) => q.eq("owner", owner).eq("lease", lease))
          .collect();
        for (const row of rows) await ctx.db.patch(row._id, { ended: true });
        return null;
      }
      const hash = key !== undefined && turnKeyHash(key);
      if (!hash) return null;
      const row = await ctx.db
        .query("turnKeys")
        .withIndex("by_hash", (q) => q.eq("hash", hash))
        .first();
      if (row?.owner === owner) await ctx.db.patch(row._id, { ended: true });
      return null;
    },
  }),
);

export const issue = internalMutation({
  args: { owner: ownerId, set: setId, hash: hashValue, lease: v.optional(v.string()), company },
  handler: async (ctx, { owner, set, hash, lease, company }) => {
    const id = idIn("sets", set);
    const row = id && (await ctx.db.get(id));
    if (!row || row.owner !== owner) return null;
    const now = Date.now();
    const expired = await ctx.db
      .query("turnKeys")
      .withIndex("by_owner_expiry", (q) => q.eq("owner", owner).lte("expiresAt", now))
      .take(100);
    for (const previous of expired) await ctx.db.delete(previous._id);
    const snapshot = [];
    if (lease !== undefined) {
      for (const id of row.subscriptions) {
        const subscription = await ctx.db.get(id);
        if (subscription?.owner === owner && subscription.company === company && subscription.enabled)
          snapshot.push(id);
      }
    }
    await ctx.db.insert("turnKeys", {
      owner,
      set: row._id,
      hash,
      company,
      expiresAt: now + TURN_KEY_TTL_MS,
      ...(lease !== undefined && { lease, subscriptions: snapshot }),
    });
    return row._id.slice(row._id.indexOf("/") + 1);
  },
});

async function validKey(
  ctx: Pick<QueryContext<Model>, "db">,
  { set, hash, company }: { set: string; hash: string; company: Company },
  now: number,
) {
  const key = await ctx.db
    .query("turnKeys")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .first();
  if (!key) return { error: "Unknown turn key." };
  if (key.set !== idIn("sets", set)) return { error: "Turn key belongs to a different set." };
  if ((key.company ?? "anthropic") !== company) return { error: "Turn key belongs to a different company." };
  if (key.ended) return { error: "Turn key has ended." };
  const activeAt = key.lastAcceptedAt ?? key.expiresAt - TURN_KEY_TTL_MS;
  if (key.expiresAt <= now || activeAt + TURN_KEY_IDLE_MS <= now) return { error: "Turn key has expired." };
  return { key };
}

const keyArgs = { set: setId, hash: hashValue, company };

export const candidates = internalQuery({
  args: keyArgs,
  handler: async (ctx, args) => {
    const now = Date.now();
    const result = await validKey(ctx, args, now);
    if (!result.key) return { ok: false as const, error: result.error };
    const { key } = result;
    const snapshot = key.subscriptions;
    let subscriptions = snapshot;
    if (!subscriptions) {
      const row = await ctx.db.get(key.set);
      if (!row || row.owner !== key.owner) return { ok: false as const, error: "Turn key has no set." };
      subscriptions = row.subscriptions;
    }

    const availability = await eligibleAccounts(
      ctx,
      key.owner,
      subscriptions,
      args.company,
      now,
      snapshot !== undefined,
    );
    return { ok: true as const, owner: key.owner, touch: needsTouch(key, now), ...availability };
  },
});

// Persist the first use, then at most once a minute. Expiry uses the last durable touch.
function needsTouch(key: { lastAcceptedAt?: number }, now: number) {
  return key.lastAcceptedAt === undefined || now - key.lastAcceptedAt >= TURN_KEY_TOUCH_MS;
}

export const touch = internalMutation({
  args: keyArgs,
  handler: async (ctx, args) => {
    const now = Date.now();
    const result = await validKey(ctx, args, now);
    if (!result.key) return result.error;
    if (needsTouch(result.key, now)) await ctx.db.patch(result.key._id, { lastAcceptedAt: now });
    return null;
  },
});

async function eligibleAccounts(
  ctx: QueryContext<Model>,
  owner: string,
  subscriptions: readonly Id<"subscriptions">[],
  company: Company,
  now: number,
  snapshot: boolean,
) {
  const accounts = [];
  let earliestReset = 0;
  for (const id of subscriptions) {
    const subscription = await ctx.db.get(id);
    if (
      !subscription ||
      (!snapshot && !subscription.enabled) ||
      subscription.owner !== owner ||
      subscription.company !== company
    )
      continue;
    const members = await ctx.db
      .query("accounts")
      .withIndex("by_subscription", (q) => q.eq("subscription", id))
      .collect();
    for (const account of members) {
      if (account.owner !== owner || account.status !== "ok" || (company === "openai" && !account.workspace))
        continue;
      const until = account.limitedUntil ?? 0;
      if (until <= now) accounts.push({ id: account._id, subscription: id });
      else earliestReset = earliestReset ? Math.min(earliestReset, until) : until;
    }
  }
  return { accounts, earliestReset };
}

export const recordForward = internalMutation({
  args: {
    owner: ownerId,
    subscription: v.id("subscriptions"),
    account: v.id("accounts"),
    limitedUntil: v.number(),
    success: v.boolean(),
  },
  handler: async (ctx, { owner, subscription, account, limitedUntil, success }) => {
    const row = await ctx.db.get(subscription);
    if (row?.owner !== owner) return;
    const now = Date.now();
    if (success) await ctx.db.patch(subscription, { lastUsedAt: now });
    if (limitedUntil <= now) return;
    const member = await ctx.db.get(account);
    if (member?.owner === owner && limitedUntil > (member.limitedUntil ?? 0))
      await ctx.db.patch(account, { limitedUntil });
  },
});
