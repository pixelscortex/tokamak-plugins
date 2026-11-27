import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { scanReplays, scanRepository } from "../fake-agent/replay-privacy.mjs";
import { workspace } from "./paths.mjs";

for (const agent of ["claude", "codex"]) await scanReplays(agent);

// Plugins can also keep their own replay recordings in a replays folder.
async function scanPluginReplays(folder, agent, inReplays = false) {
  const entries = await readdir(folder, { withFileTypes: true });
  if (inReplays && entries.some((entry) => entry.isFile() &&
    (agent === "claude" ? /^claude-.*\.jsonl$/.test(entry.name) : entry.name.endsWith(".jsonl")))) {
    await scanReplays(agent, folder);
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "dist"].includes(entry.name)) {
      await scanPluginReplays(join(folder, entry.name), agent, inReplays || entry.name === "replays");
    }
  }
}

for (const agent of ["claude", "codex"]) await scanPluginReplays(join(workspace, "plugins", agent), agent);
await scanRepository();
console.log("PASS replay privacy: Claude and Codex recordings and repository text");
