import { createEffect } from "solid-js";
import type { SignIn, Subscription } from "./api";
import type { Step } from "../ui/add-dialog";

/** Failures after which a sign-in no longer exists on the server; the dialog offers to start again. */
export const ENDING = ["AlreadyAdded", "Gone", "Expired", "Cancelled", "NotFound"];

/** How a sign-in ended elsewhere in this window: the subscription it connected, or why it failed. */
export type Ending = { subscription: Subscription } | { message: string };

type Listed = { subscriptions: readonly Subscription[]; signIns: readonly SignIn[] };
/** A subscription's accounts by id, with the status each had. */
type Snapshot = ReadonlyMap<string, string>;

/**
 * How a sign-in that left the list ended: the subscription it connected, or
 * undefined when it was cancelled. Each kind of sign-in has its own sign that
 * it finished, since a subscription that is already "OK" says nothing:
 *
 * - a new subscription: one created after the sign-in started;
 * - another account (`addTo`): an account that was not there when it started;
 * - one account (`repairAccount`): that account turning "OK";
 * - a subscription (`repair`): an account that was signed out turning "OK".
 */
export function endedAs(
  signIn: SignIn,
  before: Snapshot | undefined,
  data: Listed,
): Subscription | undefined {
  const target = signIn.repair ?? signIn.addTo;
  if (!target) return data.subscriptions.find((item) => item.createdAt >= signIn.startedAt);
  const subscription = data.subscriptions.find((item) => item.id === target);
  if (!subscription || !before) return undefined;
  const done = subscription.accounts.some((account) =>
    signIn.addTo
      ? !before.has(account.id)
      : account.status === "ok" &&
        (signIn.repairAccount
          ? account.id === signIn.repairAccount
          : before.get(account.id) === "signed-out"),
  );
  return done ? subscription : undefined;
}

/**
 * Lets an open dialog notice its sign-in ending in another window: finished
 * there (go on to "Connected", or close when there is nothing to label) or
 * cancelled there (close and say so). Sign-ins this window is finishing or
 * cancelling, and ones it ended, are left to the call that answers for them:
 * wrap those calls in `local`. The Profiles page and the details use one each;
 * the page's also feeds the desktop app's return watch (`sign-in-return.ts`).
 */
export function createSignInWatch(options: {
  data: () => Listed | undefined;
  step: () => Step | undefined;
  setStep: (step: Step | undefined) => void;
  onCancelled: (message: string) => void;
  /** A sign-in this window ended (finished, cancelled, or one that cannot finish). */
  onEnded?: (id: string) => void;
  /**
   * How another part of this window ended a sign-in: the page's return watch
   * finishes sign-ins the details started, and keeps each one's result.
   * Read before "cancelled in another window" is assumed, and also for a
   * sign-in that ended before this list ever showed it.
   */
  endedBy?: (id: string) => Ending | undefined;
}) {
  const busy = new Set<string>();
  const endedHere = new Set<string>();
  /** Every sign-in listed so far, with its subscription's accounts as they were then. */
  const seen = new Map<string, Snapshot | undefined>();

  async function local<T>(id: string, call: () => Promise<T>, ended: (result: T) => boolean): Promise<T> {
    busy.add(id);
    try {
      const result = await call();
      if (ended(result)) {
        endedHere.add(id);
        options.onEnded?.(id);
      }
      return result;
    } finally {
      busy.delete(id);
    }
  }

  createEffect(
    () => {
      const open = options.step();
      const id = open?.kind === "sign-in" ? open.signIn.id : undefined;
      return { data: options.data(), open, ending: id !== undefined ? options.endedBy?.(id) : undefined };
    },
    ({ data, open, ending }) => {
      if (!data) return;
      for (const signIn of data.signIns) {
        if (seen.has(signIn.id)) continue;
        const target = data.subscriptions.find((item) => item.id === (signIn.repair ?? signIn.addTo));
        seen.set(
          signIn.id,
          target && new Map(target.accounts.map((account) => [account.id, account.status])),
        );
      }
      if (open?.kind !== "sign-in") return;
      const id = open.signIn.id;
      if (busy.has(id) || endedHere.has(id)) return;
      const still = data.signIns.find((signIn) => signIn.id === id);
      if (still) {
        if (still.expired !== open.signIn.expired) options.setStep({ kind: "sign-in", signIn: still });
        return;
      }
      // Ended by another part of this window (the page's return watch): say how, even when this
      // list never showed the sign-in at all.
      if (ending) {
        endedHere.add(id);
        if ("subscription" in ending)
          options.setStep({ kind: "connected", subscription: ending.subscription });
        else {
          options.setStep(undefined);
          options.onCancelled(ending.message);
        }
        return;
      }
      if (!seen.has(id)) return;
      endedHere.add(id);
      const added = endedAs(open.signIn, seen.get(id), data);
      if (added) options.setStep({ kind: "connected", subscription: added });
      else {
        options.setStep(undefined);
        options.onCancelled("That sign-in was cancelled in another window.");
      }
    },
  );

  return {
    local,
    /** Being finished or cancelled by a call of this window right now. */
    busy: (id: string) => busy.has(id),
    /** Ended by this window, or seen to end while its dialog was open. */
    ended: (id: string) => endedHere.has(id),
  };
}
