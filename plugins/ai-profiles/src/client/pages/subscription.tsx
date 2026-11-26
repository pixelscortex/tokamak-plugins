import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure } from "@tokamak/sdk";
import { Region, useClient, useQuery } from "@tokamak/sdk/client";
import { Avatar, Button, Chip, Icon, Input, icons } from "@tokamak/ui";
import { api, type SignIn, type Subscription } from "../lib/api";
import { modelName, titleOf } from "../lib/format";
import { manageGlyphs, openSubscription } from "../lib/manage";
import { ENDING, createSignInWatch, type Ending } from "../lib/sign-in-watch";
import { AddDialog, type Step } from "../ui/add-dialog";
import { CompanyMark, markPath } from "../ui/company-mark";

type Account = Subscription["accounts"][number];
type Listed = { subscriptions: readonly Subscription[]; signIns: readonly SignIn[] };

/**
 * The subscription details (Paper "3 · Subscription · details"), in place of
 * the Subscriptions section while one is open: its accounts with the status
 * of each, "Add account", the label, the models found and the profiles that
 * use it. "Profiles" in the page header goes back.
 *
 * "Add account" and an account's "Sign in" run the same sign-in as adding a
 * subscription, in the same dialog at its sign-in step; it closes when the
 * account is in, since there is nothing to label.
 */
/**
 * The Profiles page's view of the desktop app's return listener: whether it
 * listens for a sign-in, the address it caught, and a way to tell it about a
 * sign-in started here before the list shows it.
 */
export interface Returns {
  listening: (id: string) => boolean;
  returned: (id: string) => { address: string; problem?: string } | undefined;
  started: (signIn: SignIn) => void;
  /** How the page's return watch ended a sign-in: the subscription, or why it failed. */
  ended: (id: string) => Ending | undefined;
}

export function SubscriptionDetails(props: { data: Listed | undefined; returns: Returns }): JSX.Element {
  const subscription = () => props.data?.subscriptions.find((item) => item.id === openSubscription());
  // Removed here or in another window while open: back to the cards.
  createEffect(
    () => (props.data && openSubscription() !== undefined ? subscription() : true),
    (found) => {
      if (!found) openSubscription.set(undefined);
    },
  );
  return (
    <Show when={subscription()}>
      {(item) => <Details subscription={item()} data={() => props.data} returns={props.returns} />}
    </Show>
  );
}

/** A section's top line: name and count on the left, an action or a note on the right. */
function SectionHeader(props: { title: string; count?: number; children?: JSX.Element }): JSX.Element {
  return (
    <div class="flex h-6 items-center justify-between border-b border-edge pb-2 box-content">
      <h3 class="m-0 text-label text-ink-3">
        {props.title}
        <Show when={props.count !== undefined}>
          {" "}
          <span class="text-data">{props.count}</span>
        </Show>
      </h3>
      {props.children}
    </div>
  );
}

