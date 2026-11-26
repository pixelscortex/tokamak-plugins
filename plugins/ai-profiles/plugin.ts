import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "ai-profiles",
  version: "0.1.0",
  name: "AI Profiles",
  description: "A person's subscriptions and profiles, used to run agents in chat threads.",
  depends: ["ai", "agent-proxy", "chat"],
  permissions: [],
});
