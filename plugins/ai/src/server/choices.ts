import { v, type DatabaseWriter, type ArgsOf, type MutationContext } from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";
import { mutation, query, type Model } from "./_functions";
import { choiceFields, type Choices } from "./schema";

/**
 * The thread's agent row: what its next turn uses. Null until a picker changes
 * or a turn begins in it; the row then shows this device's last choices.
 */
export const get = query({
  args: { threadId: v.string() },
  handler: async ({ db }, { threadId }): Promise<Choices | null> => {
    const row = await db
      .query("choices")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .first();
    if (!row) return null;
    const { _id, _creationTime, threadId: _thread, updatedAt: _at, ...picked } = row;
    return picked;
  },
});

/** Who started the thread, the one person who runs its agent; null once the thread is gone. */
export const creator = query({
  args: { threadId: v.string() },
  handler: (ctx, { threadId }) =>
    ctx.use(chat).threadCreator({ threadId: threadId as ArgsOf<typeof chat.getThread>["threadId"] }),
});

/**
 * Sets every choice of the thread at once, when a picker changes. Only the
 * person who started the thread may change them (coding alone: its owner).
 * The Runner checks them against the agent before a turn uses them.
 */
export const set = mutation({
  args: { threadId: v.string(), ...choiceFields },
  handler: async (ctx, { threadId, ...picked }) => {
    if (!(await startedBy(ctx, threadId, ctx.auth.user.id)))
      throw new Error("Only the person who started this thread can change its agent");
    await save(ctx, threadId, picked);
    return null;
  },
});

/** Whether `userId` started the thread; throws when the thread is gone. */
export async function startedBy(
  ctx: MutationContext<Model>,
  threadId: string,
  userId: string,
): Promise<boolean> {
  const creator = await ctx
    .use(chat)
    .threadCreator({ threadId: threadId as ArgsOf<typeof chat.getThread>["threadId"] });
  if (!creator) throw new Error("That thread no longer exists");
  return creator.id === userId;
}

/** Replaces the thread's choices; also used by `turns:begin` to keep what a turn used. */
export async function save(
  { db }: { db: DatabaseWriter<Model> },
  threadId: string,
  picked: Choices,
): Promise<void> {
  const row = { threadId, ...picked, updatedAt: Date.now() };
  const current = await db
    .query("choices")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .first();
  if (current) await db.replace(current._id, row);
  else await db.insert("choices", row);
}
