import { v } from "@tokamak/sdk";
import { activeTurnOf, lastEndedTurnOf, query } from "./_functions";

/** Enough for any list a window draws; one query serves the whole list. */
const MAX_THREADS = 500;
/** Helper rows shown under one working thread: the latest ones. */
const MAX_HELPERS = 5;

/**
 * What chat's thread list shows for each of `threadIds` (Paper "Threads · C"):
 * the state of the turn that holds the thread, else of the last turn that
 * ran, with the agent and the model's name. A working (running or waiting)
 * thread also lists its turn's latest helper agents. A thread with no turn
 * yet, or only queued ones, is left out. The window maps states to icons.
 */
export const statuses = query({
  args: { threadIds: v.array(v.string()) },
  handler: async ({ db }, { threadIds }) => {
    if (threadIds.length > MAX_THREADS) throw new Error(`At most ${MAX_THREADS} threads at once`);
    const rows = [];
    for (const threadId of new Set(threadIds)) {
      const active = await activeTurnOf(db, threadId);
      const turn = active ?? (await lastEndedTurnOf(db, threadId));
      if (!turn) continue;
      const helpers = active
        ? (
            await db
              .query("steps")
              .withIndex("by_turnId_type_n", (q) => q.eq("turnId", active._id).eq("type", "helper"))
              .order("desc")
              .take(MAX_HELPERS)
          )
            .reverse()
            .map(({ _id, name, title, state }) => ({ id: _id, name: name ?? "Helper", title, state }))
        : [];
      rows.push({
        threadId,
        state: turn.state,
        agent: turn.agent,
        model: turn.modelName ?? turn.model,
        helpers,
      });
    }
    return rows;
  },
});
