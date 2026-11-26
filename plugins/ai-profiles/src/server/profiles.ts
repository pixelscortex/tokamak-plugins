import {
  createFunctions,
  fail,
  isFailure,
  type AuthContext,
  type Doc,
  type Id,
  type ModelFromSchema,
  type MutationContext,
  type QueryContext,
  v,
} from "@tokamak/sdk";
import { api as proxy, type SubscriptionView } from "plugin:agent-proxy/server";
import schema from "./schema";

/**
 * A person's profiles: named, ordered sets of their subscriptions. The window
 * builds them on the Profiles screen; a turn will run on one (TKM-266).
 *
 * Every function works for the caller only: it reads the caller's rows, and a
 * profile id of another member, of another table, or malformed gets the same
 * plain "gone" answer as a deleted one, never an error.
 *
 * A profile keeps its subscriptions as `agent-proxy` ids. One `agent-proxy`
 * does not list right now is hidden from every reader, but stays stored: it
 * may only be hidden for a while, and comes back when it is listed again.
 * Only `forgetSubscription`, called by the flow that removes a subscription,
 * deletes entries. Positions the window sends (`at`, `to`) count the visible
 * list only; hidden entries keep their place among the stored ones.
 */

const { query, mutation, internalQuery, internalMutation } = createFunctions(schema);
type Model = ModelFromSchema<typeof schema>;
type Row = Doc<Model, "profiles">;
type Reader = QueryContext<Model> | MutationContext<Model>;

/** What the window and the rest of this plugin learn of a profile. */
export interface ProfileView {
  readonly id: string;
  readonly name: string;
  /** Upper case, one to four characters: what the picker and the cards show. */
  readonly code: string;
  /** Subscription ids in use order, first used first; only ones `agent-proxy` lists now. */
  readonly subscriptions: readonly string[];
  readonly createdAt: number;
}

const MAX_NAME = 64;
/** Profiles one person may have: enough for every company and side project, small enough for a picker. */
export const MAX_PROFILES = 32;
const CODE = /^[A-Z0-9]{1,4}$/;

const ownerOf = (auth: AuthContext) => auth.user.id;

/**
 * `value` as a profile id, or null. Ids arrive as strings, and `db.get` takes
 * an id of any of this plugin's tables, so each is checked before it is read.
 */
function profileId(value: string): Id<"profiles"> | null {
  return /^(?:ai-profiles\/)?profiles:[A-Za-z0-9_-]+$/.test(value) ? (value as Id<"profiles">) : null;
}

/**
 * One form of an `agent-proxy` subscription id, for storing and comparing.
 * `agent-proxy` accepts `agent-proxy/subscriptions:x` and `subscriptions:x`
 * as the same subscription, so both become `subscriptions:x` here; anything
 * that is not a subscription id comes back unchanged and matches nothing.
 */
export const subscriptionKey = (id: string) => id.replace(/^agent-proxy\/(?=subscriptions:)/, "");

const gone = (what: "profile" | "subscription") => fail("NotFound", { message: `That ${what} is gone.` });

/**
 * The code rules, for making a profile and (TKM-269) renaming one: trimmed,
 * upper case, one to four letters or digits, and no other profile of the
 * owner with it (`except` is the profile being renamed). Checked in the same
 * transaction as the write; the unique index on owner and code is the backstop.
 */
export async function checkCode(ctx: Reader, owner: string, raw: string, except?: string) {
  const code = raw.trim().toUpperCase();
  if (!CODE.test(code))
    return fail("Invalid", { field: "code", message: "A code is 1 to 4 letters or digits." });
  const taken = await ctx.db
    .query("profiles")
    .withIndex("by_owner_code", (q) => q.eq("owner", owner).eq("code", code))
    .first();
  if (taken && taken._id !== except)
    return fail("Taken", { field: "code", message: `You already have a profile ${code}.` });
  return { code };
}

/** The caller's profile with this id, or null when it is not theirs or not a profile. */
export async function own(ctx: Reader, id: string): Promise<Row | null> {
  const ref = profileId(id);
  const row = ref && (await ctx.db.get(ref));
  return row && row.owner === ownerOf(ctx.auth) ? row : null;
}

/** The caller's subscriptions as `agent-proxy` lists them now, by `subscriptionKey`. */
export async function subscriptionsOf(ctx: Reader): Promise<Map<string, SubscriptionView>> {
  const { subscriptions } = await ctx.use(proxy).listSubscriptions({});
  return new Map(subscriptions.map((subscription) => [subscriptionKey(subscription.id), subscription]));
}

export const rowsOf = (ctx: Reader, owner: string) =>
  ctx.db
    .query("profiles")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .collect();

/** The stored keys of a row's entries, hidden ones included. */
const keysOf = (row: Pick<Row, "entries">) => row.entries.map((entry) => subscriptionKey(entry.subscription));

