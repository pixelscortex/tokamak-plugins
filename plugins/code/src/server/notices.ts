import { action, v } from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";
import { repository, snapshotNotice } from "../local/git";

/** The names and warning are read from Git by a caller action on the Runner. */
export const forTurn = action({
  on: "caller",
  args: { threadId: v.id("threads"), turnId: v.string() },
  handler: async (ctx, { threadId, turnId }) => {
    const thread = await ctx.runQuery(chat.getThread, { threadId });
    if (!thread?.folder?.path) return null;
    const repo = await repository(ctx, thread.folder.path);
    return repo ? snapshotNotice(ctx, { ...repo, threadId, turnId }) : null;
  },
});
