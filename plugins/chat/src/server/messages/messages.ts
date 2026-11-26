import { isServerCall, pluginOnly, v, type AuthContext, type DatabaseWriter, type Id } from "@tokamak/sdk";
import { omittedHistoryNote } from "@tokamak/sdk/agent-turn";
import { DEFAULT_TITLE, mutation, nonempty, query, thread, type Model } from "../_functions";
import { jsonBytes } from "./parts";
import { recentMessages } from "./_tail";
import { textOf } from "../../shared/text";

const TRANSCRIPT_BYTES = 768 * 1024;
/** A fresh session's history: the transcript budget less room for the omission note and array framing. */
const HISTORY_BUDGET = TRANSCRIPT_BYTES - 256;

export const list = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const rows = [];
    let remaining = TRANSCRIPT_BYTES;
    for await (const { replyToken: _token, ...message } of recentMessages(ctx.db, threadId)) {
      let row: typeof message & { tooLarge?: true } = message;
      let size = jsonBytes(row) + 1;
      if (size > TRANSCRIPT_BYTES) {
        row = {
          ...row,
          parts: [{ type: "text", text: "[Message too large to display]" }],
          tooLarge: true,
        };
        size = jsonBytes(row) + 1;
      }
      if (size > remaining) break;
      remaining -= size;
      rows.push(row);
    }
    rows.reverse();
    return rows.sort((a, b) => Number(a.status === "queued") - Number(b.status === "queued"));
  },
});

/** Sent text for a fresh agent session, newest first until its size budget fills. */
export const historyBefore = pluginOnly(
  query({
    args: { threadId: v.id("threads"), before: v.number() },
    handler: async ({ db }, { threadId, before }) => {
      const history: { role: "user" | "agent" | "note"; name: string; text: string }[] = [];
      let remaining = HISTORY_BUDGET;
      let omitted = 0;
      for await (const message of recentMessages(db, threadId, before, Infinity)) {
        if (message.status === "queued") continue;
        const text = textOf(message);
        if (!text) continue;
        const row = {
          role: message.role === "user" ? ("user" as const) : ("agent" as const),
          name: message.author?.name ?? "",
          text,
        };
        const bytes = jsonBytes(row) + 1;
        if (bytes > HISTORY_BUDGET) {
          omitted++;
          continue;
        }
        remaining -= bytes;
        if (remaining < 0) omitted++;
        else history.push(row);
      }
      if (omitted) history.push(omittedHistoryNote(omitted));
      return history.reverse();
    },
  }),
);

const messageInput = { threadId: v.id("threads"), text: v.string() };

export const post = mutation({
  args: messageInput,
  handler: async (ctx, args) => (await postRow(ctx, args, "complete")).messageId,
});

export const stage = pluginOnly(
  mutation({
    args: messageInput,
    handler: (ctx, args) => postRow(ctx, args, "queued"),
  }),
);

export const deliver = pluginOnly(
  mutation({
    args: { messageId: v.id("messages"), error: v.optional(v.string()), stopped: v.optional(v.boolean()) },
    handler: async (ctx, { messageId, error, stopped }) => {
      const message = await ctx.db.get(messageId);
      // The author delivers their own message. The server itself may too: `ai`'s
      // maintenance settles messages queued by an app that crashed.
      const allowed = message?.author?.id === ctx.auth.user.id || isServerCall(ctx.auth);
      if (message?.status !== "queued" || !allowed)
        throw new Error("This queued message belongs to another sender or was already delivered");
      const createdAt = await nextCreatedAt(ctx.db, message.threadId);
      await ctx.db.patch(messageId, {
        createdAt,
        status: stopped ? "cancelled" : error === undefined ? "complete" : "error",
        ...(error === undefined ? {} : { error }),
      });
      return null;
    },
  }),
);

export const prompt = pluginOnly(
  query({
    args: { messageId: v.id("messages") },
    handler: async ({ db }, { messageId }) => {
      const message = await db.get(messageId);
      return message?.role === "user"
        ? {
            threadId: message.threadId,
            createdAt: message.createdAt,
            authorId: message.author?.id ?? "",
            text: textOf(message),
          }
        : null;
    },
  }),
);

async function postRow(
  { db, auth }: { db: DatabaseWriter<Model>; auth: AuthContext },
  { threadId, text }: { threadId: Id<"threads">; text: string },
  status: "complete" | "queued",
) {
  const { user } = auth;
  const current = await thread(db, threadId);
  const content = nonempty(text);
  const last = await lastMessage(db, threadId);
  const createdAt = Math.max(Date.now(), (last?.createdAt ?? 0) + 1);
  const messageId = await db.insert("messages", {
    threadId,
    role: "user",
    author: { id: user.id, name: user.name },
    parts: [{ type: "text", text: content }],
    status,
    createdAt,
  });
  await db.patch(threadId, {
    updatedAt: Date.now(),
    ...(!last && current.title === DEFAULT_TITLE ? { title: Array.from(content).slice(0, 80).join("") } : {}),
  });
  return { messageId, createdAt };
}

function lastMessage(db: DatabaseWriter<Model>, threadId: Id<"threads">) {
  return db
    .query("messages")
    .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
    .order("desc")
    .first();
}

async function nextCreatedAt(db: DatabaseWriter<Model>, threadId: Id<"threads">) {
  return Math.max(Date.now(), ((await lastMessage(db, threadId))?.createdAt ?? 0) + 1);
}
