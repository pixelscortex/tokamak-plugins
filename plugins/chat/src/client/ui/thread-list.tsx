import { ListboxItem } from "@ui-sdk/solid/listbox";
import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Id } from "@tokamak/sdk";
import { Icon, Kbd, Row, RowList, cn, rowVariants } from "@tokamak/ui";
import type { Thread } from "../lib/api";
import { glyphs } from "../lib/icons";
import { age, useNow } from "../lib/time";

export interface ThreadRowProps {
  readonly thread: Thread;
  readonly now: number;
}

const slots = rowVariants({ kind: "single", lead: true });

/**
 * One thread in the list (Paper "Threads · C"): an empty `status` lane before
 * the `title`, the `age` on the right, and an empty `detail` line under the
 * title. Other plugins fill the lane (running, waiting, done, failed) and the
 * line (agent, model, folder). A filled detail line makes the row a double row.
 *
 * The row is drawn here rather than with RowList.Option so the detail line
 * can stay in the row's box and take no room while empty.
 */
export const ThreadRow = (props: ThreadRowProps) => (
  <ListboxItem value={props.thread._id} class="group/row flex cursor-pointer flex-col rounded-sm focus-ring">
    <span
      data-slot="row-box"
      class="flex min-w-0 min-h-8 flex-col justify-center rounded-sm px-row py-1 text-start text-row text-ink-2 group-hover/row:bg-hover group-data-selected/row:bg-selected group-data-selected/row:text-ink"
    >
      <span class={slots.line()}>
        <span data-part="status" class={slots.lead()} />
        <span data-part="title" class={slots.title()}>
          {props.thread.title}
        </span>
        <span data-part="age" class={slots.trail()}>
          {age(props.thread.updatedAt, props.now)}
        </span>
      </span>
      <span data-part="detail" class={cn(slots.detail(), "pb-1 empty:hidden")} />
    </span>
  </ListboxItem>
);

/** "New thread ⌘N", then one list of threads with no groups, newest first. */
export function ThreadList(props: {
  threads: readonly Thread[] | undefined;
  current: Id<"threads"> | undefined;
  onOpen: (id: Id<"threads">) => void;
  onNew: () => void;
}): JSX.Element {
  const now = useNow();
  return (
    <nav aria-label="Chat threads" class="flex flex-col gap-4">
      <Row
        as="button"
        lead={<Icon path={glyphs.add} />}
        trail={<Kbd keys="mod+n" />}
        selected={props.current === undefined}
        onClick={() => props.onNew()}
      >
        New thread
      </Row>
      <Show when={props.threads?.length}>
        <RowList.Root
          aria-label="Threads"
          value={props.current ?? null}
          onValueChange={(value: unknown) => value && props.onOpen(value as Id<"threads">)}
        >
          <RowList.Group>
            <For each={props.threads ?? []} keyed={(thread) => thread._id}>
              {(thread) => <ThreadRow thread={thread()} now={now()} />}
            </For>
          </RowList.Group>
        </RowList.Root>
      </Show>
    </nav>
  );
}
