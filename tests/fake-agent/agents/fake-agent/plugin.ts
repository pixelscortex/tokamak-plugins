import { definePlugin } from "@tokamak/sdk";

// A test agent: fills ai's agent contract by starting the `fake-agent` replay
// program, the way `claude` and `codex` start their real programs.
export default definePlugin({ id: "fake-agent", version: "1.0.0", depends: ["ai", "chat"] });