function Details(props: {
  subscription: Subscription;
  data: () => Listed | undefined;
  returns: Returns;
}): JSX.Element {
  const client = useClient();
  const [step, setStep] = createSignal<Step>();
  const [problem, setProblem] = createSignal<string>();
  const title = () => titleOf(props.subscription);
  const id = () => props.subscription.id;
  // Nothing to label after another account or a repair: the dialog closes when it is in.
  const show = (next: Step | undefined) => setStep(next?.kind === "connected" ? undefined : next);
  const { local } = createSignInWatch({
    data: props.data,
    step,
    setStep: show,
    onCancelled: setProblem,
    endedBy: (id) => props.returns.ended(id),
  });

  /** "Add account" without an account; an account's own "Sign in" signs that one account in again. */
  const start = async (account?: string) => {
    const started = await (account === undefined
      ? client.action(api.manage.addAccount, { id: id() })
      : client.action(api.manage.signInAccount, { id: account }));
    // The page's return listener takes it at once, before the list shows it.
    if (!isFailure(started)) props.returns.started(started as SignIn);
    return started;
  };
  async function open(account?: string) {
    setProblem(undefined);
    try {
      const started = await start(account);
      if (isFailure(started)) setProblem(started.data.message);
      else setStep({ kind: "sign-in", signIn: started as SignIn });
    } catch {
      setProblem("The sign-in could not start. Try again.");
    }
  }
  async function signOut(account: Account) {
    setProblem(undefined);
    try {
      const result = await client.mutation(api.manage.signOut, { id: account.id });
      if (isFailure(result)) setProblem(result.data.message);
    } catch {
      setProblem("That account could not be signed out. Try again.");
    }
  }

  return (
    <>
      <Breadcrumb title={title()} />
      <section
        aria-label={`${title()} details`}
        class="mx-auto flex w-full max-w-subscription flex-col gap-8 pt-6"
      >
        <div class="flex h-8 items-center gap-3">
          <CompanyMark company={props.subscription.company} size={24} />
          <h2 class="m-0 text-read font-semibold text-ink">{title()}</h2>
          <Show when={props.subscription.label}>
            <span class="text-row text-ink-3">{props.subscription.label}</span>
          </Show>
        </div>
        <Show when={problem()}>
          <p role="alert" class="m-0 text-label text-removed">
            {problem()}
          </p>
        </Show>
        <div class="flex gap-12">
          <section aria-label="Accounts" class="flex w-accounts shrink-0 flex-col">
            <SectionHeader title="Accounts" count={props.subscription.accounts.length}>
              <Button size="sm" variant="ghost" icon={icons.add} onClick={() => open()}>
                Add account
              </Button>
            </SectionHeader>
            <ul class="m-0 flex list-none flex-col p-0">
              {/* Keyed by id, as every list of records here: an answer brings fresh objects. */}
              <For
                each={props.subscription.accounts}
                keyed={(account: Subscription["accounts"][number]) => account.id}
              >
                {(account) => (
                  <AccountRow
                    account={account()}
                    onSignOut={() => signOut(account())}
                    onSignIn={() => open(account().id)}
                  />
                )}
              </For>
            </ul>
          </section>
          <div class="flex min-w-0 flex-1 flex-col gap-8">
            <Label subscription={props.subscription} />
            <Models subscription={props.subscription} />
            <UsedBy subscription={props.subscription} />
          </div>
        </div>
      </section>
      <AddDialog
        step={step()}
        onStep={show}
        // "Start again" restarts the same kind of sign-in.
        start={() => {
          const open = step();
          return start(open?.kind === "sign-in" ? open.signIn.repairAccount : undefined);
        }}
        finish={(signIn, pasted) =>
          local(
            signIn.id,
            () => client.action(api.subscriptions.finishSignIn, { id: signIn.id, pasted }),
            (result) => !isFailure(result) || ENDING.includes(result.kind),
          )
        }
        listening={props.returns.listening}
        returned={props.returns.returned}
        setLabel={(subscription, label) =>
          client.mutation(api.subscriptions.setLabel, { id: subscription.id, label })
        }
      />
    </>
  );
}

/** One provider account: who it is, whether it is signed in, and the one thing to do about it. */
function AccountRow(props: {
  account: Account;
  onSignOut: () => Promise<unknown>;
  onSignIn: () => Promise<unknown>;
}): JSX.Element {
  const email = () => props.account.email ?? "Account";
  const out = () => props.account.status === "signed-out";
  // Each button is named with its account ("Sign out you@acme.com"): Button's own
  // `aria-label` is its icon label, so the name is built from the two texts by id.
  const key = () => props.account.id.replace(/[^\w-]/g, "-");
  return (
    <li class="flex items-center gap-3 border-b border-edge py-3">
      <Avatar name={email()} />
      <div class="flex min-w-0 flex-1 flex-col">
        <span id={`email-${key()}`} class="truncate text-row font-medium text-ink">
          {email()}
        </span>
        <Show when={out()} fallback={<span class="text-label text-ink-3">OK</span>}>
          <span class="truncate text-label text-ink-3" title={props.account.reason}>
            <span class="text-warn">Signed out</span>
            <Show when={props.account.reason}> · {props.account.reason}</Show>
          </span>
        </Show>
      </div>
      {/* Each Button stays pending until its promise settles, so a second press does nothing. */}
      <Show
        when={out()}
        fallback={
          <Button
            size="sm"
            variant="ghost"
            id={`out-${key()}`}
            aria-labelledby={`out-${key()} email-${key()}`}
            onClick={() => props.onSignOut()}
          >
            Sign out
          </Button>
        }
      >
        <Button
          size="sm"
          variant="ghost"
          id={`in-${key()}`}
          aria-labelledby={`in-${key()} email-${key()}`}
          onClick={() => props.onSignIn()}
        >
          Sign in
        </Button>
      </Show>
    </li>
  );
}

