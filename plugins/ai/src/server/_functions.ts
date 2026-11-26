import { createFunctions, type DatabaseReader, type Doc, type ModelFromSchema } from "@tokamak/sdk";
import { ACTIVE, ENDED } from "../shared/turn-shared";
import schema from "./schema";

export const { query, mutation, internalMutation } = createFunctions(schema);
export type Model = ModelFromSchema<typeof schema>;
export type Turn = Doc<Model, "turns">;
/**
 * A turn as windows and local code see it: without chat's reply capability or
 * the question's token, and without its long texts (the reply is chat's
 * message; thinking is read when opened).
 */
export type TurnView = Omit<Turn, "replyToken" | "questionToken" | "text" | "thinking" | "sessionHome"> & {
  hasThinking: boolean;
};

export { ACTIVE, ENDED };

export function isActive(turn: Pick<Turn, "state">): boolean {
  return ACTIVE.some((state) => state === turn.state);
}

/** The turn that holds `threadId` (running or waiting), if any: one read per state through the index. */
export async function activeTurnOf(db: DatabaseReader<Model>, threadId: string): Promise<Turn | null> {
  for (const state of ACTIVE) {
    const turn = await db
      .query("turns")
      .withIndex("by_threadId_state", (q) => q.eq("threadId", threadId).eq("state", state))
      .first();
    if (turn) return turn;
  }
  return null;
}

/**
 * The last turn of `threadId` that ran and ended: the one that began last,
 * since one writer means it also ended last. One read per ended state.
 */
export async function lastEndedTurnOf(db: DatabaseReader<Model>, threadId: string): Promise<Turn | null> {
  let last: Turn | null = null;
  for (const state of ENDED) {
    const turn = await db
      .query("turns")
      .withIndex("by_threadId_state_startedAt", (q) => q.eq("threadId", threadId).eq("state", state))
      .order("desc")
      .first();
    if (turn && (!last || turn.startedAt > last.startedAt)) last = turn;
  }
  return last;
}

export function view({
  replyToken: _reply,
  questionToken: _question,
  text: _text,
  thinking,
  sessionHome: _sessionHome,
  ...turn
}: Turn): TurnView {
  return { ...turn, hasThinking: Boolean(thinking) };
}
