import { For, Show, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useClient, useQuery } from "@tokamak/sdk/client";
import type { ThreadRowProps } from "plugin:chat/client";
import { StatusIcon, rowVariants } from "@tokamak/ui";
import { api, modelLabel } from "../lib/agents";
import { AgentMark } from "./agent-mark";
import { followThread, iconFor, isWorking, statusOf } from "../lib/thread-status";

/**
 * The icon before a thread's title in chat's list (Paper "Threads · C"):
 * running, an amber lock while the agent waits for you, done, a red cross
 * for failed or interrupted. Nothing for a thread without turns. Live.
 */
export function ThreadStatusIcon(props: ThreadRowProps): JSX.Element {
  onCleanup(followThread(useClient(), props.thread._id));
  const icon = () => {
    const status = statusOf(props.thread._id);
    return status && iconFor(status.state);
  };
  return <Show when={icon()}>{(status) => <StatusIcon status={status()} />}</Show>;
}

/**
 * The second line of a running or waiting thread (Paper "Threads · C"): the
 * agent's mark, the model in mono and the thread's folder ("✳ Opus 5.5 ·
 * invoices-app").
 */
export function ThreadDetail(props: ThreadRowProps): JSX.Element {
  const status = () => statusOf(props.thread._id);
  return (
    <>
      <AgentMark agentId={status()?.agent.id} size={12} label={status()?.agent.name} />
      <span class="shrink-0 text-data">{modelLabel(status()?.agent.name, status()?.model)}</span>
      <span data-part="detailExtras" class="contents" />
      <span class="truncate text-label">· {folderName(props.thread)}</span>
    </>
  );
}

export const hasLiveThreadDetail = (threadId: string) => isWorking(statusOf(threadId));

/** Agent and model from the most recent turn, or the choices on a thread without turns. */
export function SavedAgentDetail(props: ThreadRowProps): JSX.Element {
  const choices = useQuery(useClient(), api.choices.get, () => ({ threadId: props.thread._id }));
  const agent = () => statusOf(props.thread._id)?.agent ?? choices.data()?.agent;
  const model = () => modelLabel(agent()?.name, statusOf(props.thread._id)?.model ?? choices.data()?.model);
  return (
    <Show when={agent()}>
      {(entry) => (
        <>
          <AgentMark agentId={entry().id} label={entry().name} size={12} />
          <span class="shrink-0 text-data">{model() ?? entry().name}</span>
        </>
      )}
    </Show>
  );
}

const half = rowVariants({ kind: "half", lead: true });

/**
 * The working turn's helper agents, one small row each under the thread
 * (Paper "Half · subagent running / done"): the agent's mark, the helper's
 * name, what it does, and its state.
 */
export function ThreadHelpers(props: ThreadRowProps): JSX.Element {
  return (
    <ul aria-label="Helpers" class="flex flex-col">
      <For each={statusOf(props.thread._id)?.helpers ?? []}>
        {(helper) => (
          <li class={half.root()}>
            <span class={half.line()}>
              <span class={half.lead()}>
                <AgentMark agentId={statusOf(props.thread._id)?.agent.id} size={12} />
              </span>
              <span class="shrink-0 text-data text-ink-2">{helper.name}</span>
              <span class={half.title()}>{helper.title}</span>
              <StatusIcon status={helper.state} size={12} />
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

function folderName(thread: ThreadRowProps["thread"]): string {
  const folder = thread.folder;
  if (folder?.kind !== "chosen") return "No folder";
  return (
    folder.path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || folder.path
  );
}
