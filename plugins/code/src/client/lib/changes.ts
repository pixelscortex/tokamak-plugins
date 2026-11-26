import {
  createApi,
  isFailure,
  type FunctionReference,
  type Id,
  type MachineFailure,
  type ResultOf,
  type TokamakClient,
} from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import type { MessageProps } from "plugin:chat/client";
import { api } from "../../server/_generated/api";
import { BEFORE_NOT_SAVED } from "../../shared/text";
import { onRunner, runnerMissing, watchRunnerFocus, windowClient } from "./runner";

/** The fields of `ai`'s turn rows that `code` reads. */
interface TurnRow {
  readonly _id: string;
  readonly replyId?: string;
  readonly state: string;
  readonly error?: string;
}

// A hard window import would make an optional ai install mandatory.
const ai = createApi<{
  turns: { list: FunctionReference<"query", { threadId: string }, TurnRow[]> };
}>("ai", ["turns:list"]);

/** A turn of the thread with its 1-based number, as the card and the panel name it. */
export interface NumberedTurn {
  readonly turnId: string;
  readonly replyId: string | undefined;
  readonly number: number;
  /** Ids of the earlier turns whose agent ran (not queued, not stopped by a failed before snapshot). */
  readonly ranEarlier: readonly string[];
}

/** What the turn ending at one reply changed, with the turn it belongs to. */
export type ReplyChange = Exclude<ResultOf<typeof api.changes.forTurn>, MachineFailure | null> & {
  readonly turnId: string;
  readonly number: number;
};

/**
 * The last reply of a turn: an agent reply followed by the person's next
 * message or by nothing, read from the message's position in the thread.
 */
export function lastOfTurn(props: MessageProps): boolean {
  return (
    props.message.role === "assistant" &&
    !!props.message.author?.id.startsWith("agent:") &&
    (!props.next || props.next.role === "user")
  );
}

/** Whether the turn's agent ran: it got a reply, and code's before snapshot did not stop it. */
function ran(turn: TurnRow): boolean {
  return (
    !!turn.replyId &&
    turn.state !== "queued" &&
    !(turn.state === "failed" && turn.error?.startsWith(BEFORE_NOT_SAVED))
  );
}

function numbered(rows: readonly TurnRow[]): NumberedTurn[] {
  return rows.map((row, index) => ({
    turnId: row._id,
    replyId: row.replyId,
    number: index + 1,
    ranEarlier: rows
      .slice(0, index)
      .filter(ran)
      .map((earlier) => earlier._id),
  }));
}

/**
 * The thread's turns, asked once per thread and again only when asked
 * `fresh` or when a reply's turn is missing from the last answer (a turn that
 * started since). Every reply of a long thread mounts its footer at once; one
 * query each would flood the connection's bounded event queue and the server
 * would close it.
 */
const turnLists = new Map<string, Promise<readonly NumberedTurn[]>>();

/** The thread's turns, oldest first, numbered from 1. */
export function turnsOf(
  client: TokamakClient,
  threadId: string,
  { fresh = false } = {},
): Promise<readonly NumberedTurn[]> {
  const cached = turnLists.get(threadId);
  if (cached && !fresh) return cached;
  const list = client.query(ai.turns.list, { threadId }).then(numbered);
  turnLists.set(threadId, list);
  // A failed answer is not kept: the next reader asks again.
  list.catch(() => turnLists.get(threadId) === list && turnLists.delete(threadId));
  return list;
}

/** The turn whose reply is `replyId`. */
export async function turnOf(client: TokamakClient, threadId: string, replyId: string) {
  const find = (turns: readonly NumberedTurn[]) => turns.find((turn) => turn.replyId === replyId);
  return find(await turnsOf(client, threadId)) ?? find(await turnsOf(client, threadId, { fresh: true }));
}

/**
 * At most a few caller actions at once. Opening a long thread asks for every
 * reply's card and notice together, and each action reads from the server
 * on the window's connection, whose event queue is small.
 */
