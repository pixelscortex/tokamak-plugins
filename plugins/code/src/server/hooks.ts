import { action, fail, provide, type CallerActionContext, type Id } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { threadDeletedLocal, type DeletedThread } from "plugin:chat/contracts";
import { api as chat } from "plugin:chat/server";
import { AFTER_SNAPSHOT_WARNING, deleteSnapshots, repository, snapshot } from "../local/git";
import { findBeforeSnapshot, pruneSnapshots, trackSnapshots } from "../local/snapshots";
import { BEFORE_NOT_SAVED } from "../shared/text";

export const snapshotHooks = provide(
  ai.turnHooks,
  {
    afterTimeoutNotice: AFTER_SNAPSHOT_WARNING,
    before: action({
      on: "caller",
      handler: async (ctx, turn: ai.TurnInfo) => {
        try {
          const repo = await repository(ctx, turn.folder, turn.signal);
          if (!repo) return;
          const target = { ...repo, ...turn };
          await trackSnapshots(ctx, { ...repo, threadId: turn.threadId, turnId: turn.turnId });
          await snapshot(ctx, target, "before");
          if (await cleanedIfDeleted(ctx, target))
            return fail("ThreadDeleted", { reason: "The thread was deleted before the agent could start." });
        } catch (cause) {
          // A turn reason is stored by ai. Keep repository paths and Git output local.
          const step = cause instanceof Error && /^Git could not ([a-z-]+):/.exec(cause.message)?.[1];
          return fail("NotSaved", {
            reason: step ? `${BEFORE_NOT_SAVED} (git ${step} failed).` : `${BEFORE_NOT_SAVED}.`,
          });
        }
      },
    }),
    after: action({
      on: "caller",
      handler: async (ctx, turn: ai.TurnInfo) => {
        try {
          // Git added during an agent run takes effect on the next turn.
          const saved = await findBeforeSnapshot(ctx, turn);
          if (!saved) return;
          const { target, before } = saved;
          await snapshot(ctx, target, "after", before);
          await cleanedIfDeleted(ctx, target);
        } catch (cause) {
          throw new Error(AFTER_SNAPSHOT_WARNING, { cause });
        }
      },
    }),
  },
  // This notice is also in the manifest, for when the Code process cannot answer.
  { unavailable: "Couldn't save this turn's code" },
);

export const cleanup = provide(threadDeletedLocal, {
  after: action({
    on: "caller",
    handler: async (ctx, { threadId, folder }: DeletedThread) => {
      if (!folder) return;
      const repo = await repository(ctx, folder);
      if (repo) await deleteSnapshots(ctx, { ...repo, threadId });
    },
  }),
});

/** Recheck this device's recorded repositories when its Runner becomes available. */
export const prune = action({
  on: "caller",
  handler: async (ctx) => {
    await pruneSnapshots(ctx);
    return null;
  },
});

// A running turn can publish a ref after the delete hook lists the refs.
// Check the committed deletion after publishing so the last writer cleans up.
async function cleanedIfDeleted(
  ctx: CallerActionContext,
  target: { root: string; threadId: Id<"threads">; signal: CallerActionContext["signal"] },
): Promise<boolean> {
  if (await ctx.runQuery(chat.getThread, { threadId: target.threadId })) return false;
  await deleteSnapshots(ctx, target, target.signal);
  return true;
}
