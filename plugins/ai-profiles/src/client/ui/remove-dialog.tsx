import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure } from "@tokamak/sdk";
import { useClient, useQuery } from "@tokamak/sdk/client";
import { Button, Dialog, Icon } from "@tokamak/ui";
import { api, type Subscription } from "../lib/api";
import { countOf, titleOf } from "../lib/format";
import { manageGlyphs, openSubscription, removing } from "../lib/manage";

/**
 * "Remove Claude Team?": asked once, from a card's Remove. It names the
 * profiles that lose the subscription (read through `manage:usedBy`, which
 * TKM-264's profiles answer), then removes the subscription with its accounts
 * and logins; a sign-in still waiting for it ends too. Not drawn in Paper:
 * built from the `Dialog` primitive's own layout.
 */
export function RemoveDialog(props: { subscriptions: readonly Subscription[] }): JSX.Element {
  const subscription = () => props.subscriptions.find((item) => item.id === removing());
  return (
    <Dialog.Root
      open={subscription() !== undefined}
      onOpenChange={(open: boolean) => !open && removing.set(undefined)}
    >
      <Dialog.Backdrop />
      <Dialog.Content>
        <Show when={subscription()}>{(item) => <Confirm subscription={item()} />}</Show>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function Confirm(props: { subscription: Subscription }): JSX.Element {
  const client = useClient();
  // Every answer of the list brings a fresh subscription object: the query follows its id only,
  // or each answer would subscribe again and redraw the rows.
  const id = createMemo(() => props.subscription.id);
  const uses = useQuery(client, api.manage.usedBy, () => ({ id: id() }));
  const [problem, setProblem] = createSignal<string>();
  const name = () => [titleOf(props.subscription), props.subscription.label].filter(Boolean).join(", ");
  async function remove() {
    setProblem(undefined);
    try {
      const result = await client.mutation(api.manage.remove, { id: props.subscription.id });
      if (isFailure(result)) return setProblem(result.data.message);
      if (openSubscription() === props.subscription.id) openSubscription.set(undefined);
      removing.set(undefined);
    } catch {
      setProblem("It could not be removed. Try again.");
    }
  }
  return (
    <>
      <Dialog.Title>Remove {name()}?</Dialog.Title>
      <Dialog.Description>
        Its accounts and their logins are deleted from Tokamak. To use it again, add it and sign in again.
      </Dialog.Description>
      <Show
        when={uses.data()?.length}
        fallback={
          <Show when={uses.data()}>
            <p class="m-0 text-row text-ink-3">No profile uses it.</p>
          </Show>
        }
      >
        <div class="flex flex-col gap-2">
          <p class="m-0 text-row text-ink-2">{countOf(uses.data()!.length, "profile")} will lose it:</p>
          <ul aria-label="Profiles that lose it" class="m-0 flex list-none flex-col gap-1 p-0">
            <For each={uses.data()} keyed={(use: { id: string }) => use.id}>
              {(use) => (
                <li class="flex h-6 items-center gap-2">
                  <Icon path={manageGlyphs.profile} size={12} class="text-ink-3" />
                  <span class="text-data text-ink-3">{use().code}</span>
                  <span class="text-row font-medium text-ink">{use().name}</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <Show when={problem()}>
        <p role="alert" class="m-0 text-label text-removed">
          {problem()}
        </p>
      </Show>
      <div class="flex justify-end gap-2 pt-4">
        <Dialog.Close>Cancel</Dialog.Close>
        {/* The Button stays pending until the promise settles, so it cannot remove twice. */}
        <Button variant="destructive" onClick={() => remove()}>
          Remove
        </Button>
      </div>
    </>
  );
}
