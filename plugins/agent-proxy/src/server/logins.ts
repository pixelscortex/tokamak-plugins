import { v, type Id } from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";
import { internal } from "./_generated/internal";
import { RENEW_BEFORE_MS, internalAction, internalMutation, internalQuery } from "./_functions";
import { companyAddresses } from "./addresses";
import { companies } from "./companies";

/**
 * The stored logins. Everything here is internal: no window and no other
 * plugin can call it, and nothing it returns leaves this plugin. The one way
 * to a usable login is `fresh`, which renews it first when it is about to run
 * out; the proxy calls it before forwarding a request.
 *
 * These take the member as `owner` instead of reading the caller: a proxy
 * request carries a turn key, with no member behind it. Every public or
 * plugin-only function passes its caller here.
 *
 * Renewal is claimed: one call at a time sends a refresh token to the
 * company, because a company that revokes a login when a refresh token is
 * used twice (OpenAI answers `refresh_token_reused`) would sign the account
 * out. Each company's module decides what its answers mean; nothing here
 * names a company. Failures that are not a refusal wait before the
 * next try, so an open screen does not ask every minute forever.
 */

const account = v.id("accounts");
const owner = v.string();
const refusedBy = (name: string) => `${name} would not renew the login. Sign in again.`;
/** How long a claim holds: longer than one renewal request (20 s timeout) takes. */
const CLAIM_MS = 30_000;
/** First wait after a failed renewal; it doubles with each failure in a row, up to the cap. */
const BACKOFF_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
/** A caller that lost the claim and has no usable login waits this long, this many times. */
const WAIT_MS = 1_000;
const WAITS = CLAIM_MS / WAIT_MS;

/**
 * The login for `account`, with the account's workspace id when the company
 * has one (ChatGPT's `chatgpt-account-id`); null when there is none or it is
 * another member's.
 */
export const read = internalQuery({
  args: { owner, account },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", args.account))
      .first();
    if (!row || row.owner !== args.owner) return null;
    const workspace = (await ctx.db.get(args.account))?.workspace;
    return { ...row, ...(workspace !== undefined && { workspace }) };
  },
});

/** Expire this login and let the 401 trigger a renewal even during a previous backoff. */
export const rejectAccess = internalMutation({
  args: { owner, account, access: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", args.account))
      .first();
    // Another request may already have expired or rotated this login.
    if (row?.owner === args.owner && row.access === args.access && row.expiresAt === args.expiresAt)
      await ctx.db.patch(row._id, { expiresAt: 0, retryAt: 0 });
  },
});

export const isSignedOut = internalQuery({
  args: { owner, account },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.account);
    return row?.owner === args.owner && row.status === "signed-out";
  },
});

/** A member's signed-in accounts, for the proxy to choose from (TKM-263). */
export const accountsOf = internalQuery({
  args: { owner },
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query("accounts")
        .withIndex("by_owner", (q) => q.eq("owner", args.owner))
        .collect()
    )
      .filter((row) => row.status === "ok")
      .map((row) => ({ account: row._id, subscription: row.subscription })),
});

/** A member's accounts whose login runs out within the renewal margin, soonest first. */
export const due = internalQuery({
  args: { owner },
  handler: async (ctx, args) => {
    const soon = Date.now() + RENEW_BEFORE_MS;
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .collect();
    const due: { account: Id<"accounts">; expiresAt: number }[] = [];
    for (const row of accounts) {
      if (row.status !== "ok") continue;
      const login = await ctx.db
        .query("logins")
        .withIndex("by_account", (q) => q.eq("account", row._id))
        .first();
      if (login && login.expiresAt <= soon) due.push({ account: row._id, expiresAt: login.expiresAt });
    }
    return due.sort((a, b) => a.expiresAt - b.expiresAt);
  },
});

/**
 * Takes the right to renew: the refresh token to send, or why not now
 * (another call holds the claim, or the last failure asked to wait).
 */
export const claim = internalMutation({
  args: { owner, account },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", args.account))
      .first();
    if (!row || row.owner !== args.owner) return { kind: "gone" as const };
    const now = Date.now();
    if (row.expiresAt > now + RENEW_BEFORE_MS) return { kind: "fresh" as const };
    if ((row.renewingUntil ?? 0) > now) return { kind: "busy" as const };
    if ((row.retryAt ?? 0) > now) return { kind: "later" as const };
    const account = await ctx.db.get(args.account);
    const subscription = account && (await ctx.db.get(account.subscription));
    if (!subscription) return { kind: "gone" as const };
    await ctx.db.patch(row._id, { renewingUntil: now + CLAIM_MS });
    return { kind: "claimed" as const, refresh: row.refresh, company: subscription.company };
  },
});

