import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { windowTestConfig as tokamakWindowTestConfig } from "@tokamak/build/window-test-config";

export function windowTestConfig(...args: Parameters<typeof tokamakWindowTestConfig>) {
  const repo = resolve(args[0], "../..");
  const config = tokamakWindowTestConfig(...args);
  // Vite checks real paths when serving linked packages to the test runner.
  const sdk = realpathSync(resolve(repo, "node_modules/@tokamak/sdk"));
  return {
    ...config,
    server: { fs: { allow: [repo, resolve(sdk, "../..")] } },
    // Use the same browser build of Solid in UI SDK and the window tests.
    test: { ...config.test, server: { deps: { inline: [/@ui-sdk\//] } } },
  };
}
