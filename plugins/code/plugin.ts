import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "code",
  version: "0.1.0",
  name: "Code",
  description: "Saves the code before and after a turn in the thread's Git repository.",
  depends: ["chat"],
  optional: ["ai"],
  permissions: [],
});