function viewOf(
  row: Pick<Row, "_id" | "name" | "code" | "entries" | "createdAt">,
  live: ReadonlyMap<string, SubscriptionView>,
): ProfileView {
  return {
    id: row._id,
    name: row.name,
    code: row.code,
    subscriptions: keysOf(row).flatMap((key) => {
      const listed = live.get(key);
      return listed ? [listed.id] : [];
    }),
    createdAt: row.createdAt,
  };
}

/**
 * Where a subscription goes in the stored list so it sits at `at` in the
 * visible one: before the visible entry now at `at`, or after everything when
 * `at` is past the end. Hidden entries keep their place among the rest.
 */
function storedPosition(keys: readonly string[], live: ReadonlyMap<string, unknown>, at: number) {
  const visible = keys.filter((key) => live.has(key));
  const position = Math.min(Math.max(Math.trunc(at), 0), visible.length);
  return position === visible.length ? keys.length : keys.indexOf(visible[position]!);
}

/** The profile `profile` with the caller's subscriptions now, or the failure to return. */
async function editable(ctx: MutationContext<Model>, profile: string) {
  const row = await own(ctx, profile);
  if (!row) return { failure: gone("profile") } as const;
  return { row, live: await subscriptionsOf(ctx), keys: keysOf(row) } as const;
}

/** The single write path for a profile's entries; `keys` holds hidden entries too. */
async function save(
  ctx: MutationContext<Model>,
  row: Row,
  keys: readonly string[],
  live: ReadonlyMap<string, SubscriptionView>,
) {
  const entries = keys.map((subscription) => ({ subscription }));
  const set = await syncSet(ctx, { ...row, entries }, live);
  await ctx.db.patch(row._id, { entries, set });
  return viewOf({ ...row, entries }, live);
}

/** The caller's profiles, oldest first. */
export const list = query({
  handler: async (ctx): Promise<ProfileView[]> => {
    const live = await subscriptionsOf(ctx);
    const rows = await rowsOf(ctx, ownerOf(ctx.auth));
    return rows.sort((a, b) => a.createdAt - b.createdAt).map((row) => viewOf(row, live));
  },
});

/**
 * A new, empty profile. The code follows `checkCode`; a person has at most
 * `MAX_PROFILES` profiles.
 */
export const create = mutation({
  args: { name: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const owner = ownerOf(ctx.auth);
    const name = args.name.trim().replace(/\s+/g, " ");
    if (!name) return fail("Invalid", { field: "name", message: "Give the profile a name." });
    if (name.length > MAX_NAME)
      return fail("Invalid", { field: "name", message: `A name is at most ${MAX_NAME} characters.` });
    const checked = await checkCode(ctx, owner, args.code);
    if ("failed" in checked) return checked;
    if ((await rowsOf(ctx, owner)).length >= MAX_PROFILES)
      return fail("TooMany", { message: `You can have at most ${MAX_PROFILES} profiles.` });
    const row = { owner, name, code: checked.code, entries: [] as Row["entries"], createdAt: Date.now() };
    const registered = await ctx.use(proxy).registerSet({ subscriptions: [] });
    if (isFailure(registered)) return registered;
    const id = await ctx.db.insert("profiles", { ...row, set: registered.set });
    return viewOf({ ...row, _id: id }, new Map());
  },
});

/**
 * Puts one of the caller's subscriptions into a profile so it shows at `at`
 * (0 is first used; left out, last). Only a subscription `agent-proxy` lists
 * for the caller right now can go in. One already in the profile is refused,
 * so a profile never holds one twice; it can be in any number of others.
 */
export const add = mutation({
  args: { profile: v.string(), subscription: v.string(), at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const found = await editable(ctx, args.profile);
    if ("failure" in found) return found.failure;
    const { row, live, keys } = found;
    const key = subscriptionKey(args.subscription);
    if (!live.has(key)) return gone("subscription");
    if (keys.includes(key))
      return fail("AlreadyAdded", { message: `${row.code} already uses that subscription.` });
    keys.splice(storedPosition(keys, live, args.at ?? Number.MAX_SAFE_INTEGER), 0, key);
    return save(ctx, row, keys, live);
  },
});

/** Moves a shown subscription inside a profile so it ends at `to` in the visible list (0 is first used). */
export const move = mutation({
  args: { profile: v.string(), subscription: v.string(), to: v.number() },
  handler: async (ctx, args) => {
    const found = await editable(ctx, args.profile);
    if ("failure" in found) return found.failure;
    const { row, live, keys } = found;
    const key = subscriptionKey(args.subscription);
    const from = keys.indexOf(key);
    if (from < 0 || !live.has(key)) return gone("subscription");
    keys.splice(from, 1);
    keys.splice(storedPosition(keys, live, args.to), 0, key);
    return save(ctx, row, keys, live);
  },
});

/** Takes a subscription out of one profile; it stays in Tokamak and in other profiles. */
export const remove = mutation({
  args: { profile: v.string(), subscription: v.string() },
  handler: async (ctx, args) => {
    const found = await editable(ctx, args.profile);
    if ("failure" in found) return found.failure;
    const { row, live, keys } = found;
    const key = subscriptionKey(args.subscription);
    if (!keys.includes(key)) return gone("subscription");
    return save(
      ctx,
      row,
      keys.filter((stored) => stored !== key),
      live,
    );
  },
});

