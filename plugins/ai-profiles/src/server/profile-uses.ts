import type { MutationContext, QueryContext } from "@tokamak/sdk";
import { internal } from "./_generated/internal";

/**
 * The one place this plugin's subscription screens learn about profiles. The
 * subscription details ("Used by") and the remove confirmation ("taken out of
 * …") read `profilesUsing`, and removing a subscription calls
 * `subscriptionRemoved` in the same transaction. Both go to `profiles.ts`,
 * which owns the profiles table and its one spelling of subscription ids
 * (`subscriptionKey`).
 *
 * `agent-proxy` never learns the word "profile": it removes the subscription,
 * and this plugin updates its own profiles.
 */

/** One profile that holds a subscription, as the details and the remove dialog show it. */
export interface ProfileUse {
  readonly id: string;
  /** The 4-character code, such as "ACME". */
  readonly code: string;
  readonly name: string;
  /** How many threads use the profile: counted from saved thread picks. */
  readonly threads: number;
}

type Reader = Pick<QueryContext<never>, "runQuery">;
type Writer = Pick<MutationContext<never>, "runMutation">;

/**
 * The caller's profiles that hold `subscription` (an agent-proxy subscription
 * id). Only the calling member's: `profiles:using` reads by `ctx.auth`.
 */
export async function profilesUsing(ctx: Reader, subscription: string): Promise<ProfileUse[]> {
  return ctx.runQuery(internal.profiles.using, { subscription });
}

/**
 * Takes a removed subscription out of the caller's profiles, inside
 * `manage:remove`'s transaction. `profiles:forgetSubscription` throws when it
 * cannot finish, and the throw rolls back the removal in agent-proxy as well.
 */
export async function subscriptionRemoved(ctx: Writer, subscription: string): Promise<void> {
  await ctx.runMutation(internal.profiles.forgetSubscription, { subscription });
}
