import { pluginOnly, v } from "@tokamak/sdk";
import { mutation, nonempty, thread } from "../_functions";

/**
 * Replies written into a thread by another plugin, such as `ai` writing an
 * agent's answer during a turn. Plugin-only: no window can call these.
 *
 * `start` opens a reply and binds it to a token the calling plugin chose for
 * its own turn; `write` then needs that token, so one plugin cannot write into
 * another plugin's reply. Chat stores the text; what a turn is stays with the caller.
 */
const token = v.string();
const TOKEN = /^[0-9a-f]{64}$/;

export const start = pluginOnly(
  mutation({
    args: { threadId: v.id("threads"), token, author: v.object({ id: v.string(), name: v.string() }) },
    handler: async ({ db }, { threadId, token, author }) => {
      if (!TOKEN.test(token)) throw new Error("A reply token is 64 lowercase hex characters");
      await thread(db, threadId);
      const last = await db
        .query("messages")
        .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
        .order("desc")
        .first();
      const messageId = await db.insert("messages", {
        threadId,
        role: "assistant",
        author: { id: nonempty(author.id), name: nonempty(author.name) },
        parts: [],
        status: "streaming",
        replyToken: token,
        createdAt: Math.max(Date.now(), (last?.createdAt ?? 0) + 1),
      });
      await db.patch(threadId, { updatedAt: Date.now() });
      return messageId;
    },
  }),
);

/**
 * Replaces the reply's text; `done` finishes it, after which it cannot change.
 * Without `text` the reply keeps what it has, as when its writer went away and
 * the caller only marks how it ended (`interrupted`, with the reason in `error`).
 */
export const write = pluginOnly(
  mutation({
    args: {
      messageId: v.id("messages"),
      token,
      text: v.optional(v.string()),
      done: v.optional(v.boolean()),
      outcome: v.optional(v.union(v.literal("error"), v.literal("cancelled"), v.literal("interrupted"))),
      error: v.optional(v.string()),
    },
    handler: async ({ db }, { messageId, token, text, done, outcome, error }) => {
      const message = await db.get(messageId);
      if (!message || !message.replyToken || message.replyToken !== token)
        throw new Error("This reply belongs to another writer");
      if (message.status !== "streaming") throw new Error("This reply is finished");
      await db.patch(messageId, {
        ...(text === undefined ? {} : { parts: text ? [{ type: "text" as const, text }] : [] }),
        ...(done ? { status: outcome ?? "complete" } : {}),
        ...(done && (outcome === "error" || outcome === "interrupted") && error !== undefined
          ? { error }
          : {}),
      });
      return null;
    },
  }),
);
