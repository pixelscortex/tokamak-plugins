import { defineConfig } from "vitest/config";

export const proxyFiles = [
  "addresses", "chatgpt-sign-in", "manage-companies", "manage", "sign-in", "proxy", "cli",
].map((name) => `plugins/agent-proxy/tests/${name}.test.ts`);

export default defineConfig({
  test: {
    include: [...proxyFiles, "plugins/ai-profiles/tests/profiles-server.test.ts"],
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
