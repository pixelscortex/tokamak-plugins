import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { windowTestConfig } from "../../../scripts/window-test-config.ts";

const ai = resolve(import.meta.dirname, "..");
export default defineConfig(
  windowTestConfig(ai, "ai", {
    "plugin:chat/client": resolve(ai, "../chat/src/client/api.ts"),
  }),
);
