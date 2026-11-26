import { definePlugin } from "@tokamak/sdk";
export default definePlugin({
  id: "ai",
  version: "0.1.0",
  name: "AI",
  description: "Agents in chat threads: the agent row, the agent contract and each turn.",
  depends: ["chat"],
  // Every few seconds the server ends turns whose app has gone silent (liveness.ts).
  maintenance: "liveness:sweep",
  permissions: [],
});
