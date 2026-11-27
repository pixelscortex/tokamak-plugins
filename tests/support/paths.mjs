import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = fileURLToPath(new URL("../../", import.meta.url));
export const tokamakDir = resolve(workspace, process.env.TOKAMAK_DIR || "../tokamak");
export const testTemp = process.env.TOKAMAK_TEST_TEMP || realpathSync(tmpdir());
export const testModules = join(workspace, "node_modules");
export const testBuilder = join(testModules, "@tokamak/build/src/build.ts");
export const testServerConfig = join(testModules, "@tokamak/sdk/tsconfig.plugin-server.json");
export const testWindowConfig = join(testModules, "@tokamak/sdk/tsconfig.plugin-window.json");

export function isRunner(binary) {
  return (process.env.TOKAMAK_TEST_RUNNER_BIN && binary === process.env.TOKAMAK_TEST_RUNNER_BIN) ||
    basename(binary).startsWith("tokamak-runner");
}
