import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { isFailure } from "@tokamak/sdk";
import { useClient, useQuery, view } from "@tokamak/sdk/client";
import { Button, icons } from "@tokamak/ui";
import { api, type SignIn, type Subscription } from "../lib/api";
import { profilesIcon } from "../lib/icons";
import { watchSignInReturns } from "../lib/sign-in-return";
import { AddDialog, type Step } from "../ui/add-dialog";
import { loadMarks } from "../ui/company-mark";
import { AwaitingCard, SubscriptionCard } from "../ui/subscription-card";
import { openSubscription } from "../lib/manage";
import { ENDING, createSignInWatch, type Ending } from "../lib/sign-in-watch";
import { CardActions } from "../ui/card-actions";
import { RemoveDialog } from "../ui/remove-dialog";
import { SubscriptionDetails } from "./subscription";
import { createBuilder } from "../lib/builder";
import { AddToProfile, CardProfiles } from "../ui/card-profiles";
import { ProfilesSection } from "../ui/profiles-section";

/**
 * How often the open screen asks the server to renew logins that run out
 * soon. Server code has no timer that may use the network, so renewal runs on
 * demand: here, and (TKM-263) before the proxy uses a login. The server keeps
 * its own wait after a failed renewal, so asking this often costs nothing.
 */
export const RENEW_EVERY_MS = 60_000;

type Target = Pick<SignIn, "company" | "repair" | "addTo" | "repairAccount">;

/**
 * The Profiles screen (Paper "1 · Profiles · screen"). This ticket draws its
 * Subscriptions section; the Profiles section under it comes with TKM-264.
 */
