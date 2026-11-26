import { action, provide, v } from "@tokamak/sdk";
import { removeAgentLaunchHomes } from "@tokamak/sdk/agent-launch";
import { threadDeletedLocal } from "plugin:chat/contracts";

export const cleanupLocalThread = provide(threadDeletedLocal, {
  after: action({
    on: "caller",
    args: { threadId: v.id("threads"), folder: v.optional(v.string()) },
    handler: (_ctx, { threadId }) => removeAgentLaunchHomes(threadId),
  }),
});
