import { definePlugin } from "@tokamak/sdk";

// A second test agent, to switch agents inside a thread. Unlike `fake-agent`
// it offers levels and speeds (no modes), so those pickers of the agent row show.
export default definePlugin({ id: "other-agent", version: "1.0.0", depends: ["ai"] });
