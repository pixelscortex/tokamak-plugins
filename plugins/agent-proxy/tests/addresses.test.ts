import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { createApi, TokamakClient, WebSocketTransport, type FunctionReference } from "@tokamak/sdk";
import { expect, test } from "vitest";
import { addressesVariable, companyAddresses } from "../src/server/addresses";
import { startFakeCompanies } from "./fake-companies";

const execute = promisify(execFile);
const plugin = resolve(import.meta.dirname, "..");
const root = resolve(plugin, "../..");

export async function empty(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await empty(path);
    else await unlink(path);
  }
  await rmdir(directory);
}

test("the server addresses default to the real providers and reject malformed overrides", async () => {
  expect(await companyAddresses({ env: async () => null })).toEqual({
    anthropic: {
      api: "https://api.anthropic.com",
      authorize: "https://claude.ai/oauth/authorize",
      token: "https://platform.claude.com/v1/oauth/token",
    },
    openai: {
      api: "https://chatgpt.com/backend-api",
      authorize: "https://auth.openai.com/oauth/authorize",
      token: "https://auth.openai.com/oauth/token",
    },
  });
  for (const value of ["", "{}", "[]", "null", '{"openai":null}']) {
    await expect(companyAddresses({ env: async () => value })).rejects.toThrow(
      `Invalid ${addressesVariable}`,
    );
  }
});

// Only this disposable source copy exports a probe or grants loopback access.
async function installProbe(installation: string, addresses: unknown) {
  const source = join(installation, "plugins", "agent-proxy");
  await mkdir(join(source, "src", "server"), { recursive: true });
  await symlink(join(root, "node_modules"), join(source, "node_modules"), "dir");
  await cp(join(plugin, "src/server/addresses.ts"), join(source, "src/server/addresses.ts"));
  await cp(join(plugin, "package.json"), join(source, "package.json"));
  await cp(join(plugin, "plugin.ts"), join(source, "plugin.ts"));
  await writeFile(
    join(source, "src/server/probe.ts"),
    `
import { action, internalAction } from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";
import { companyAddresses } from "./addresses";
import { internal } from "./_generated/internal";
export const provider = internalAction({
  handler: async (ctx) => {
    const { anthropic } = await companyAddresses(ctx);
    const response = await fetch(anthropic.api + "/v1/models", { headers: { "x-api-key": "fake-probe-access" } });
    return response.status;
  },
});
export const probe = action({ handler: (ctx) => ctx.runAction(internal.probe.provider, {}) });
`,
  );
  await writeFile(join(source, "src/server/api.ts"), 'export { probe } from "./probe";\n');
  await execute(process.env.TOKAMAK_TEST_BUN!, [join(root, "node_modules/@tokamak/build/src/build.ts"), source], {
    cwd: root,
    timeout: 35_000,
  });
  const manifestPath = join(source, "dist", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.plugin.permissions.push("net:127.0.0.1");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(installation, ".env.local"), `${addressesVariable}='${JSON.stringify(addresses)}'\n`);
}

test(
  "a real test server reads the installation override and fetches the fake from an action",
  { timeout: 65_000 },
  async (context) => {
    const binary = process.env.TOKAMAK_TEST_SERVER_BIN;
    const host = process.env.TOKAMAK_TEST_PLUGIN_HOST;
    if (!binary || !host || !existsSync(binary) || !existsSync(host)) {
      const reason =
        "Native fixture binaries unavailable; build server and tokamak-plugin-host to run this test";
      console.log(`Skipping: ${reason}`);
      context.skip(reason);
      return;
    }
    const installation = await mkdtemp(join(process.env.TOKAMAK_TEST_TEMP!, "agent-proxy-install-"));
    const fake = await startFakeCompanies();
    try {
      fake.addAccount("anthropic", "probe");
      await installProbe(installation, fake.addresses);
      const env: NodeJS.ProcessEnv = { ...process.env, TOKAMAK_PLUGIN_HOST: host };
      delete env[addressesVariable];
      const child = spawn(
        binary,
        [
          "--plugins",
          join(installation, "plugins"),
          "--data",
          join(installation, "store"),
          "--listen",
          "127.0.0.1:0",
        ],
        {
          env,
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      const lines = createInterface({ input: child.stdout });
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      try {
        const ws = await new Promise<string>((done, reject) => {
          lines.on("line", (line) => {
            const url = line.match(/ws:\/\/127\.0\.0\.1:\d+\/ws/)?.[0];
            if (url) done(url);
          });
          child.once("error", reject);
          void closed.then(() => reject(new Error("Server exited before readiness")));
        });
        const socket = new WebSocket(ws);
        try {
          await new Promise<void>((done, reject) => {
            socket.addEventListener("open", () => done(), { once: true });
            socket.addEventListener("error", () => reject(new Error("Test server WebSocket did not open")), {
              once: true,
            });
          });
          const client = new TokamakClient(new WebSocketTransport(socket));
          const api = createApi<{
            probe: { probe: FunctionReference<"action", Record<string, never>, number> };
          }>("agent-proxy", ["probe:probe"]);
          expect(await client.action(api.probe.probe, {})).toBe(200);
          expect(fake.requests[0]).toMatchObject({ path: "/anthropic/v1/models", account: "probe" });
        } finally {
          socket.close();
        }
      } finally {
        lines.close();
        child.kill("SIGKILL");
        await closed;
      }
    } finally {
      await fake.stop();
      await empty(installation);
    }
  },
);
