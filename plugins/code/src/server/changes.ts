import { action, v, type CallerActionContext, type Id } from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";
import { currentBranch, turnChange, turnDiff } from "../local/changes";
import { repository, type Repository } from "../local/git";

/**
 * What a turn changed, read from this computer's Git when the window asks.
 * Nothing about code is stored on the server. Every function answers null
 * when the thread's folder is not a Git worktree.
 */

/**
 * Each thread's worktree once found: a thread's folder never changes, and the
 * branch chip asks every few seconds. A folder without Git is looked up again
 * each time, so Git added later is found; a worktree that stops working is dropped.
 */
const repositories = new Map<Id<"threads">, Repository>();

async function withRepository<T>(
  ctx: CallerActionContext,
  threadId: Id<"threads">,
  read: (repo: Repository) => Promise<T>,
): Promise<T | null> {
  let repo = repositories.get(threadId);
  if (!repo) {
    const thread = await ctx.runQuery(chat.getThread, { threadId });
    repo = thread?.folder?.path ? await repository(ctx, thread.folder.path) : undefined;
    if (!repo) return null;
    repositories.set(threadId, repo);
  }
  try {
    return await read(repo);
  } catch (cause) {
    repositories.delete(threadId);
    throw cause;
  }
}

/**
 * The change card's counts; null when the turn has no saved before and after.
 * `ranEarlier` lists the thread's earlier turns whose agent ran, so a turn
 * after one that ran without Git can say tracking started.
 */
export const forTurn = action({
  on: "caller",
  args: { threadId: v.id("threads"), turnId: v.string(), ranEarlier: v.array(v.string()) },
  handler: (ctx, { threadId, turnId, ranEarlier }) =>
    withRepository(ctx, threadId, (repo) => turnChange(ctx, { ...repo, threadId, turnId }, ranEarlier)),
});

/** The review panel: the turn's files with counts and plain diffs, cut at a line budget. */
export const diff = action({
  on: "caller",
  args: { threadId: v.id("threads"), turnId: v.string() },
  handler: (ctx, { threadId, turnId }) =>
    withRepository(ctx, threadId, (repo) => turnDiff(ctx, { ...repo, threadId, turnId })),
});

/** The branch for the thread header's chip; null without Git. */
export const branch = action({
  on: "caller",
  args: { threadId: v.id("threads") },
  handler: (ctx, { threadId }) =>
    withRepository(ctx, threadId, (repo) => currentBranch(ctx, repo)).catch(() => null),
});
