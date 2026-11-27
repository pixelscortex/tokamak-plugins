import { mutation, v, type Id } from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";

export const open = mutation({
  args: { threadId: v.string(), token: v.string() },
  handler: (ctx, { threadId, token }) =>
    ctx.use(chat).startReply({
      threadId: threadId as Id<"threads">,
      token,
      author: { id: "agent:probe", name: "Probe" },
    }),
});

export const write = mutation({
  args: { messageId: v.string(), token: v.string(), text: v.string(), done: v.optional(v.boolean()) },
  handler: (ctx, { messageId, ...rest }) =>
    ctx.use(chat).writeReply({ messageId: messageId as Id<"messages">, ...rest }),
});
