import { defineSchema, defineTable, v } from "@tokamak/sdk";

import { textPart, toolPart, planPart, permissionPart } from "./messages/parts";
import { folder } from "./folders/folder";

export default defineSchema({
  threads: defineTable({
    // The user id of whoever sent the first message. Their computer holds the folder.
    createdBy: v.optional(v.string()),
    // Historical rows can still carry this field. No current handler writes it.
    backend: v.optional(
      v.object({
        kind: v.literal("plugin"),
        plugin: v.string(),
        backendId: v.string(),
        settings: v.optional(v.any()),
        state: v.optional(v.any()),
      }),
    ),
    title: v.string(),
    // Where work for this thread happens on its creator's computer: a folder they
    // chose, or ("No folder") an empty folder of its own under the app's data.
    // An own folder's path is known once the creator's Runner has made it.
    folder: v.optional(folder),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),
  messages: defineTable({
    threadId: v.id("threads"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    author: v.optional(v.object({ id: v.string(), name: v.string() })),
    askedBy: v.optional(v.object({ id: v.string(), name: v.string() })),
    parts: v.array(v.union(textPart, toolPart, planPart, permissionPart)),
    status: v.union(
      v.literal("queued"),
      v.literal("streaming"),
      v.literal("complete"),
      v.literal("error"),
      v.literal("cancelled"),
      // A reply whose writer went away before it ended, kept as it was (`error` says why).
      v.literal("interrupted"),
    ),
    error: v.optional(v.string()),
    // Stored by earlier versions; current replies identify the agent by author.
    agent: v.optional(v.object({ plugin: v.string(), backendId: v.string() })),
    // A reply written by another plugin (e.g. `ai`) through `replies:*`. Only the
    // holder of this token, chosen by that plugin when it opened the reply, can
    // write to it. Never sent to windows.
    replyToken: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_threadId_createdAt", ["threadId", "createdAt"]),
});
