import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { TokamakClient, WebSocketTransport } from "@tokamak/sdk";
import type { Addresses } from "../src/server/addresses";
import { addressesVariable } from "../src/server/addresses";

/**
 * A real shared server for the sign-in tests: chat, ai, basic-auth,
 * agent-proxy and ai-profiles built from this checkout, the addresses
 * variable pointing at the fake companies, and `net:127.0.0.1` granted to the
 * installed copy of agent-proxy only (the shipped build has no loopback grant).
 */

const execute = promisify(execFile);

/** Removes a scratch folder file by file (no recursive delete in these tests). */
async function empty(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await empty(path);
    else await unlink(path);
  }
  await rmdir(directory);
}
const scratch = process.env.TOKAMAK_TEST_TEMP!;
// Owners before the plugins that depend on them, so each build reads their references.
const plugins = ["chat", "ai", "basic-auth", "agent-proxy", "ai-profiles"];

export interface Build {
  readonly name: string;
  readonly server: string;
  readonly host: string;
}

/** The two builds a person can run: the Runner's server and the cloud Server. */
export function builds(): Build[] {
  return [
    { name: "Runner build", server: process.env.TOKAMAK_TEST_SERVER_BIN!, host: process.env.TOKAMAK_TEST_PLUGIN_HOST! },
    { name: "Server build", server: process.env.TOKAMAK_TEST_CLOUD_SERVER_BIN!, host: process.env.TOKAMAK_TEST_CLOUD_PLUGIN_HOST! },
  ].filter((build) => build.server && build.host && existsSync(build.server) && existsSync(build.host));
}

