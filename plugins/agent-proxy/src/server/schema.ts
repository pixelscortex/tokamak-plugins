import { defineSchema, defineTable, v } from "@tokamak/sdk";

/** The companies a subscription can be with; `companies.ts` holds each one's sign-in. */
export const company = v.union(v.literal("anthropic"), v.literal("openai"));

/**
 * Every row carries `owner`, the member who added it: a subscription is one
 * person's, and every function reads and writes only the caller's rows.
 *
 * The secrets live in two tables of their own, `logins` and `signIns`, which
 * only this plugin's internal functions read. Nothing that leaves the plugin
 * is built from them. There is no secret store in the SDK yet (TKM-292), so
 * whoever can read the server's database can read them.
 */
export default defineSchema({
  /** What a person added: one company's subscription, under their own label. */
  subscriptions: defineTable({
    owner: v.string(),
    company,
    method: v.literal("subscription"),
    label: v.string(),
    /**
     * "Max", "Pro", "Plus", "Business"…; empty while no read has named the
     * plan (never "Free" by guess; reads.ts).
     */
    plan: v.string(),
    enabled: v.boolean(),
    models: v.array(v.object({ id: v.string(), name: v.string() })),
    /** When a turn last went through it; none until the proxy uses it. */
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_owner", ["owner"]),

  /** One login at the company: a team plan can hold several under one subscription. */
  accounts: defineTable({
    owner: v.string(),
    subscription: v.id("subscriptions"),
    /** The company's own id for the account, so the same login is never added twice. */
    accountId: v.string(),
    email: v.optional(v.string()),
    organization: v.optional(v.string()),
    /**
     * The company's id of the workspace every request of this login must
     * name (ChatGPT's `chatgpt-account-id`); none for Claude. Kept here so the
     * proxy needs no ID token: that is never stored.
     */
    workspace: v.optional(v.string()),
    status: v.union(v.literal("ok"), v.literal("signed-out")),
    /** When a known account quota window resets, in milliseconds since epoch. */
    limitedUntil: v.optional(v.number()),
    /**
     * The models this account's login may use, as last read; absent until a read
     * returned some. The subscription's `models` is the union of these (reads.ts).
     */
    models: v.optional(v.array(v.object({ id: v.string(), name: v.string() }))),
    /** Why the account is signed out, in the person's words. */
    reason: v.optional(v.string()),
  })
    .index("by_owner", ["owner"])
    .index("by_subscription", ["subscription"])
    .index("by_owner_account", ["owner", "accountId"]),

  sets: defineTable({
    owner: v.string(),
    subscriptions: v.array(v.id("subscriptions")),
  }),

  /** The database never holds a raw turn key. */
  turnKeys: defineTable({
    owner: v.string(),
    set: v.id("sets"),
    hash: v.string(),
    // Existing keys without a company were issued for Claude.
    company: v.optional(company),
    // Older keys use the live set until they expire.
    subscriptions: v.optional(v.array(v.id("subscriptions"))),
    lease: v.optional(v.string()),
    expiresAt: v.number(),
    lastAcceptedAt: v.optional(v.number()),
    ended: v.optional(v.boolean()),
  })
    .index("by_hash", ["hash"])
    .index("by_owner_lease", ["owner", "lease"])
    .index("by_owner_expiry", ["owner", "expiresAt"]),

  /** The login itself. Only internal functions read this table. */
  logins: defineTable({
    owner: v.string(),
    account: v.id("accounts"),
    access: v.string(),
    refresh: v.string(),
    /** Milliseconds since the epoch. */
    expiresAt: v.number(),
    /**
     * Set while one call renews this login, so a refresh token goes to the
     * company once: other callers use the stored token or wait for the new one.
     */
    renewingUntil: v.optional(v.number()),
    /** No renewal before this time: the company asked to wait, or could not be reached. */
    retryAt: v.optional(v.number()),
    /** Renewals in a row that could not reach the company; the wait doubles with each. */
    failures: v.optional(v.number()),
  }).index("by_account", ["account"]),

  /**
   * A sign-in that has started and not ended. It lives on when the dialog
   * closes, so the screen can show "Awaiting sign-in" and the person can
   * still paste. `verifier` and `state` stay here; the window gets the link.
   */
  signIns: defineTable({
    owner: v.string(),
    company,
    method: v.literal("subscription"),
    verifier: v.string(),
    state: v.string(),
    link: v.string(),
    startedAt: v.number(),
    /** The subscription this sign-in repairs in place; absent for a new one. */
    repair: v.optional(v.id("subscriptions")),
    /** The one account of `repair` this sign-in must sign in again (an account's own "Sign in"). */
    repairAccount: v.optional(v.id("accounts")),
    /** The subscription this sign-in adds a second provider account to (TKM-265). */
    addTo: v.optional(v.id("subscriptions")),
    /** Set while one call finishes it, so a second paste cannot race the first. */
    finishingUntil: v.optional(v.number()),
  }).index("by_owner", ["owner"]),
});
