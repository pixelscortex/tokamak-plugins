import { cp } from "node:fs/promises";
import { join } from "node:path";
import { buildPluginsIn } from "./build-plugins.ts";

// Build owners before dependents so the builder can read their references.
const starterPlugins = ["chat", "ai", "code", "claude", "codex", "basic-auth", "agent-proxy", "ai-profiles"];

export async function buildStarterPlugins(sources: string, destination: string) {
  await buildPluginsIn(sources, starterPlugins);
  for (const id of starterPlugins) {
    await cp(join(sources, id, "dist"), join(destination, id, "dist"), { recursive: true });
  }
}
