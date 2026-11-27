// One clean set of real plugin artifacts per Rust check. Each driver gets its
// own copy so reload tests can edit the installed artifacts independently.
import { join } from "node:path";
import { buildAgentPlugins } from "./harness.mjs";

const scratch = process.argv[2];
await buildAgentPlugins(scratch, (id) => join(scratch, "artifacts", id));
