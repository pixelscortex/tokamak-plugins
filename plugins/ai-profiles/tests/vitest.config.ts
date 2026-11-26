import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { windowTestConfig } from "@tokamak/build/window-test-config";

const profiles = resolve(import.meta.dirname, "..");
const config = windowTestConfig(profiles, "ai-profiles", {
  "plugin:chat/client": resolve(profiles, "../chat/src/client/api.ts"),
  "plugin:ai/client": resolve(profiles, "../ai/src/client/ui/thread-status.tsx"),
});
export default defineConfig({
  ...config,
  // ui-sdk's Switch reads its field context from a plain .js module; inline it so it
  // shares the browser build of solid-js with the rest of the window, not Node's server build.
  test: { ...config.test, server: { deps: { inline: [/@ui-sdk\//] } } },
});
