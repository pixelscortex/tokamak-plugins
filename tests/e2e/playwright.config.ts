import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { tokamakDir, workspace } from "../support/paths.mjs";
import { browserPorts } from "./ports";

const bun = process.env.TOKAMAK_E2E_BUN;
if (!bun) throw new Error("Run Playwright through bun run test:e2e");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const url = (port: number) => `http://127.0.0.1:${port}`;
const appURL = url(browserPorts.preview);
const results = join(workspace, ".ci-results");

function server(file: string) {
  return {
    cwd: tokamakDir,
    command: `${quote(bun!)} ${quote(join(workspace, "tests/e2e", file))}`,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 } as const,
    reuseExistingServer: false,
  };
}

function preview(port: number) {
  return {
    cwd: tokamakDir,
    command: `${quote(bun!)} run --cwd app vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: url(port),
    reuseExistingServer: false,
  };
}

export default defineConfig({
  testDir: "./browser",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: join(results, "playwright"),
  reporter: [["list"], ["html", { outputFolder: join(results, "playwright-report"), open: "never" }]],
  use: { baseURL: appURL, trace: "retain-on-failure", actionTimeout: 15_000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    { ...server("serve.ts"), port: browserPorts.local },
    { ...server("serve-hosted.ts"), url: `${url(browserPorts.hosted)}/health` },
    preview(browserPorts.preview),
    preview(browserPorts.secondPreview),
  ],
});
