import { For, Show, createEffect, createSignal } from "solid-js";
import { Portal, type JSX } from "@solidjs/web";
import { Button, icons } from "@tokamak/ui";
import type { Subscription } from "../lib/api";
import type { Builder, Profile } from "../lib/builder";
import { titleOf } from "../lib/format";
import { CompanyMark } from "./company-mark";
import { ProfileBox } from "./profile-box";
import { ProfileDialog } from "./profile-dialog";

/**
 * The Profiles section under the subscriptions (Paper "1 · Profiles ·
 * screen"): "New profile", and a box per profile that cards are dragged
 * into. A thread will use the first enabled subscription of its profile
 * (TKM-266). Changes are told to screen readers in a polite live region.
 */
export function ProfilesSection(props: {
  builder: Builder;
  subscriptions: readonly Subscription[];
}): JSX.Element {
  const builder = () => props.builder;
  const [creating, setCreating] = createSignal(false);
  const byId = () => new Map(props.subscriptions.map((subscription) => [subscription.id, subscription]));
  const carried = () => {
    const carry = builder().drag.carry();
    return carry && byId().get(carry.subscription);
  };

  return (
    <section aria-label="Profiles" class="mx-auto flex w-full max-w-profiles flex-col gap-3 pt-10">
      <header class="flex h-8 items-center justify-between">
        <div class="flex items-center gap-2">
          <h2 class="m-0 flex items-center gap-2">
            <span class="text-row font-medium text-ink">Profiles</span>
            <span class="text-data text-ink-3">{builder().profiles().length}</span>
          </h2>
          <p class="m-0 ps-2 text-label text-ink-3">
            Drag subscriptions into a profile. Top one is used first.
          </p>
        </div>
        <Button variant="ghost" icon={icons.add} onClick={() => setCreating(true)}>
          New profile
        </Button>
      </header>
      <Show when={builder().problem() ?? builder().error()}>
        {(message) => (
          <p role="alert" class="m-0 text-label text-removed">
            {message()}
          </p>
        )}
      </Show>
      <div class="grid grid-cols-3 items-start gap-3">
        {/* Keyed by id: every change brings a fresh list, and a box must stay the same element. */}
        <For each={builder().profiles()} keyed={(profile: Profile) => profile.id}>
          {(profile) => <ProfileBox profile={profile()} builder={builder()} subscriptions={byId()} />}
        </For>
      </div>
      <Show when={builder().profiles().length === 0 && !builder().error()}>
        <p class="m-0 text-row text-ink-3">No profiles yet. Make one, then drag subscriptions into it.</p>
      </Show>
      <p aria-live="polite" class="sr-only">
        {builder().said()}
      </p>
      <Show when={carried()}>
        {(subscription) => <Ghost subscription={subscription()} builder={builder()} />}
      </Show>
      <ProfileDialog open={creating()} onClose={() => setCreating(false)} create={builder().create} />
    </section>
  );
}

/** The card under the pointer while it is dragged (Paper "4b"): logo, name, email, label. */
function Ghost(props: { subscription: Subscription; builder: Builder }): JSX.Element {
  let ghost: HTMLDivElement | undefined;
  // Follows the pointer from a ref: the plugin's styles allow no inline style attribute.
  createEffect(
    () => props.builder.drag.point(),
    (point) => {
      if (ghost) ghost.style.translate = `${point.x + 8}px ${point.y + 8}px`;
    },
  );
  const email = () => props.subscription.accounts.find((account) => account.email)?.email;
  return (
    <Portal>
      <div
        ref={(element: HTMLDivElement) => (ghost = element)}
        aria-hidden="true"
        class="pointer-events-none fixed top-0 left-0 z-50 flex w-max -rotate-2 items-center gap-2 rounded-md bg-band px-3 py-1 text-ink shadow-raised inset-ring inset-ring-edge"
      >
        <CompanyMark company={props.subscription.company} size={16} />
        <span class="flex flex-col">
          <span class="text-row font-medium">{titleOf(props.subscription)}</span>
          <Show when={email()}>
            <span class="text-data text-ink-3">{email()}</span>
          </Show>
        </span>
        <Show when={props.subscription.label}>
          <span class="ps-4 text-label text-ink-3">{props.subscription.label}</span>
        </Show>
      </div>
    </Portal>
  );
}
