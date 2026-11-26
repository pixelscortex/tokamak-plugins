import type { ResultOf, TokamakClient } from "@tokamak/sdk";
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { MessageProps } from "plugin:chat/client";
import { api } from "../../server/_generated/api";
import { kinds } from "./kinds";

/** One turn as `turns:replies` answers it: what its reply draws without being opened. */
export type Turn = ResultOf<typeof api.turns.replies>[number];
export type Helper = Turn["helpers"][number];
/** A tool step, as an opened actions line reads it (`turns:steps`). */
export type Step = NonNullable<ResultOf<typeof api.turns.steps>>["steps"][number];

/** A reply an agent wrote through `ai` (chat stores the agent as author `agent:<id>`). */
export function isAgentReply(props: MessageProps): boolean {
  return props.message.role === "assistant" && (props.message.author?.id.startsWith("agent:") ?? false);
}

/** One live `turns:replies` per thread, with its turns by reply id. */
interface Thread {
  users: number;
  byReply: Accessor<ReadonlyMap<string, Turn>>;
  stop: () => void;
}
const threads = new Map<string, Thread>();
/** Bumped when a thread's subscription starts or stops, so `shownTurn` notices one that appears. */
const [threadsChanged, setThreadsChanged] = createSignal(0, { ownedWrite: true });

/**
 * The turn that wrote this reply, live. Every part of every reply in a thread
 * reads one shared subscription for the whole thread, made by the first part
 * that asks and dropped when the last one unmounts, so a long thread costs one
 * subscription, not one per reply. Undefined until loaded and for a message
 * no turn wrote.
 */
export function useTurn(client: TokamakClient, props: MessageProps): Accessor<Turn | undefined> {
  const threadId = props.threadId;
  let thread = threads.get(threadId);
  if (!thread) {
    // A plain signal, not a memo: a memo would belong to the first reply's
    // component and stop when it unmounts, while other replies still read it.
    const [byReply, setByReply] = createSignal<ReadonlyMap<string, Turn>>(new Map(), { ownedWrite: true });
    const stop = client.subscribe(api.turns.replies, { threadId }, (event) => {
      if ("value" in event)
        setByReply(
          new Map(event.value.flatMap((turn) => (turn.replyId ? [[turn.replyId, turn] as const] : []))),
        );
    });
    thread = { users: 0, byReply, stop };
    threads.set(threadId, thread);
    setThreadsChanged((n) => n + 1);
  }
  const shared = thread;
  shared.users += 1;
  onCleanup(() => {
    shared.users -= 1;
    if (shared.users > 0) return;
    shared.stop();
    threads.delete(threadId);
    setThreadsChanged((n) => n + 1);
  });
  return () => shared.byReply().get(props.message._id);
}

/**
 * The turn that wrote this reply, read from the thread's subscription when one
 * of the reply's parts holds it, without subscribing; reactive. For an action's
 * `when`, which cannot own a subscription. The reply's other parts (`useTurn`)
 * open it, so it is there whenever the reply is drawn.
 */
export function shownTurn(props: MessageProps): Turn | undefined {
  threadsChanged();
  return threads.get(props.threadId)?.byReply().get(props.message._id);
}

/** The current time, every second while `active` holds, for a running clock; still otherwise. */
export function useClock(active: Accessor<boolean>): Accessor<number> {
  const [now, setNow] = createSignal(Date.now(), { ownedWrite: true });
  createEffect(active, (ticking) => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  return now;
}

/** A finished length of time, as the design writes it: 0.2s, 9.4s, 48s, 1m 12s, 1h 4m. */
export function duration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A running clock: 0:04, 1:12, 1:02:09. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}

/** "1 action", "14 actions". */
export function actions(count: number): string {
  return `${count} ${count === 1 ? "action" : "actions"}`;
}

/**
 * What the actions line says while a step runs, in two parts: the verb and
 * what it acts on ("Running" · `pnpm test auth`), or a helper's name and task
 * ("Explore" · "Find the cache").
 */
export function doingParts(step: NonNullable<Turn["current"]>): { verb: string; detail: string } {
  if (step.type === "helper") return { verb: step.name ?? "Helper", detail: step.title };
  return { verb: kinds[step.kind ?? "other"].verb, detail: step.title };
}

/** Token counts the way usage is read at a glance: 950, 12.4k, 1.2M. */
export function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trim(count / 1000)}k`;
  return `${trim(count / 1_000_000)}M`;
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(1)));
}

/**
 * The usage line at the end of a reply: "12.4k in · 1.1k out · $0.04".
 * Undefined when the agent reported no tokens at all (a turn stopped before
 * it was counted), where "0 in · 0 out" would say nothing.
 */
export function usageLine(usage: NonNullable<Turn["usage"]>): string | undefined {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return undefined;
  const parts = [`${tokens(usage.inputTokens)} in`, `${tokens(usage.outputTokens)} out`];
  if (usage.costUsd !== undefined)
    parts.push(usage.costUsd < 0.01 ? "<$0.01" : `$${usage.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}
