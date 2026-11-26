import { action, v, type DatabaseReader, type Doc, type Id } from "@tokamak/sdk";
import { threadDeletedLocal, threadDeletedServer } from "../../contracts";
import { api } from "../_generated/api";
import { folder } from "../folders/folder";
import { mutation, nonempty, query, thread, threadCreatorId, type Model } from "../_functions";

export const list = query({
  handler: ({ db }) => db.query("threads").withIndex("by_updatedAt").order("desc").collect(),
});

/** How many folders the new thread offers as starting points. */
const RECENT_FOLDERS = 3;
/** Threads read to find them; older folders drop off the list. */
const RECENT_SCAN = 200;

/** One thread, for the creator's Runner to find its folder. */
export const get = query({
  args: { threadId: v.id("threads") },
  handler: ({ db }, { threadId }) => db.get(threadId),
});

/** Who started a thread, named as on its first message; null once the thread is gone. */
export const creator = query({
  args: { threadId: v.id("threads") },
  handler: async ({ db }, { threadId }): Promise<{ id: string; name?: string } | null> => {
    const current = await db.get(threadId);
    if (!current) return null;
    const id = threadCreatorId(current);
    const first = await db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
      .first();
    return first?.author?.id === id ? { id, name: first.author.name } : { id };
  },
});

/**
 * Creates a thread with its first message. There are no empty threads: the
 * window keeps an unsent thread to itself until this first Send.
 * `{ kind: "own" }` is "No folder": the creator's Runner makes that folder
 * (`folders:resolve`) before anything works in it.
 */
export const start = mutation({
  args: { text: v.string(), folder },
  handler: async ({ db, auth }, { text, folder }) => {
    const content = nonempty(text);
    const now = Date.now();
    const threadId = await db.insert("threads", {
      title: titleFrom(content),
      folder: folder.kind === "chosen" ? { kind: "chosen", path: fullPath(folder.path) } : { kind: "own" },
      createdBy: auth.user.id,
      createdAt: now,
      updatedAt: now,
    });
    const messageId = await db.insert("messages", {
      threadId,
      role: "user",
      author: { id: auth.user.id, name: auth.user.name },
      parts: [{ type: "text", text: content }],
      status: "complete",
      createdAt: now,
    });
    return { threadId, messageId };
  },
});

/**
 * Stores the path of a "No folder" thread's own folder, once, made by its
 * creator's Runner. Only the creator may: the folder is on their computer,
 * and their agent works in it.
 */
export const setFolder = mutation({
  args: { threadId: v.id("threads"), path: v.string() },
  handler: async ({ db, auth }, { threadId, path }) => {
    const current = await creatorsThread(db, threadId, auth.user.id, "set its folder");
    // Threads from before folders existed have none and get an own folder too.
    if (current.folder && (current.folder.kind !== "own" || current.folder.path !== undefined))
      throw new Error("This thread already has a folder");
    return db.patch(threadId, { folder: { kind: "own", path: fullPath(path) } });
  },
});

/** The caller's most recently chosen folders, newest first; own folders are left out. */
export const recentFolders = query({
  handler: async ({ db, auth }) => {
    const folders: string[] = [];
    for (const row of await db.query("threads").withIndex("by_updatedAt").order("desc").take(RECENT_SCAN)) {
      if (row.folder?.kind !== "chosen" || threadCreatorId(row) !== auth.user.id) continue;
      if (!folders.includes(row.folder.path)) folders.push(row.folder.path);
      if (folders.length === RECENT_FOLDERS) break;
    }
    return folders;
  },
});

/** The first line of the first message, cut to a title's length. */
function titleFrom(text: string) {
  const line = text.split("\n", 1)[0]!.trim();
  return Array.from(line).slice(0, 80).join("");
}

/**
 * A folder is an absolute path on its creator's computer. `~` is expanded by
 * a caller action on that computer before it is stored; a browser stores what it was given.
 */
function fullPath(path: string) {
  const value = nonempty(path);
  if (!/^(\/|~(\/|$)|[A-Za-z]:[\\/])/.test(value)) throw new Error("A folder must be a full path");
  return value;
}

export const rename = mutation({
  args: { threadId: v.id("threads"), title: v.string() },
  handler: async (ctx, { threadId, title }) => {
    const { db } = ctx;
    await creatorsThread(db, threadId, ctx.auth.user.id, "rename it");
    return db.patch(threadId, { title: nonempty(title), updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { db } = ctx;
    await creatorsThread(db, threadId, ctx.auth.user.id, "delete it");
    for (const hook of await threadDeletedServer.list()) await hook.after({ threadId });
    for (const message of await db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
      .collect()) {
      await db.delete(message._id);
    }
    return db.delete(threadId);
  },
});

/** Desktop deletion can also clean up things plugins kept on this computer. */
export const removeLocal = action({
  on: "caller",
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const current = await ctx.runQuery(api.threads.get, { threadId });
    await ctx.runMutation(api.threads.remove, { threadId });
    if (!current) return null;
    let cleaned = true;
    function cleanupFailed(cause: unknown) {
      cleaned = false;
      // oxlint-disable-next-line no-console -- The Runner worker sends this warning to the client log.
      console.warn("chat: could not remove local thread data", cause);
    }
    try {
      const hooks = await threadDeletedLocal.list(ctx, {
        onUnavailable: ({ message }) => cleanupFailed(message),
      });
      const folder = current.folder?.path;
      const event = { threadId, ...(folder === undefined ? {} : { folder }) };
      await Promise.all(
        hooks.map(async (hook) => {
          try {
            await hook.after(event);
          } catch (cause) {
            cleanupFailed(cause);
          }
        }),
      );
    } catch (cause) {
      cleanupFailed(cause);
    }
    return cleaned
      ? null
      : { warning: "The thread was deleted, but some of its local data couldn't be removed." };
  },
});

/** What the creator alone may do to a thread, as the refusal says it ("rename it"). */
type CreatorAction = "set its folder" | "rename it" | "delete it";

/** The thread, if `userId` started it; otherwise refuses `action`. */
async function creatorsThread(
  db: DatabaseReader<Model>,
  threadId: Id<"threads">,
  userId: string,
  action: CreatorAction,
): Promise<Doc<Model, "threads">> {
  const current = await thread(db, threadId);
  if (threadCreatorId(current) !== userId)
    throw new Error(`Only the person who started this thread can ${action}`);
  return current;
}
