import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { clientSurface } from "@tokamak/build/client-surface";
import { windowTestConfig } from "../../../scripts/window-test-config.ts";

const code = resolve(import.meta.dirname, "..");
const chat = resolve(code, "../chat");

export default defineConfig(
  windowTestConfig(code, "code", { "plugin:chat/client": resolve(chat, "src/client/api.ts") }, [
    clientSurface(
      () => chat,
      () => "chat",
    ),
  ]),
);
