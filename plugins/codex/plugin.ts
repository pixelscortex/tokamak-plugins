import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "codex",
  version: "0.1.0",
  name: "Codex",
  description: "Run Codex in chat on your own Codex login.",
  depends: ["ai"],
});
