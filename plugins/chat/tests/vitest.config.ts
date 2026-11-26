import { windowTestConfig } from "../../../scripts/window-test-config.ts";
import { defineConfig } from "vitest/config";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const chat = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const probeModule = "\0chat-probe";

/**
 * Builds the test plugin in tests/fixtures/chat-probe with the real plugin
 * build. The build finds `plugin:chat/client` beside the plugin, so the copy
 * sits next to a link to this chat folder. Both live in the ignored
 * .tokamak directory, outside chat's source.
 */
function buildProbe() {
  const root = resolve(chat, ".tokamak/chat-probe");
  const probe = join(root, "chat-probe");
  mkdirSync(root, { recursive: true });
  cpSync(join(chat, "tests/fixtures/chat-probe"), probe, { recursive: true, force: true });
  if (!existsSync(join(root, "chat"))) symlinkSync(chat, join(root, "chat"), "dir");
  writeFileSync(
    join(probe, "tsconfig.json"),
    JSON.stringify({ extends: "@tokamak/sdk/tsconfig.window.json", include: ["src"] }),
  );
  const builder = resolve(dirname(require.resolve("@tokamak/build/vite")), "build.ts");
  // Prefer the Bun already running this config; it is the pinned one under proto.
  execFileSync(process.versions.bun ? process.execPath : "bun", [builder, probe]);
  return probe;
}

export default defineConfig(
  windowTestConfig(
    chat,
    "chat",
    {
      "@tokamak/runtime/router": require.resolve("@tokamak/runtime/router"),
      "@plugins/chat/ui": resolve(chat, "src/client/api.ts"),
    },
    [
      {
        name: "chat-probe",
        resolveId: (id) => (id === "virtual:chat-probe" ? probeModule : undefined),
        load(id) {
          if (id !== probeModule) return;
          const probe = buildProbe();
          return `
          export { default as manifest } from ${JSON.stringify(join(probe, "dist/manifest.json"))};
          export const loadActions = () => import(${JSON.stringify(join(probe, "dist/ui.js"))});
        `;
        },
      },
    ],
  ),
);
