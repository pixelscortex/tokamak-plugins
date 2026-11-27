import { v } from "@tokamak/sdk";
import { query } from "./_functions";

// Test only: ai-turns-driver.mjs copies this into a scratch build of ai as
// src/server/probe.ts. It counts a turn's raw steps and signs, which no public
// query can read once the turn row is gone, so a test can prove they were deleted.
export const rows = query({
  args: { turnIds: v.array(v.id("turns")) },
  handler: async ({ db }, { turnIds }) => {
    let steps = 0;
    let signs = 0;
    for (const turnId of turnIds) {
      steps += (
        await db
          .query("steps")
          .withIndex("by_turnId_n", (q) => q.eq("turnId", turnId))
          .collect()
      ).length;
      signs += (
        await db
          .query("signs")
          .withIndex("by_turnId", (q) => q.eq("turnId", turnId))
          .collect()
      ).length;
    }
    return { steps, signs };
  },
});