/** The person's own name for the subscription; saved on Enter or when the field is left. */
function Label(props: { subscription: Subscription }): JSX.Element {
  const client = useClient();
  // Follows the label when it changes elsewhere; typing overrides it until then.
  const [text, setText] = createSignal(() => props.subscription.label);
  const [problem, setProblem] = createSignal<string>();
  async function save() {
    if (text().trim() === props.subscription.label) return;
    setProblem(undefined);
    const saved = await client.mutation(api.subscriptions.setLabel, {
      id: props.subscription.id,
      label: text(),
    });
    if (isFailure(saved)) setProblem(saved.data.message);
  }
  return (
    <section aria-label="Label" class="flex flex-col gap-3">
      <SectionHeader title="Label" />
      <form
        class="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          aria-label="Label"
          aria-describedby="label-problem"
          placeholder="Personal"
          value={text()}
          invalid={Boolean(problem())}
          onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
            setText(event.currentTarget.value)
          }
          onBlur={() => void save()}
        />
        <Show when={problem()}>
          <p id="label-problem" role="alert" class="m-0 text-label text-removed">
            {problem()}
          </p>
        </Show>
      </form>
    </section>
  );
}

/** The page header while details are open: "Profiles / Claude Team"; "Profiles" goes back. */
function Breadcrumb(props: { title: string }): JSX.Element {
  return (
    <Region.Header>
      <nav aria-label="Breadcrumb" class="flex min-w-0 items-center gap-1">
        <Button variant="bare" onClick={() => openSubscription.set(undefined)}>
          Profiles
        </Button>
        <span class="text-row text-ink-3" aria-hidden="true">
          /
        </span>
        <h1 class="m-0 truncate ps-2 text-row font-medium text-ink">{props.title}</h1>
      </nav>
    </Region.Header>
  );
}

/** The models the accounts may use, as Claude names them. */
function Models(props: { subscription: Subscription }): JSX.Element {
  return (
    <section aria-label="Models" class="flex flex-col gap-3">
      <SectionHeader title="Models" count={props.subscription.models.length}>
        <span class="text-label text-ink-3">found automatically</span>
      </SectionHeader>
      <ul class="m-0 flex list-none flex-wrap gap-2 p-0">
        <For each={props.subscription.models} keyed={(model: { id: string }) => model.id}>
          {(model) => (
            <li>
              <Chip size="sm" icon={markPath(props.subscription.company)}>
                {modelName(model().name)}
              </Chip>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/** The profiles that hold the subscription (TKM-264, through `manage:usedBy`). */
function UsedBy(props: { subscription: Subscription }): JSX.Element {
  const client = useClient();
  // Every answer of the list brings a fresh subscription object: the query follows its id only,
  // or each answer would subscribe again and redraw the rows.
  const id = createMemo(() => props.subscription.id);
  const uses = useQuery(client, api.manage.usedBy, () => ({ id: id() }));
  return (
    <section aria-label="Used by" class="flex flex-col gap-3">
      <SectionHeader title="Used by" />
      <Show
        when={uses.data()?.length}
        fallback={
          <Show when={uses.data()}>
            <p class="m-0 text-row text-ink-3">No profile uses it yet.</p>
          </Show>
        }
      >
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <For each={uses.data()} keyed={(use: { id: string }) => use.id}>
            {(use) => (
              <li class="flex h-6 items-center gap-2">
                <span class="flex items-center gap-1 text-ink-3">
                  <Icon path={manageGlyphs.profile} size={12} />
                  <span class="text-data">{use().code}</span>
                </span>
                <span class="flex-1 truncate text-row font-medium text-ink">{use().name}</span>
                <span class="text-data text-ink-3">
                  {use().threads} {use().threads === 1 ? "thread" : "threads"}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
