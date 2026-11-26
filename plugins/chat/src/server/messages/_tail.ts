import type { DatabaseReader, Id } from "@tokamak/sdk";
import type { Model } from "../_functions";

export async function* recentMessages(
  db: DatabaseReader<Model>,
  threadId: Id<"threads">,
  before?: number,
  limit = 200,
) {
  // Both writers allocate strictly increasing createdAt values inside their transaction.
  for (let read = 0; read < limit; read += 8) {
    const cursor = before;
    const page = await db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => {
        const range = q.eq("threadId", threadId);
        return cursor === undefined ? range : range.lt("createdAt", cursor);
      })
      .order("desc")
      .take(8);
    yield* page;
    if (page.length < 8) return;
    before = page.at(-1)!.createdAt;
  }
}
