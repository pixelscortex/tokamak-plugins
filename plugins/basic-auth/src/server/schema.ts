import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({
  accounts: defineTable({
    accountId: v.string(),
    username: v.string(),
    email: v.string(),
    passwordHash: v.string(),
    temporary: v.optional(v.boolean()),
  })
    .index("by_account", ["accountId"])
    .index("by_username", ["username"])
    .index("by_email", ["email"]),
});
