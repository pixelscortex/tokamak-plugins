import type { Id, MutationContext } from "@tokamak/sdk";
import type { Model } from "./_functions";

/**
 * The one rule for storing what a read of the company brought, used by every
 * path that stores one: a new subscription, a repair, another account, and
 * "Check again". A read that failed never overwrites one that worked:
 *
 * - the plan is written only when the company said which plan it is; until then it
 *   is empty ("plan unknown"), never a guessed "Free";
 * - an account's models are written only when the read returned some;
 * - the subscription's models are the union of its accounts' models, in the
 *   order the accounts were added, and are recomputed whenever one account's
 *   list changes. Signing an account out does not shrink it.
 *
 * Each account keeps its own list so the proxy (TKM-263) can skip an account
 * that lacks the model a request asks for.
 */

export type ModelEntry = { id: string; name: string };

export interface Read {
  readonly plan: string;
  /** False when the plan read failed or carried no plan; `plan` is then not to be stored. */
  readonly planKnown?: boolean;
  readonly models: readonly ModelEntry[];
}

/** The plan to store, or undefined when the read does not know it. */
export const knownPlan = (read: Read): string | undefined =>
  read.planKnown === false ? undefined : read.plan;

/** Whether an account on `plan` may join a subscription on `subscriptionPlan`: unknown on either side fits. */
export const plansFit = (subscriptionPlan: string, read: Read): boolean => {
  const plan = knownPlan(read);
  return plan === undefined || subscriptionPlan === "" || plan === subscriptionPlan;
};

/** Stores one account's read and recomputes its subscription's models and, when known, its plan. */
export async function storeRead(
  ctx: MutationContext<Model>,
  account: Id<"accounts">,
  read: Read,
): Promise<void> {
  const row = await ctx.db.get(account);
  if (!row) return;
  if (read.models.length) await ctx.db.patch(account, { models: [...read.models] });
  const plan = knownPlan(read);
  const accounts = await ctx.db
    .query("accounts")
    .withIndex("by_subscription", (q) => q.eq("subscription", row.subscription))
    .collect();
  const union = new Map<string, ModelEntry>();
  for (const each of accounts.sort((a, b) => a._creationTime - b._creationTime))
    for (const model of each.models ?? []) if (!union.has(model.id)) union.set(model.id, model);
  await ctx.db.patch(row.subscription, {
    ...(plan !== undefined && { plan }),
    // A subscription whose accounts have no list yet (added before lists were kept) keeps its own.
    ...(union.size > 0 && { models: [...union.values()] }),
  });
}