async function post(http: string, path: string, key: string | undefined, body: unknown) {
  const response = await fetch(new URL(path, http), {
    method: "POST",
    headers: { ...(key && { authorization: `Bearer ${key}` }), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export interface Workspace {
  /** Everything the server and its plugin host wrote to stdout and stderr. */
  readonly output: () => string;
  /** A new window of the owner: a fresh connection, as after closing and reopening. */
  owner(): Promise<TokamakClient>;
  /** A window of another member of the same server. */
  member(name: string): Promise<TokamakClient>;
  /** Stops the server and starts it again on the same data; earlier windows are closed. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A change to the installed copy of a plugin's server code (agent-proxy's
 * unless `plugin` names another): `find` is replaced by `replace`.
 */
export interface Patch {
  readonly plugin?: string;
  readonly find: string;
  readonly replace: string;
}

/** The caller is installed only for proxy tests; the shipped API stays plugin-only. */
async function installTurnCaller(installation: string) {
  const plugins = join(installation, "plugins");
  const source = join(plugins, "turn-caller");
  const sdkModules = join(scratch, "sources/agent-proxy/node_modules");
  await mkdir(join(source, "src/server"), { recursive: true });
  await symlink(sdkModules, join(source, "node_modules"), "dir");
  const proxy = join(plugins, "agent-proxy");
  await symlink(sdkModules, join(proxy, "node_modules"), "dir");
  await symlink(join(scratch, "sources/agent-proxy/src"), join(proxy, "src"), "dir");
  await writeFile(join(source, "package.json"), '{"name":"turn-caller","type":"module"}');
  await writeFile(
    join(source, "plugin.ts"),
    'import { definePlugin } from "@tokamak/sdk"; export default definePlugin({ id: "turn-caller", version: "0.0.1", depends: ["agent-proxy"] });',
  );
  await writeFile(
    join(source, "src/server/turns.ts"),
    `
import { action, mutation, v } from "@tokamak/sdk";
import { api as proxy } from "plugin:agent-proxy/server";
export const register = mutation({
  args: { set: v.optional(v.string()), subscriptions: v.array(v.string()) },
  handler: (ctx, args) => ctx.use(proxy).registerSet(args),
});
export const remove = mutation({
  args: { set: v.string() },
  handler: (ctx, args) => ctx.use(proxy).removeSet(args),
});
export const key = action({
  args: { set: v.string(), company: v.optional(v.union(v.literal("anthropic"), v.literal("openai"))) },
  handler: (ctx, args) => ctx.use(proxy).turnKey(args),
});
export const end = mutation({
  args: { key: v.string() },
  handler: (ctx, args) => ctx.use(proxy).endTurnKey(args),
});
`,
  );
  await execute(process.env.TOKAMAK_TEST_BUN!, [join(sdkModules, "@tokamak/build/src/build.ts"), source],
    { timeout: 120_000 });
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!address || typeof address === "string") throw new Error("No test port");
  return address.port;
}

/**
 * `signInTtlMs` builds the installed copy with a shorter sign-in lifetime, so a
 * test can watch a sign-in expire without waiting 15 minutes: the server's own
 * clock is the one sign-ins are measured by, and a test cannot move it.
 * `patches` change the installed copy in other ways a test needs.
 */
export async function startWorkspace(
  build: Build,
  addresses: Addresses,
  {
    signInTtlMs,
    patches = [],
    turnCaller = false,
  }: { signInTtlMs?: number; patches?: readonly Patch[]; turnCaller?: boolean } = {},
): Promise<Workspace> {
  const installation = await mkdtemp(join(scratch, "agent-proxy-sign-in-"));
  for (const id of plugins)
    await cp(join(scratch, "sources", id, "dist"), join(installation, "plugins", id, "dist"), {
      recursive: true,
    });
  const manifestPath = join(installation, "plugins/agent-proxy/dist/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.plugin.permissions.push("net:127.0.0.1");
  if (signInTtlMs !== undefined)
    for (const file of ["bundle.js", "transactions.js"]) {
      const path = join(installation, "plugins/agent-proxy/dist", file);
      const code = await readFile(path, "utf8");
      const patched = code.replace("SIGN_IN_TTL_MS = 900000", `SIGN_IN_TTL_MS = ${signInTtlMs}`);
      if (patched === code) throw new Error(`No sign-in lifetime to shorten in ${file}`);
      await writeFile(path, patched);
      manifest.hashes[file] = createHash("sha256").update(patched).digest("hex");
    }
  for (const id of new Set(patches.map((patch) => patch.plugin ?? "agent-proxy"))) {
    const dist = join(installation, "plugins", id, "dist");
    const own =
      id === "agent-proxy" ? manifest : JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
    for (const file of ["bundle.js", "transactions.js"]) {
      const path = join(dist, file);
      let code = await readFile(path, "utf8");
      for (const { find, replace } of patches.filter((patch) => (patch.plugin ?? "agent-proxy") === id)) {
        if (!code.includes(find)) throw new Error(`Nothing to patch in ${id}/${file}: ${find}`);
        code = code.replace(find, replace);
      }
      await writeFile(path, code);
      own.hashes[file] = createHash("sha256").update(code).digest("hex");
    }
    if (own !== manifest) await writeFile(join(dist, "manifest.json"), JSON.stringify(own));
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(installation, ".env.local"), `${addressesVariable}='${JSON.stringify(addresses)}'\n`);
  await mkdir(join(installation, "web"));
  await writeFile(join(installation, "web/index.html"), "Sign-in tests");

  let port = 0;
  try {
    if (turnCaller) {
      await installTurnCaller(installation);
      port = await freePort();
    }
  } catch (error) {
    await empty(installation);
    throw error;
  }
  const ownerToken = "sign-in-tests-owner-token-of-at-least-32-characters";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOKAMAK_PLUGIN_HOST: build.host,
    TOKAMAK_OWNER_NAME: "Sam",
    TOKAMAK_ACCESS_TOKEN: ownerToken,
    ...(turnCaller && { TOKAMAK_PUBLIC_URL: `http://127.0.0.1:${port}` }),
  };
  delete env[addressesVariable];
  let output = "";
  /** Starts the server on the installation's plugins and data; `ready` is its WebSocket address. */
  const launch = () => {
    const child = spawn(
      build.server,
      ["--plugins", join(installation, "plugins"), "--data", join(installation, "store")].concat([
        "--listen",
        `127.0.0.1:${port}`,
        "--web",
        join(installation, "web"),
      ]),
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr.on("data", (chunk) => (output += chunk));
    const lines = createInterface({ input: child.stdout });
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    const ready = new Promise<string>((done, reject) => {
      lines.on("line", (line) => {
        output += line + "\n";
        const url = line.match(/ws:\/\/127\.0\.0\.1:\d+\/ws/)?.[0];
        if (url) done(url);
      });
      child.once("error", reject);
      void closed.then(() => reject(new Error(`Server exited before readiness:\n${output}`)));
    });
    return { child, lines, closed, ready };
  };
  let server = launch();
  const sockets: WebSocket[] = [];
  const halt = async (signal: NodeJS.Signals) => {
    for (const socket of sockets.splice(0)) socket.close();
    server.lines.close();
    server.child.kill(signal);
    await server.closed;
  };
  const stop = async () => {
    await halt("SIGKILL");
    await empty(installation);
  };
  try {
    let ws = await server.ready;
    let http = ws.replace(/^ws:/, "http:");
    const connect = async (key: string) => {
      const socket = new WebSocket(ws, ["tokamak", `tokamak.bearer.${encodeURIComponent(key)}`]);
      sockets.push(socket);
      await new Promise<void>((done, reject) => {
        socket.addEventListener("open", () => done(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open")), { once: true });
      });
      return new TokamakClient(new WebSocketTransport(socket));
    };
    const ownerKey = async () => {
      const device = await post(http, "/auth/owner", ownerToken, { deviceName: "Test window" });
      return device.body.key as string;
    };
    return {
      output: () => output,
      owner: async () => connect(await ownerKey()),
      async member(name) {
        const method = "basic-auth";
        const password = "temporary member password";
        await post(http, "/members", ownerToken, {
          method,
          fields: { username: name, email: `${name}@example.com`, password },
        });
        const signIn = { method, deviceName: "Test device", fields: { usernameOrEmail: name, password } };
        const device = await post(http, "/auth/sign-in", undefined, {
          ...signIn,
          newPassword: "a password of their own",
        });
        if (typeof device.body.key !== "string") throw new Error(`Member sign-in failed: ${device.status}`);
        return connect(device.body.key);
      },
      async restart() {
        await halt("SIGTERM");
        server = launch();
        ws = await server.ready;
        http = ws.replace(/^ws:/, "http:");
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
