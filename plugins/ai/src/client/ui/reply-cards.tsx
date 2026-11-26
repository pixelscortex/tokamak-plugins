import { For, Show, type Accessor } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useClient } from "@tokamak/sdk/client";
import { Icon, icons } from "@tokamak/ui";
import type { MessageProps } from "plugin:chat/client";
import type { Task } from "../../contracts";
import { fileIcon, pendingIcon, tasksIcon } from "../lib/icons";
import { usageLine, useTurn, type Turn } from "../lib/replies";
import { Spinning } from "./spinning";

/**
 * Under the reply's text: the agent's to-do list as "Tasks", its plan as a
 * card, and the turn's usage, small, at the end. Cards follow Paper "Thread
 * ideas", "Widget · plan" (the count alone heads the to-do list); the 16 px space between text and card is
 * the article's 8 plus this block's 8.
 */
export function ReplyCards(props: MessageProps): JSX.Element {
  const turn = useTurn(useClient(), props);
  return (
    <Show when={turn()}>
      {(t) => (
        <div class="flex flex-col gap-4 pt-2 empty:hidden">
          <Show when={t().tasks?.length}>
            <TasksCard tasks={t().tasks!} />
          </Show>
          <Show when={t().plan}>{(plan) => <PlanCard text={plan()} />}</Show>
          <Usage turn={t} />
        </div>
      )}
    </Show>
  );
}

/** A card on the tray: a header row, then its rows. */
const card = "flex max-w-read flex-col rounded-md bg-hover pt-1 pb-2";
const cardRow = "flex h-8 items-center gap-2 px-3";

function TasksCard(props: { tasks: readonly Task[] }): JSX.Element {
  const done = () => props.tasks.filter((task) => task.state === "done").length;
  return (
    <section aria-label="Tasks" class={card}>
      <div class={cardRow}>
        <span class="flex w-4 shrink-0 justify-center text-ink">
          <Icon path={tasksIcon} />
        </span>
        <span class="text-data text-ink-2">
          {done()} / {props.tasks.length}
        </span>
      </div>
      <ul class="flex flex-col">
        <For each={props.tasks}>{(task) => <TaskRow task={task} />}</For>
      </ul>
    </section>
  );
}

function TaskRow(props: { task: Task }): JSX.Element {
  const task = () => props.task;
  return (
    <li class={cardRow} data-state={task().state}>
      <span class="flex w-4 shrink-0 justify-center text-ink-3">
        <Show
          when={task().state === "running"}
          fallback={<Icon path={task().state === "done" ? icons.done : pendingIcon} />}
        >
          <Spinning />
        </Show>
      </span>
      <span
        class={
          task().state === "running"
            ? "min-w-0 flex-1 truncate text-row font-medium text-ink"
            : "min-w-0 flex-1 truncate text-row text-ink-3"
        }
      >
        {task().text}
      </span>
    </li>
  );
}

function PlanCard(props: { text: string }): JSX.Element {
  return (
    <section aria-label="Plan" class={card}>
      <div class={cardRow}>
        <span class="flex w-4 shrink-0 justify-center text-ink">
          <Icon path={fileIcon} />
        </span>
        <span class="text-label text-ink-2">Plan</span>
      </div>
      <p class="px-3 text-row break-words whitespace-pre-wrap text-ink-2">{props.text}</p>
    </section>
  );
}

/** "12.4k in · 1.1k out · $0.04", once the agent has reported some tokens. */
function Usage(props: { turn: Accessor<Turn> }): JSX.Element {
  const line = () => {
    const usage = props.turn().usage;
    return usage && usageLine(usage);
  };
  return (
    <Show when={line()}>
      {(text) => (
        <p aria-label="Usage" class="text-data text-ink-3">
          {text()}
        </p>
      )}
    </Show>
  );
}
