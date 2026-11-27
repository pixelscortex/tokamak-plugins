import { configDefaults, defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { windowTestConfig } from "../../../scripts/window-test-config.ts";

const profiles = resolve(import.meta.dirname, "..");
const config = windowTestConfig(profiles, "ai-profiles", {
  "plugin:chat/client": resolve(profiles, "../chat/src/client/api.ts"),
  "plugin:ai/client": resolve(profiles, "../ai/src/client/ui/thread-status.tsx"),
});
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    exclude: [...configDefaults.exclude, "tests/profiles-server.test.ts"],
  },
});