/**
 * Deletes a subscription from every one of the caller's profiles, the only
 * place entries are deleted. The flow that removes a subscription from
 * Tokamak (TKM-265) calls it in the same transaction as the removal. It
 * throws when it cannot finish and never returns a failure, so a caller
 * cannot go on with a removal whose profile entries stayed behind. Returns how
 * many profiles held it.
 */
export const forgetSubscription = internalMutation({
  args: { subscription: v.string() },
  handler: async (ctx, args) => {
    const key = subscriptionKey(args.subscription);
    let held = 0;
    for (const row of await rowsOf(ctx, ownerOf(ctx.auth))) {
      const entries = row.entries.filter((entry) => subscriptionKey(entry.subscription) !== key);
      if (entries.length === row.entries.length) continue;
      held++;
      await save(
        ctx,
        row,
        entries.map((entry) => entry.subscription),
        await subscriptionsOf(ctx),
      );
    }
    return held;
  },
});

/**
 * The caller's profiles that hold `subscription` (an agent-proxy id, in either
 * spelling; compared by `subscriptionKey`), for the subscription details'
 * "Used by" and the remove confirmation. Hidden entries count: the profile
 * still holds it. The thread count is the number of threads using that profile.
 */
export const using = internalQuery({
  args: { subscription: v.string() },
  handler: async (ctx, args) => {
    const key = subscriptionKey(args.subscription);
    const profiles = (await rowsOf(ctx, ownerOf(ctx.auth)))
      .filter((row) => keysOf(row).includes(key))
      .sort((a, b) => a._creationTime - b._creationTime);
    return Promise.all(
      profiles.map(async (row) => ({
        id: row._id as string,
        code: row.code,
        name: row.name,
        threads: (await threadProfiles(ctx, row._id)).length,
      })),
    );
  },
});

/**
 * What a turn on this profile may use when it starts (TKM-266): the
 * caller's profile with its subscriptions in use order, only the enabled ones
 * that `agent-proxy` lists now. The picker lists profiles with `list`. The first is used first. Signed-out and limited accounts are
 * `agent-proxy`'s to skip when it picks one.
 */
export const inUseOrder = internalQuery({
  args: { profile: v.string() },
  handler: async (ctx, args) => {
    const row = await own(ctx, args.profile);
    if (!row) return gone("profile");
    const subscriptions = enabledOf(row, await subscriptionsOf(ctx));
    return { id: row._id as string, name: row.name, code: row.code, subscriptions };
  },
});

export function enabledOf(row: Row, live: ReadonlyMap<string, SubscriptionView>) {
  return keysOf(row)
    .map((key) => live.get(key))
    .filter((subscription): subscription is SubscriptionView => !!subscription?.enabled);
}

async function syncSet(ctx: MutationContext<Model>, row: Row, live: ReadonlyMap<string, SubscriptionView>) {
  const result = await ctx.use(proxy).registerSet({
    ...(row.set !== undefined && { set: row.set }),
    subscriptions: enabledOf(row, live).map((subscription) => subscription.id),
  });
  if (isFailure(result)) throw new Error(result.data.message);
  return result.set;
}

// Backfill profiles created before sets were stored.
export const ensureSet = internalMutation({
  args: { profile: v.string() },
  handler: async (ctx, { profile }) => {
    const row = await own(ctx, profile);
    if (!row) return null;
    if (row.set !== undefined) return row.set;
    const set = await syncSet(ctx, row, await subscriptionsOf(ctx));
    await ctx.db.patch(row._id, { set });
    return set;
  },
});

export async function syncSubscription(ctx: MutationContext<Model>, subscription: string) {
  const key = subscriptionKey(subscription);
  const rows = (await rowsOf(ctx, ownerOf(ctx.auth))).filter((row) => keysOf(row).includes(key));
  if (rows.length === 0) return;
  const live = await subscriptionsOf(ctx);
  for (const row of rows) {
    const set = await syncSet(ctx, row, live);
    if (row.set !== set) await ctx.db.patch(row._id, { set });
  }
}

const threadProfiles = (ctx: Reader, profile: Id<"profiles">) =>
  ctx.db
    .query("threadProfiles")
    .withIndex("by_profile", (q) => q.eq("profile", profile))
    .collect();

export const discard = mutation({
  args: { profile: v.string() },
  handler: async (ctx, { profile }) => {
    const row = await own(ctx, profile);
    if (!row) return gone("profile");
    if (row.set !== undefined) {
      const removed = await ctx.use(proxy).removeSet({ set: row.set });
      if (isFailure(removed)) return removed;
    }
    for (const entry of await threadProfiles(ctx, row._id)) await ctx.db.delete(entry._id);
    const last = await ctx.db
      .query("lastProfiles")
      .withIndex("by_owner", (q) => q.eq("owner", row.owner))
      .first();
    if (last?.profile === row._id) await ctx.db.delete(last._id);
    await ctx.db.delete(row._id);
    return null;
  },
});
