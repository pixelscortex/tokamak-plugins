import type { TokamakClient } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import type { Status } from "@tokamak/ui";
import type { Turn } from "../../server/_functions";
import { ACTIVE } from "../../shared/turn-shared";
import { api } from "./agents";

/** What the list shows for one thread, as `threads:statuses` answers it. */
export interface ThreadStatus {
  readonly threadId: string;
  readonly state: Turn["state"];
  readonly agent: { readonly id: string; readonly name: string };
  /** The model's display name ("Opus 5.5"), else its id. */
  readonly model: string;
  /** The working turn's latest helper agents, oldest first. */
  readonly helpers: readonly {
    readonly id: string;
    readonly name: string;
    readonly title: string;
    readonly state: "running" | "done" | "failed";
  }[];
}

/** The four icons of Paper "Threads · C". Stopped counts as done, interrupted as failed. */
export function iconFor(turnState: Turn["state"]): Status | undefined {
  switch (turnState) {
    case "running":
      return "running";
    case "waiting":
      return "needs-you";
    case "done":
    case "stopped":
      return "done";
    case "failed":
    case "interrupted":
      return "failed";
    case "queued":
      return undefined;
  }
}

/** Running and waiting threads show a second line: agent, model and folder. */
export function isWorking(status: ThreadStatus | undefined): boolean {
  return ACTIVE.some((active) => active === status?.state);
}

const statuses = state<ReadonlyMap<string, ThreadStatus>>(new Map());

/** The status of `threadId`, once its row has asked for it; reactive. */
export function statusOf(threadId: string): ThreadStatus | undefined {
  return statuses().get(threadId);
}

// One live query for the whole list, whatever rows are drawn: each row's status
// part registers its thread here, and the query follows the set of rows.
const shown = new Map<string, number>();
let client: TokamakClient | undefined;
let unsubscribe: (() => void) | undefined;
let pending = false;

function resubscribe() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    unsubscribe?.();
    unsubscribe = undefined;
    const threadIds = [...shown.keys()].sort();
    if (!client || threadIds.length === 0) return statuses.set(new Map());
    unsubscribe = client.subscribe(api.threads.statuses, { threadIds }, (event) => {
      if ("value" in event) statuses.set(new Map(event.value.map((row) => [row.threadId, row])));
    });
  });
}

/** Follows `threadId` while its row is drawn; returns the function that stops. */
export function followThread(connection: TokamakClient, threadId: string): () => void {
  if (client !== connection) {
    client = connection;
    resubscribe();
  }
  const count = shown.get(threadId) ?? 0;
  shown.set(threadId, count + 1);
  if (count === 0) resubscribe();
  return () => {
    const left = (shown.get(threadId) ?? 1) - 1;
    if (left > 0) return void shown.set(threadId, left);
    shown.delete(threadId);
    resubscribe();
  };
}
