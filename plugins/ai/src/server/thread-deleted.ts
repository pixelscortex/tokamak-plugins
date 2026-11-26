import { provide, v } from "@tokamak/sdk";
import { threadDeletedServer } from "plugin:chat/contracts";
import { internalMutation } from "./_functions";

export const cleanupThread = provide(threadDeletedServer, {
  after: internalMutation({
    args: { threadId: v.string() },
    handler: async ({ db }, { threadId }) => {
      const turns = await db
        .query("turns")
        .withIndex("by_threadId_startedAt", (q) => q.eq("threadId", threadId))
        .collect();
      for (const turn of turns) {
        for (const step of await db
          .query("steps")
          .withIndex("by_turnId_n", (q) => q.eq("turnId", turn._id))
          .collect())
          await db.delete(step._id);
        for (const sign of await db
          .query("signs")
          .withIndex("by_turnId", (q) => q.eq("turnId", turn._id))
          .collect())
          await db.delete(sign._id);
        await db.delete(turn._id);
      }
      for (const row of await db
        .query("choices")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .collect())
        await db.delete(row._id);
    },
  }),
});
