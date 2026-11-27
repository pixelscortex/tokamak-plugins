import { spawn } from "node:child_process";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

export async function empty(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await empty(path);
    else await unlink(path);
  }
  await rmdir(dir);
}

export function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function blockingProxy() {
  const attempts: string[] = [];
  const proxy = createServer((request, response) => {
    attempts.push(new URL(request.url ?? "/", `http://${request.headers.host ?? "unknown"}`).host);
    response.writeHead(403).end();
  });
  proxy.on("connect", (request, socket) => {
    attempts.push(request.url ?? "unknown");
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Blocking listener has no port");
  return {
    attempts,
    url: `http://127.0.0.1:${address.port}`,
    stop: () => {
      proxy.close();
      proxy.closeAllConnections();
    },
  };
}

export function cliEnvironment(home: string, blocked: string) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_DATA_HOME: home,
    XDG_STATE_HOME: home,
    HTTP_PROXY: blocked,
    HTTPS_PROXY: blocked,
    ALL_PROXY: blocked,
    NO_PROXY: "127.0.0.1,localhost",
    http_proxy: blocked,
    https_proxy: blocked,
    all_proxy: blocked,
    no_proxy: "127.0.0.1,localhost",
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}
