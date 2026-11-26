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
    test: {
      ...config.test,
      // The linked builder derives screen trees from multiple source files.
      // Vitest can reuse a transform after those files or the builder change.
      fsModuleCache: false,
      // Use the same browser build of Solid in UI SDK and the window tests.
      server: { deps: { inline: [/@ui-sdk\//] } },
    },
  };
}
