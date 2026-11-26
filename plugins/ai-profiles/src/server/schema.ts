import { defineSchema, defineTable, v } from "@tokamak/sdk";
import { tables } from "plugin:chat/tables";

/**
 * ai-profiles' own data: a person's profiles. Subscriptions are
 * `agent-proxy`'s; a profile holds only their ids.
 *
 * Every row carries `owner`, the member who made it: a profile is one
 * person's, and every function reads and writes only the caller's rows.
 */
export default defineSchema({
  threadProfiles: defineTable({
    thread: v.ref(tables.threads),
    profile: v.id("profiles"),
    owner: v.string(),
  })
    .unique("by_thread", ["thread"])
    .index("by_profile", ["profile"]),
  lastProfiles: defineTable({
    owner: v.string(),
    profile: v.id("profiles"),
  }).unique("by_owner", ["owner"]),
  /** A named set of the person's subscriptions, in the order they are used (fill first). */
  profiles: defineTable({
    owner: v.string(),
    name: v.string(),
    /** One to four letters or digits, stored upper case, unique for the owner ("PERS"). */
    code: v.string(),
    /**
     * The subscriptions, first used first. Each `subscription` is the id of an
     * `agent-proxy` subscription as a plain string: there is no typed ref to
     * another plugin's row yet (`v.ref`, Plugin API v2), so nothing deletes an
     * entry when its subscription goes. Readers hide entries whose subscription
     * `agent-proxy` does not list right now; only `forgetSubscription` deletes
     * them (`profiles.ts`). Stored as `subscriptionKey` gives it. An object per
     * entry, so the models a profile allows from each (TKM-269) can join it.
     */
    entries: v.array(v.object({ subscription: v.string() })),
    createdAt: v.number(),
    set: v.optional(v.string()),
  })
    .index("by_owner", ["owner"])
    .unique("by_owner_code", ["owner", "code"]),
});