export const Profiles = view({ route: "/", title: "Profiles", icon: profilesIcon }, () => {
  const client = useClient();
  const listed = useQuery(client, api.subscriptions.list, () => ({}));
  const [step, setStep] = createSignal<Step>();
  const [now, setNow] = createSignal(Date.now());
  const [problem, setProblem] = createSignal<string>();
  loadMarks(client);

  const renew = () => void client.action(api.subscriptions.renew, {}).catch(() => {});
  renew();
  const timer = setInterval(() => {
    setNow(Date.now());
    renew();
  }, RENEW_EVERY_MS);
  onCleanup(() => clearInterval(timer));

  /** A sign-in started here that the list may not show yet: the return watch takes it at once. */
  const [startedHere, setStartedHere] = createSignal<SignIn>();
  /**
   * A sign-in of the same kind as `like`, with its company: a new
   * subscription, a repair, one account, or another account.
   */
  const start = async (like: Target) => {
    const result = await (like.addTo !== undefined
      ? client.action(api.manage.addAccount, { id: like.addTo })
      : like.repairAccount !== undefined
        ? client.action(api.manage.signInAccount, { id: like.repairAccount })
        : client.action(api.subscriptions.startSignIn, {
            company: like.company,
            method: "subscription",
            ...(like.repair !== undefined && { repair: like.repair }),
          }));
    if (!isFailure(result)) setStartedHere(result as SignIn);
    return result;
  };
  /** "Sign in" on a signed-out card, and "Start again" on an expired one. */
  async function startAndOpen(like: Target) {
    setProblem(undefined);
    try {
      const started = await start(like);
      if (isFailure(started)) setProblem(started.data.message);
      else setStep({ kind: "sign-in", signIn: started });
    } catch {
      setProblem("The sign-in could not start. Try again.");
    }
  }

  // Bumped when this window ends a sign-in, so the return watch lets go of it.
  const [completion, setCompletion] = createSignal(0);
  /** Addresses the desktop app caught for each waiting sign-in, and why one could not finish. */
  const [returned, setReturned] = createSignal<ReadonlyMap<string, { address: string; problem?: string }>>(
    new Map(),
  );
  /** How the return watch below ended each sign-in, for whichever dialog waits on it. */
  const [endings, setEndings] = createSignal<ReadonlyMap<string, Ending>>(new Map());
  const record = (id: string, ending: Ending) => setEndings((all) => new Map(all).set(id, ending));
  const watch = createSignInWatch({
    data: () => listed.data(),
    step,
    setStep,
    onCancelled: setProblem,
    endedBy: (id) => endings().get(id),
    onEnded: (id) => {
      setCompletion((n) => n + 1);
      discardReturn(id);
    },
  });
  const { local } = watch;

  const subscriptions = () => listed.data()?.subscriptions ?? [];
  const signIns = () => listed.data()?.signIns ?? [];
  const builder = createBuilder(client, subscriptions);

  function discardReturn(id: string) {
    if (!returned().has(id)) return;
    setReturned((entries) => {
      const next = new Map(entries);
      next.delete(id);
      return next;
    });
  }
  // A listed sign-in is the list's from now on; a caught return of one that stopped waiting is dropped.
  const listedOnce = new Set<string>();
  createEffect(
    () => listed.data(),
    (data) =>
      untrack(() => {
        if (!data) return;
        for (const signIn of data.signIns) listedOnce.add(signIn.id);
        const fresh = startedHere();
        if (fresh && listedOnce.has(fresh.id)) setStartedHere(undefined);
        const waiting = new Set(data.signIns.filter((signIn) => !signIn.expired).map((signIn) => signIn.id));
        for (const id of returned().keys()) if (listedOnce.has(id) && !waiting.has(id)) discardReturn(id);
      }),
  );

  const finish = (signIn: SignIn, pasted: string) => {
    if (watch.busy(signIn.id))
      return Promise.resolve({
        failed: true as const,
        kind: "Busy",
        data: { message: "This sign-in is already finishing." },
      });
    return local(
      signIn.id,
      () => client.action(api.subscriptions.finishSignIn, { id: signIn.id, pasted }),
      (result) => !isFailure(result) || ENDING.includes(result.kind),
    );
  };

  /**
   * The desktop app's listener, for every sign-in of the member that waits:
   * a new subscription, a repair, another account or one account's sign-in,
   * whichever dialog (this page's or the details') started it. A return is
   * finished here; the dialog that waits for it sees it end through its own
   * watch (`sign-in-watch.ts`).
   */
  const listening = watchSignInReturns(
    () => {
      const fresh = startedHere();
      completion();
      const waiting = signIns().filter(({ id }) => !watch.ended(id));
      return fresh && !watch.ended(fresh.id) && !waiting.some(({ id }) => id === fresh.id)
        ? [...waiting, fresh]
        : waiting;
    },
    async (signIn, address) => {
      const remember = (problem?: string) => {
        if (!watch.ended(signIn.id))
          setReturned((entries) => new Map(entries).set(signIn.id, { address, problem }));
      };
      remember();
      if (watch.busy(signIn.id)) return true;
      try {
        const added = await finish(signIn, address);
        const open = step();
        const sameDialog = open?.kind === "sign-in" && open.signIn.id === signIn.id;
        if (!isFailure(added)) {
          record(signIn.id, { subscription: added as Subscription });
          if (sameDialog) setStep({ kind: "connected", subscription: added as Subscription });
          return false;
        }
        if (ENDING.includes(added.kind)) {
          record(signIn.id, { message: added.data.message });
          if (sameDialog) {
            setStep(undefined);
            setProblem(added.data.message);
          }
          return false;
        }
        remember(added.data.message);
      } catch {
        remember("The sign-in could not finish. Try again.");
      }
      return !watch.ended(signIn.id);
    },
  );
  /** What the dialogs show of the desktop app's listener, the page's and the details'. */
  const returns = {
    listening,
    returned: (id: string) => returned().get(id),
    started: (signIn: SignIn) => setStartedHere(signIn),
    ended: (id: string) => endings().get(id),
  };
  async function cancel(signIn: SignIn) {
    await local(
      signIn.id,
      () => client.mutation(api.subscriptions.cancelSignIn, { id: signIn.id }),
      () => true,
    );
    const open = step();
    if (open?.kind === "sign-in" && open.signIn.id === signIn.id) setStep(undefined);
  }

  return (
    <div class="flex flex-col px-8 pb-12">
      <SubscriptionDetails data={listed.data()} returns={returns} />
      <section
        aria-label="Subscriptions"
        hidden={openSubscription() !== undefined}
        class="mx-auto flex w-full max-w-profiles flex-col gap-3 pt-6"
      >
        <header class="flex h-8 items-center justify-between">
          <h2 class="m-0 flex items-center gap-2">
            <span class="text-row font-medium text-ink">Subscriptions</span>
            <span class="text-data text-ink-3">{subscriptions().length}</span>
          </h2>
          <Button
            variant="ghost"
            icon={icons.add}
            onClick={() => {
              setProblem(undefined);
              setStep({ kind: "company" });
            }}
          >
            Add subscription
          </Button>
        </header>
        <Show when={problem() ?? listed.error()?.message}>
          {(message) => (
            <p role="alert" class="m-0 text-label text-removed">
              {message()}
            </p>
          )}
        </Show>
        <div class="grid grid-cols-4 gap-3">
          {/* Keyed by id: every answer of the list brings fresh objects, and a card must stay
              the same element (its hover, focus and open menu; Solid's UNSTABLE_LIST_IDENTITY). */}
          <For each={subscriptions()} keyed={(item: Subscription) => item.id}>
            {(subscription) => (
              <SubscriptionCard
                subscription={subscription()}
                now={now()}
                onEnabled={(enabled) =>
                  void client.mutation(api.subscriptions.setEnabled, { id: subscription().id, enabled })
                }
                onSignIn={() => startAndOpen({ company: subscription().company, repair: subscription().id })}
                actions={
                  <CardActions
                    subscription={subscription()}
                    addToProfile={<AddToProfile subscription={subscription()} builder={builder} />}
                  />
                }
                dimmed={builder.dimmed(subscription().id)}
                profiles={<CardProfiles subscription={subscription()} builder={builder} />}
                onPointerDown={(event) => builder.drag.start(event, { subscription: subscription().id })}
              />
            )}
          </For>
          <For each={signIns()} keyed={(item: SignIn) => item.id}>
            {(signIn) => (
              <AwaitingCard
                signIn={signIn()}
                onContinue={() => {
                  setProblem(undefined);
                  setStep({ kind: "sign-in", signIn: signIn() });
                }}
                onCancel={() => cancel(signIn())}
                onRestart={() => startAndOpen(signIn())}
                dimmed={builder.dimmed()}
              />
            )}
          </For>
        </div>
        <Show when={listed.data() && !subscriptions().length && !signIns().length}>
          <p class="m-0 text-row text-ink-3">
            No subscriptions yet. Add one to sign in to Claude or ChatGPT once for every thread.
          </p>
        </Show>
      </section>
      {/* The details take the page: the Profiles section goes with the cards while they are open. */}
      <Show when={openSubscription() === undefined}>
        <ProfilesSection builder={builder} subscriptions={subscriptions()} />
      </Show>
      <RemoveDialog subscriptions={subscriptions()} />
      <AddDialog
        step={step()}
        onStep={setStep}
        start={(company) => {
          // "Start again" restarts the same kind of sign-in; the method step starts a new one.
          const open = step();
          return start(open?.kind === "sign-in" ? open.signIn : { company });
        }}
        finish={finish}
        listening={returns.listening}
        returned={returns.returned}
        setLabel={(subscription, label) =>
          client.mutation(api.subscriptions.setLabel, { id: subscription.id, label })
        }
      />
    </div>
  );
});
