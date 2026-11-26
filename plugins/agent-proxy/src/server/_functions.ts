import {
  createFunctions,
  fail,
  type AuthContext,
  type Doc,
  type Id,
  type ModelFromSchema,
} from "@tokamak/sdk";
import type { Company } from "./addresses";
import schema from "./schema";

export const { query, mutation, action, internalQuery, internalMutation, internalAction } =
  createFunctions(schema);
export type Model = ModelFromSchema<typeof schema>;

/**
 * The member a row belongs to. Every function reads and writes only the
 * caller's rows; nested calls keep the caller, so another plugin calling in
 * on someone's behalf sees that person's subscriptions and nobody else's.
 */
export const ownerOf = (auth: AuthContext) => auth.user.id;

/** Renew a login this long before it runs out, so a turn never starts on a dying one. */
export const RENEW_BEFORE_MS = 5 * 60_000;

/**
 * A sign-in nobody finished within this time is over: its link and verifier
 * are no longer used, and it is deleted by the next call that changes sign-ins.
 * (Kept as one plain number so the sign-in test can build a copy with a short one.)
 */
export const SIGN_IN_TTL_MS = 900000;

export const isExpired = (signIn: { startedAt: number }, now: number) =>
  now - signIn.startedAt >= SIGN_IN_TTL_MS;

type Table = "subscriptions" | "accounts" | "signIns" | "sets";

/**
 * `value` as an id of `table`, or null. The window and other plugins pass ids
 * as strings, and `db.get` accepts an id of any of this plugin's tables, so
 * every function that takes an id checks its table before reading it: a
 * subscription id must never cancel a sign-in, nor a sign-in id get a label.
 */
export function idIn<T extends Table>(table: T, value: string): Id<T> | null {
  if (!new RegExp(`^(?:agent-proxy/)?${table}:[A-Za-z0-9_-]+$`).test(value)) return null;
  // Either spelling is accepted; rows carry the plugin-qualified one, and `db.get` checks the id it
  // answers for against the one asked, so the short spelling is qualified here.
  return (value.startsWith("agent-proxy/") ? value : `agent-proxy/${value}`) as Id<T>;
}

/** The plain answer for an id that is malformed, of another table, gone, or another member's. */
export const notFound = (what: "subscription" | "account" | "sign-in" | "set") =>
  fail("NotFound", { message: `That ${what} is gone.` });

/** What the window and other plugins may learn of a subscription: never the login. */
export interface SubscriptionView {
  readonly id: string;
  readonly company: Company;
  readonly method: "subscription";
  readonly label: string;
  /** Empty while the plan is unknown: no read of it has succeeded yet. */
  readonly plan: string;
  readonly enabled: boolean;
  /**
   * OK while at least one of its accounts is signed in: the proxy can still use
   * it. Signed out only when every account is (or it has none); the card then
   * offers "Sign in". A mix shows on each account's own `status`.
   */
  readonly status: "ok" | "signed-out";
  /** Why the subscription is signed out: the first signed-out account's reason. */
  readonly reason?: string;
  /** Oldest first. `id` is the account row's, for signing that one account out. */
  readonly accounts: readonly {
    id: string;
    email?: string;
    organization?: string;
    status: "ok" | "signed-out";
    reason?: string;
  }[];
  readonly models: readonly { id: string; name: string }[];
  readonly lastUsedAt?: number;
  readonly createdAt: number;
}

/** A sign-in that has not ended, as the "Awaiting sign-in" card and the dialog show it. */
export interface SignInView {
  readonly id: string;
  readonly company: Company;
  readonly method: "subscription";
  /** The company's page; holds the challenge and `state`, never the verifier. */
  readonly link: string;
  readonly startedAt: number;
  /** The subscription it repairs in place. */
  readonly repair?: string;
  /** The account of `repair` it signs in again, when one was named. */
  readonly repairAccount?: string;
  /** The subscription it adds another provider account to. */
  readonly addTo?: string;
  /** Older than 15 minutes: it can no longer finish; the person starts again. */
  readonly expired: boolean;
}

export function signInViewOf(row: Doc<Model, "signIns">, now: number): SignInView {
  return {
    id: row._id,
    company: row.company,
    method: row.method,
    link: row.link,
    startedAt: row.startedAt,
    ...(row.repair !== undefined && { repair: row.repair }),
    ...(row.repairAccount !== undefined && { repairAccount: row.repairAccount }),
    ...(row.addTo !== undefined && { addTo: row.addTo }),
    expired: isExpired(row, now),
  };
}

export function viewOf(
  subscription: Doc<Model, "subscriptions">,
  accounts: readonly Doc<Model, "accounts">[],
): SubscriptionView {
  const signedIn = accounts.some((account) => account.status === "ok");
  const out = signedIn ? undefined : accounts.find((account) => account.status === "signed-out");
  return {
    id: subscription._id,
    company: subscription.company,
    method: subscription.method,
    label: subscription.label,
    plan: subscription.plan,
    enabled: subscription.enabled,
    status: signedIn ? "ok" : "signed-out",
    ...(out?.reason !== undefined && { reason: out.reason }),
    accounts: [...accounts]
      .sort((a, b) => a._creationTime - b._creationTime)
      .map(({ _id, email, organization, status, reason }) => ({
        id: _id,
        ...(email !== undefined && { email }),
        ...(organization !== undefined && { organization }),
        status,
        ...(status === "signed-out" && reason !== undefined && { reason }),
      })),
    models: subscription.models,
    ...(subscription.lastUsedAt !== undefined && { lastUsedAt: subscription.lastUsedAt }),
    createdAt: subscription.createdAt,
  };
}
