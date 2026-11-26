import { Show, createEffect } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Region, useClient } from "@tokamak/sdk/client";
import { Button, Chip } from "@tokamak/ui";
import type { HeaderProps } from "plugin:chat/client";
import { branchOf, followBranch, openReview, review } from "../lib/changes";
import { rememberClient } from "../lib/runner";
import { branchIcon, singleLayoutIcon, splitLayoutIcon } from "../lib/icons";
import { ReviewPanel } from "./review-panel";

/** The thread's branch after the title (Paper "Branch chip"), kept current while the thread is open. */
export function BranchChip(props: HeaderProps): JSX.Element {
  const client = useClient();
  rememberClient(client);
  createEffect(
    () => props.thread._id,
    (threadId) => followBranch(client, threadId),
  );
  return (
    <Show when={branchOf(props.thread._id)}>
      {(branch) => (
        // The chip keeps the whole name; the title beside it truncates instead.
        <Chip mono icon={branchIcon} label={`Branch ${branch()}`} class="ms-2 shrink-0">
          {branch()}
        </Chip>
      )}
    </Show>
  );
}

/**
 * The layout control before the thread menu (Paper "Layout control"): the
 * thread alone, or beside the review panel. Only in a Git folder. The
 * pressed button takes the lifted fill from the group, so Button's
 * own look stays untouched.
 */
export function ReviewToggle(props: HeaderProps): JSX.Element {
  const open = () => review()?.threadId === props.thread._id;
  return (
    <Show when={branchOf(props.thread._id)}>
      <div
        role="group"
        aria-label="Layout"
        class="flex rounded-sm surface-tray *:aria-pressed:bg-lifted *:aria-pressed:text-ink"
      >
        <Button
          variant="ghost"
          icon={singleLayoutIcon}
          label="Thread only"
          aria-pressed={open() ? "false" : "true"}
          onClick={() => review.set(undefined)}
        />
        <Button
          variant="ghost"
          icon={splitLayoutIcon}
          label="Review panel"
          aria-pressed={open() ? "true" : "false"}
          onClick={() => openReview(props.thread._id)}
        />
      </div>
    </Show>
  );
}

/**
 * The review panel in the shell's panel region while it is open on this
 * header's thread. Mounted with the header, so it closes with the thread.
 */
export function ReviewPanelMount(props: HeaderProps): JSX.Element {
  return (
    <Show when={branchOf(props.thread._id) && review()?.threadId === props.thread._id}>
      <Region.Panel>
        <ReviewPanel threadId={props.thread._id} turnId={review()?.turnId} />
      </Region.Panel>
    </Show>
  );
}