const ASKING_AT_ONCE = 4;
let asking = 0;
const waiting: (() => void)[] = [];
export async function oneAtATime<T>(ask: () => Promise<T>): Promise<T> {
  if (asking >= ASKING_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  asking += 1;
  try {
    return await ask();
  } finally {
    asking -= 1;
    waiting.shift()?.();
  }
}

/** Changes by reply and reply status: a finished reply is read once, a later status reads again. */
const changes = state<Readonly<Record<string, ReplyChange | null>>>({});
const requested = new Set<string>();

async function load(client: TokamakClient, key: string, threadId: Id<"threads">, replyId: string) {
  const turn = await turnOf(client, threadId, replyId).catch(() => undefined);
  const change = turn
    ? await oneAtATime(() =>
        onRunner(client, () =>
          client.action(api.changes.forTurn, {
            threadId,
            turnId: turn.turnId,
            ranEarlier: [...turn.ranEarlier],
          }),
        ),
      ).catch(() => null)
    : null;
  if (isFailure(change) && change.kind === "noMachine") {
    requested.delete(key);
    return;
  }
  changes.set((all) => ({
    ...all,
    [key]:
      change && !isFailure(change) && turn ? { ...change, turnId: turn.turnId, number: turn.number } : null,
  }));
}

/**
 * What the turn ending at this reply changed, from this computer's Git;
 * undefined while it is read or the reply streams; null if the Runner is missing.
 * Reactive: the first read starts the lookup.
 */
export function changeOf(props: MessageProps): ReplyChange | null | undefined {
  const client = windowClient();
  if (!client || props.message.status === "streaming" || props.message.status === "queued") return undefined;
  if (runnerMissing(client)) return null;
  const key = `${props.message._id}:${props.message.status}`;
  if (!requested.has(key)) {
    requested.add(key);
    void load(client, key, props.threadId, props.message._id);
  }
  return changes()[key];
}

/** Whether the reply ends a turn with a card to show: it changed files, or tracking started. */
export function turnChanged(props: MessageProps): boolean {
  const change = changeOf(props);
  return !!change && (change.files > 0 || change.tracking !== null);
}

/** The review panel: open for one thread, on one turn, or on the latest changed turn. */
export const review = state<{ readonly threadId: string; readonly turnId?: string } | undefined>(undefined);

export function openReview(threadId: string, turnId?: string): void {
  review.set({ threadId, turnId });
}

/**
 * Each open thread's branch, as last read; null in a folder without Git. The
 * layout control and the panel show only when there is a branch.
 */
const branches = state<Readonly<Record<string, string | null>>>({});

export function branchOf(threadId: string): string | null | undefined {
  const client = windowClient();
  return client && runnerMissing(client) ? null : branches()[threadId];
}

/** How often a visible window reads the branch again, besides when it gets focus or is shown. */
const BRANCH_POLL_MS = 3000;

/** One reader per thread, however many chips show it. */
const followers = new Map<string, { count: number; stop: () => void }>();

/**
 * Keeps the thread's branch current while the returned stop is not called:
 * now, every few seconds while the window is visible, and when it is shown or focused.
 */
export function followBranch(client: TokamakClient, threadId: Id<"threads">): () => void {
  const existing = followers.get(threadId);
  if (existing) existing.count++;
  else followers.set(threadId, { count: 1, stop: startFollowing(client, threadId) });
  return () => {
    const follower = followers.get(threadId);
    if (!follower || --follower.count > 0) return;
    follower.stop();
    followers.delete(threadId);
  };
}

function startFollowing(client: TokamakClient, threadId: Id<"threads">): () => void {
  let active = true;
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = async () => {
    if (reading || document.hidden) return;
    clearTimeout(timer);
    reading = true;
    try {
      const result = await onRunner(client, () => client.action(api.changes.branch, { threadId }));
      const branch = isFailure(result) ? null : result;
      if (active && branches()[threadId] !== branch) branches.set((all) => ({ ...all, [threadId]: branch }));
    } catch {
      // Keep the last branch if the connection drops during a read.
    } finally {
      reading = false;
      if (active && !runnerMissing(client)) timer = setTimeout(read, BRANCH_POLL_MS);
    }
  };

  const unwatch = watchRunnerFocus(client, read);
  void read();
  return () => {
    active = false;
    clearTimeout(timer);
    unwatch();
  };
}