/** Keeps a renewed login and lets go of the claim; false when the login changed meanwhile. */
export const renewed = internalMutation({
  args: {
    owner,
    account,
    refresh: v.string(),
    access: v.string(),
    next: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, { owner, account, refresh, access, next, expiresAt }) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (!row || row.owner !== owner || row.refresh !== refresh) return false;
    await ctx.db.replace(row._id, { owner, account, access, refresh: next, expiresAt });
    return true;
  },
});

/** The company will not renew it: the login is deleted and the account shows "Signed out". */
export const refused = internalMutation({
  args: { owner, account, refresh: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", args.account))
      .first();
    if (!row || row.owner !== args.owner || row.refresh !== args.refresh) return false;
    await ctx.db.delete(row._id);
    await ctx.db.patch(args.account, { status: "signed-out", reason: refusedBy(args.name) });
    return true;
  },
});

/** Not now: lets go of the claim and sets when to try again. */
export const later = internalMutation({
  args: { owner, account, refresh: v.string(), afterMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", args.account))
      .first();
    if (!row || row.owner !== args.owner || row.refresh !== args.refresh) return false;
    const failures = (row.failures ?? 0) + 1;
    const wait = args.afterMs ?? Math.min(BACKOFF_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
    const { renewingUntil: _claim, ...rest } = row;
    const { _id, _creationTime, ...fields } = rest;
    await ctx.db.replace(_id, { ...fields, retryAt: Date.now() + wait, failures });
    return true;
  },
});

/** `renewed` says whether this call got a new login from the company. */
/**
 * `workspace` is the id every request of this login must name, when the
 * company has one (ChatGPT's `chatgpt-account-id` header); absent for Claude.
 */
type Fresh = { access: string; expiresAt: number; renewed: boolean; workspace?: string } | null;
type Stored = { access: string; expiresAt: number; workspace?: string };
const workspace = (login: Stored) => (login.workspace !== undefined ? { workspace: login.workspace } : {});
const usable = (login: Stored | null, margin = 0): Fresh =>
  login && login.expiresAt > Date.now() + margin
    ? { access: login.access, expiresAt: login.expiresAt, renewed: false, ...workspace(login) }
    : null;

/**
 * A login that is good for at least the renewal margin, renewed first when
 * needed; when it cannot be renewed now, the stored one while it still works;
 * null when the account is signed out or has nothing usable. Returns the
 * access token: only this plugin's own server code may call it.
 */
export const fresh = internalAction({
  args: { owner, account },
  handler: async (ctx, args): Promise<Fresh> => {
    const login = await ctx.runQuery(internal.logins.read, args);
    if (!login) return null;
    const good = usable(login, RENEW_BEFORE_MS);
    if (good) return good;
    const claimed = await ctx.runMutation(internal.logins.claim, args);
    if (claimed.kind === "gone") return null;
    if (claimed.kind === "fresh") return usable(await ctx.runQuery(internal.logins.read, args));
    if (claimed.kind === "later") return usable(login);
    if (claimed.kind === "busy") {
      // Renewal starts five minutes early, so the stored login usually still works.
      if (usable(login)) return usable(login);
      for (let i = 0; i < WAITS; i++) {
        await new Promise((done) => setTimeout(done, WAIT_MS));
        const now = await ctx.runQuery(internal.logins.read, args);
        if (!now) return null;
        if (usable(now) || (now.renewingUntil ?? 0) <= Date.now()) return usable(now);
      }
      return null;
    }
    const company = companies[claimed.company];
    const answer = await company.renew(await companyAddresses(ctx), claimed.refresh);
    const refresh = claimed.refresh;
    if (answer.kind === "renewed") {
      // A renewed ID token is dropped: the workspace is already on the account.
      const { access, refresh: next, expiresAt } = answer.login;
      // Signed out or removed while the company answered: the login is gone, and so is this one.
      const kept = await ctx.runMutation(internal.logins.renewed, {
        ...args,
        refresh,
        access,
        next,
        expiresAt,
      });
      return kept ? { access, expiresAt, renewed: true, ...workspace(login) } : null;
    }
    if (answer.kind === "refused") {
      await ctx.runMutation(internal.logins.refused, { ...args, refresh, name: company.name });
      return null;
    }
    await ctx.runMutation(internal.logins.later, {
      ...args,
      refresh,
      ...(answer.afterMs !== undefined && { afterMs: answer.afterMs }),
    });
    return usable(login);
  },
});
